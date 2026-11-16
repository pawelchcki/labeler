import test from 'node:test';
import assert from 'node:assert/strict';
import { firmwareFrame, parseFirmwareFrame, firmwareChecksum, inspectFirmware, checkFirmware, downloadFirmware, flashFirmware, firmwareMetadataURL, FLASH_START } from '../web/firmware.mjs';
import { toHex } from '../web/bluetooth.mjs';

// Synthetic image: never a flashable vendor image; no real device is accessed.
function image(model = 'D11s') {
  const bytes = new Uint8Array(1027); bytes.set(new TextEncoder().encode(model), 500);
  const view = new DataView(bytes.buffer);
  for (let i = 0x100; i < 0x13c; i += 4) view.setUint32(i, FLASH_START + 0x201, true);
  return bytes;
}
function mock({ rejectType = -1, corruptChecksum = false, battery = 85, challengeMismatch = false, disconnect = false } = {}) {
  const commands = [], uploaded = [], writes = [];
  const transport = { occupied: false, connected: true, verified: true, identity: { model: 'D11s', battery },
    stats: {}, fault: '', discarding: false, raw: false, updating: false,
    async readDiagnostics() {}, emitHealth() {}, record() {},
    engine(request) { assert.equal(request.raster, '00'); return { busy: false }; },
    async write(bytes) { writes.push(bytes.slice()); },
    async query(bytes) {
      if (toHex(bytes) === '10ff40') return Uint8Array.from([0]);
      if (bytes[0] === 0x10) {
        const hi = bytes[3] >> 4, lo = bytes[3] & 15;
        return Uint8Array.from([challengeMismatch ? ((((hi | lo) << 4) | (hi & lo)) ^ 255) : ((hi | lo) << 4) | (hi & lo)]);
      }
      const type = bytes[6], payload = parseFirmwareFrame(bytes, type); commands.push(type);
      if (type === 4) { if (disconnect) throw new Error('Disconnected during flash'); uploaded.push(payload.slice(7)); }
      let response = new Uint8Array();
      if (type === 6) {
        response = new Uint8Array(5);
        new DataView(response.buffer).setUint32(1, firmwareChecksum(image()) + (corruptChecksum ? 1 : 0));
      }
      return firmwareFrame(type === rejectType ? 0xee : type, response);
    }, disconnect() { this.connected = false; } };
  return { transport, commands, uploaded, writes };
}

test('SDK frame matches literal empty handshake; rejects malformed lengths, checksum and types', () => {
  assert.equal(toHex(firmwareFrame(2)), '1b100006000002000000000033');
  assert.deepEqual(parseFirmwareFrame(firmwareFrame(4, Uint8Array.from([0, 1, 255])), 4), Uint8Array.from([0, 1, 255]));
  const corrupt = firmwareFrame(2); corrupt[12]++;
  assert.throws(() => parseFirmwareFrame(corrupt, 2), /checksum/);
  assert.throws(() => parseFirmwareFrame(firmwareFrame(3), 2), /rejected/);
  assert.throws(() => parseFirmwareFrame(firmwareFrame(2).slice(1), 2), /header/);
});
test('File screening rejects D11 Pro, unknown, archive and oversized inputs', async () => {
  assert.equal((await inspectFirmware(image())).eligible, true);
  assert.equal((await inspectFirmware(image('D11 Pro'))).eligible, false);
  assert.equal((await inspectFirmware(image('Unknown'))).eligible, false);
  await assert.rejects(inspectFirmware(new Uint8Array(100)), /raw/);
  await assert.rejects(inspectFirmware(new Uint8Array(262145)), /raw/);
  const info = await inspectFirmware(image()); assert.match(info.sha256, /^[a-f0-9]{64}$/);
});
test('Firmware tools use explicit identity and handle absent metadata, CORS failure and bounded downloads', async () => {
  assert.throws(() => firmwareMetadataURL({ model: 'D12' }), /health/);
  const identity = { model: 'D11s', serial: 'test&serial', version: '2.4.6' };
  assert.equal(new URL(firmwareMetadataURL(identity, 'FICHERO_5836')).searchParams.get('sn'), 'test&serial');
  assert.equal(await checkFirmware(identity, 'test', async () => new Response(JSON.stringify({ code: 200 }))), null);
  await assert.rejects(checkFirmware(identity, 'test', async () => { throw new TypeError('CORS'); }), /CORS/);
  assert.equal((await checkFirmware(identity, 'test', async () => new Response(JSON.stringify({ data: { media: { files: 'https://vendor.example/fw.bin' }, version: '3' } })))).version, '3');
  await assert.rejects(downloadFirmware('http://vendor.example/fw.bin'), /HTTPS/);
  await assert.rejects(downloadFirmware('https://vendor.example/fw.bin', async () => new Response(new Uint8Array(262145))), /exceeds/);
});
test('Synthetic bootloader accepts exact blocks and checksum before restart; connection requires reverification', async () => {
  const { transport, commands, uploaded, writes } = mock(); let progress = 0;
  await flashFirmware(transport, image(), { confirmed: true, wait: async () => {}, onProgress(sent) { progress = sent; } });
  assert.deepEqual(commands, [2, 2, 3, 4, 4, 4, 4, 4, 6, 2]);
  assert.deepEqual(Uint8Array.from(uploaded.flatMap(b => [...b])), image());
  assert.equal(progress, 1027);
  assert.equal(toHex(writes[0]), '10ffe0aaaa');
  assert.equal(writes.at(-1)[6], 7);
  assert.equal(transport.connected, false);
});
for (const settings of [{ challengeMismatch: true }, { rejectType: 2 }, { rejectType: 3 }, { rejectType: 4 }, { corruptChecksum: true }, { disconnect: true }]) {
  test(`Firmware failure stops without retries or restart: ${JSON.stringify(settings)}`, async () => {
    const { transport, commands, writes } = mock(settings);
    await assert.rejects(flashFirmware(transport, image(), { confirmed: true, wait: async () => {} }));
    assert.equal(writes.some(b => b[0] === 0x1b && b[6] === 7), false);
    assert.ok(commands.filter(type => type === 3).length <= 1);
    if (settings.rejectType === 2 || settings.challengeMismatch) assert.equal(commands.includes(3), false, 'No erase before a valid handshake');
    if (settings.rejectType === 4) assert.equal(commands.filter(type => type === 4).length, 1);
    assert.equal(transport.connected, false);
  });
}
test('Firmware gates prevent bootloader entry without confirmation, sufficient battery or model match', async () => {
  for (const settings of [{ battery: 12 }, { wrong: true }, { unconfirmed: true }]) {
    const { transport, writes } = mock(settings);
    await assert.rejects(flashFirmware(transport, image(settings.wrong ? 'D11 Pro' : 'D11s'), { confirmed: !settings.unconfirmed, wait: async () => {} }));
    assert.equal(writes.length, 0);
  }
});
