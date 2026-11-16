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
  const emit = hex => {
    for (const byte of bytesFromHex(hex)) {
      const backing = Uint8Array.from([0xcc, 0xcc, byte, 0xcc]);
      notifier.value = new DataView(backing.buffer, 2, 1);
      notices.get('characteristicvaluechanged')?.({ target: notifier });
    }
  };
  let injected = false;
  const writer = {
    properties: { writeWithoutResponse: true },
    async writeValueWithoutResponse(bytes) {
      assert.ok(bytes.length <= 200, 'Every BLE write must fit the tested 200-byte cap');
      writes.push(bytes.slice());
      if (settings.disconnectRaster && bytes[0] === 0x1d && bytes[1] === 0x76) {
        device.gatt.disconnect();
        throw new Error('Simulated link loss during raster');
      }
      if (settings.stallRaster && bytes[0] === 0x1d && bytes[1] === 0x76) return new Promise(() => {});
      if (settings.slowRaster && !injected && bytes[0] === 0x1d && bytes[1] === 0x76) await new Promise(resolve => setTimeout(resolve, 110));
      const reply = await emulator.call({ feed: toHex(bytes) });
      assert.equal(reply.ok, true, reply.error);
      for (const response of reply.value.replies) emit(toHex(bytes) === '10ff20f0' && settings.model ? toHex(new TextEncoder().encode(settings.model)) : response);
      if (!injected && bytes[0] === 0x1d && bytes[1] === 0x76) {
        injected = true;
        if (settings.rasterReport) emit(settings.rasterReport);
      }
      if (toHex(bytes) === '10fffe45' && settings.completionReport) emit(settings.completionReport);
    },
  };
  let chooserCalled = false;
  const transport = new D11sTransport({
    engine: request => engine.dispatch(request),
    bluetooth: { requestDevice(options) {
      chooserCalled = true;
      assert.ok(options.optionalServices.includes(SERVICE_UUID));
      assert.ok(options.filters.some(filter => filter.namePrefix === 'FICHERO_5836'));
      return Promise.resolve(device);
    } },
    timing: { chunk: 0, fragments: 1, reply: 80, complete: 40, poll: 0, busy: 200, write: settings.stallRaster ? 10 : 5000 },
  });
  const connecting = transport.connect();
  assert.equal(chooserCalled, true, 'The chooser must run synchronously within the user gesture');
  if (settings.model && settings.model !== 'D11s') { await assert.rejects(connecting, /Unsupported printer model/); return { transport, emulator, writes, emit }; }
  await connecting;
  t.after(() => transport.disconnect());
  return { transport, emulator, writes, emit };
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

for (const report of ['ff01', 'ff02', 'ff04', 'ff08', 'ff1001000000']) {
  test(`Split asynchronous report ${report} stops the current raster and later copies`, async t => {
    const { transport, writes } = await fixture(t, { rasterReport: report });
    let starts = 0;
    await assert.rejects(transport.execute(protocol({ text: 'x', copies: 2 }).steps, request => engine.dispatch(request), { onStarted() { starts++; } }));
    assert.equal(starts, 1);
    assert.equal(writes.filter(b => b[0] === 0x1d && b[1] === 0x76).length, 1);
    assert.equal(transport.health().faults + transport.health().discardReports, 1);
    assert.equal(writes.some(b => toHex(b) === '1d0c'), false, 'Do not send positioning after a reported fault');
  });
}

test('Completion immediately followed by a fault cannot hide the fault or start copy two', async t => {
  const { transport } = await fixture(t, { completionReport: 'ff04' });
  let starts = 0;
  await assert.rejects(transport.execute(protocol({ text: 'x', copies: 2 }).steps, request => engine.dispatch(request), { onStarted() { starts++; } }), /label roll/);
  assert.equal(starts, 1);
});

test('Low battery blocks raster transmission', async t => {
  const { transport, writes } = await fixture(t, { fault: 8 });
  await assert.rejects(transport.execute(protocol({ text: 'x' }).steps), /Charge/);
  assert.equal(writes.some(b => b[0] === 0x1d), false);
});

test('Model is verified over the wire rather than trusted from the Bluetooth name', async t => {
  const { transport, writes } = await fixture(t, { model: 'D12' });
  assert.equal(transport.connected, false);
  assert.equal(transport.verified, false);
  assert.equal(writes.length, 1);
});

test('Idle reports are retained and a zero discard report clears the latch', async t => {
  const { transport, emit } = await fixture(t);
  emit('ff1001000000'); await transport.incoming;
  assert.equal(transport.discarding, true);
  await assert.rejects(transport.execute(protocol({ text: 'x' }).steps), /discarding/);
  emit('ff1000000000'); emit('ff00'); await transport.incoming;
  assert.equal(transport.discarding, false);
  await transport.execute(protocol({ text: 'x' }).steps);
});

test('A stalled write fails once, never retries, and records the timeout', async t => {
  const { transport, writes } = await fixture(t, { stallRaster: true });
  await assert.rejects(transport.execute(protocol({ text: 'x', copies: 2 }).steps), /stalled/);
  assert.equal(transport.health().timeouts, 1);
  assert.equal(writes.filter(b => b[0] === 0x1d && b[1] === 0x76).length, 1);
});

test('Slow writes reduce pacing; diagnostics report host bytes and never log label data', async t => {
  const { transport } = await fixture(t, { slowRaster: true });
  await transport.execute(protocol({ text: 'SECRET LABEL' }).steps);
  const health = transport.health();
  assert.ok(health.writeMaxMs >= 100);
  assert.ok(health.delayMs >= 10);
  assert.ok(health.bytesPerSecond > 0);
  assert.ok(health.txPackets > 10 && health.rxPackets > 0);
  assert.equal(JSON.stringify(transport.exportDiagnostics()).includes('SECRET LABEL'), false);
  assert.equal(transport.log.some(event => event.command?.startsWith('1d7630')), false);
  await transport.readDiagnostics();
  assert.equal(transport.identity.battery, 85);
  assert.equal(transport.identity.model, 'D11s');
});

test('Health probes and pacing changes cannot interleave with a print', async t => {
  const { transport } = await fixture(t);
  const print = transport.execute(protocol({ text: 'x' }).steps);
  await assert.rejects(transport.readDiagnostics(), /idle/);
  assert.throws(() => transport.setPacing(true), /idle/);
  await print;
});
