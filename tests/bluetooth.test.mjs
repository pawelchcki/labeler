import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEngine } from '../web/engine.mjs';
import { D11sTransport, SERVICE_UUID, WRITE_UUID, toHex, bytesFromHex } from '../web/bluetooth.mjs';
import { PrintGuard } from '../web/jobs.mjs';
import { RustProcess } from './helpers.mjs';

const engine = await createEngine(await readFile(new URL('../web/pkg/labeler.wasm', import.meta.url)));

async function fixture(t, settings = {}) {
  const emulator = new RustProcess('device_emulator');
  t.after(() => emulator.close());
  await emulator.call(settings);
  const listeners = new Map(), notices = new Map(), writes = [];
  const device = {
    name: 'FICHERO_TEST_BLE',
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    gatt: {
      connected: false,
      async connect() { this.connected = true; return this; },
      disconnect() { this.connected = false; listeners.get('gattserverdisconnected')?.(); },
      async getPrimaryService(uuid) {
        assert.equal(uuid, SERVICE_UUID);
        return { async getCharacteristic(uuid) { return uuid === WRITE_UUID ? writer : notifier; } };
      },
    },
  };
  const notifier = {
    value: null,
    addEventListener(type, fn) { notices.set(type, fn); },
    removeEventListener(type) { notices.delete(type); },
    async startNotifications() {},
  };
  const writer = {
    properties: { writeWithoutResponse: true },
    async writeValueWithoutResponse(bytes) {
      assert.ok(bytes.length <= 200, 'Every BLE write must fit the tested 200-byte cap');
      writes.push(bytes.slice());
      if (settings.disconnectRaster && bytes[0] === 0x1d && bytes[1] === 0x76) {
        device.gatt.disconnect();
        throw new Error('Simulated link loss during raster');
      }
      const reply = await emulator.call({ feed: toHex(bytes) });
      assert.equal(reply.ok, true, reply.error);
      // Deliver split replies before the write promise resolves, using offset DataViews.
      for (const response of reply.value.replies) for (const byte of bytesFromHex(response)) {
        const backing = Uint8Array.from([0xcc, 0xcc, byte, 0xcc]);
        notifier.value = new DataView(backing.buffer, 2, 1);
        notices.get('characteristicvaluechanged')?.({ target: notifier });
      }
    },
  };
  let chooserCalled = false;
  const transport = new D11sTransport({
    bluetooth: { requestDevice(options) {
      chooserCalled = true;
      assert.ok(options.optionalServices.includes(SERVICE_UUID));
      assert.ok(options.filters.some(filter => filter.namePrefix === 'FICHERO'));
      return Promise.resolve(device);
    } },
    timing: { chunk: 0, fragments: 1, reply: 80, complete: 40, poll: 0, busy: 200 },
  });
  const connecting = transport.connect();
  assert.equal(chooserCalled, true, 'The chooser must run synchronously within the user gesture');
  await connecting;
  t.after(() => transport.disconnect());
  return { transport, emulator, writes };
}

function protocol(request, density = 2) {
  const plan = engine.dispatch(request);
  const steps = engine.dispatch({ op: 'protocol', raster: plan.raster, rows: plan.rows, copies: request.copies || 1, density }).steps;
  return { plan, steps: steps.map(step => ({ ...step, delay: 0 })) };
}

for (const request of [{ text: 'garaż 1' }, { text: 'USB-C', mode: 'wrap', cable: 'usb-c', copies: 2 }]) {
  test(`Browser transport prints exact Rust raster through independent emulator: ${request.text}`, async t => {
    const { transport, emulator, writes } = await fixture(t, { busy_polls: 2, busy_after_stop: 1 });
    const { plan, steps } = protocol(request);
    let starts = 0, completeTransfers = 0;
    await transport.execute(steps, request => engine.dispatch(request), {
      onStarted: () => starts++,
      onProgress: (sent, total) => { if (sent === total) completeTransfers++; },
    });
    const snapshot = (await emulator.call({ snapshot: true })).value;
    assert.equal(snapshot.feeds, request.copies || 1);
    assert.equal(snapshot.buffered, 0);
    assert.equal(snapshot.enabled, false);
    assert.equal(starts, request.copies || 1);
    assert.equal(completeTransfers, starts);
    assert.ok(writes.some(bytes => bytes.length === 200));
    for (const page of snapshot.pages) {
      assert.equal(page.raster, plan.raster);
      assert.equal(page.rows, plan.rows);
      assert.equal(page.density, 2);
      assert.equal(page.paper, 0);
    }
  });
}

test('Paper faults and rejected settings stop before raster transmission', async t => {
  for (const settings of [{ fault: 4 }, { reject_density: true }]) {
    await t.test(JSON.stringify(settings), async t => {
      const { transport, emulator } = await fixture(t, settings);
      let started = false;
      await assert.rejects(transport.execute(protocol({ text: 'x' }).steps, request => engine.dispatch(request), { onStarted: () => { started = true; } }));
      assert.equal(started, false);
      const snapshot = (await emulator.call({ snapshot: true })).value;
      assert.equal(snapshot.feeds, 0);
      assert.equal(snapshot.commands.some(command => command.startsWith('1d76')), false);
    });
  }
});

test('Lost completion acknowledgement preserves uncertainty and never sends the next copy', async t => {
  const { transport, emulator } = await fixture(t, { lose_stop_ack: true });
  const storage = new Map();
  const adapter = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const guard = new PrintGuard(adapter);
  await assert.rejects(transport.execute(protocol({ text: 'x', copies: 3 }).steps, request => engine.dispatch(request), { onStarted: () => guard.start() }), /No reply/);
  assert.equal(guard.pending, true);
  assert.equal(new PrintGuard(adapter).pending, true, 'Uncertainty survives a page reload');
  assert.equal((await emulator.call({ snapshot: true })).value.feeds, 1);
  guard.clear();
  assert.equal(guard.pending, false);
});

test('Disconnect during raster stops transmission without retries', async t => {
  const { transport, emulator, writes } = await fixture(t, { disconnectRaster: true });
  let starts = 0;
  await assert.rejects(transport.execute(protocol({ text: 'x', copies: 2 }).steps, request => engine.dispatch(request), { onStarted: () => starts++ }), /Simulated link loss/);
  assert.equal(starts, 1);
  assert.equal(transport.connected, false);
  assert.equal((await emulator.call({ snapshot: true })).value.feeds, 0);
  assert.equal(writes.filter(bytes => bytes[0] === 0x1d && bytes[1] === 0x76).length, 1);
});

test('Concurrent print requests are rejected', async t => {
  const { transport } = await fixture(t);
  const steps = protocol({ text: 'x' }).steps;
  const first = transport.execute(steps, request => engine.dispatch(request));
  await assert.rejects(transport.execute(steps, request => engine.dispatch(request)), /already printing/);
  await first;
});

test('An unavailable persistence store blocks raster transmission', () => {
  const guard = new PrintGuard({ getItem() { return null; }, setItem() { throw new Error('Storage denied'); } });
  assert.throws(() => guard.start(), /Storage denied/);
});
