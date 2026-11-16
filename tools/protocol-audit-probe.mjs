// Diagnostic only: uses the Rust printer emulator and a fake GATT adapter.
// No Bluetooth API or physical printer is accessed. Run after building the
// native examples and web WASM: node tools/protocol-audit-probe.mjs
import { readFile } from 'node:fs/promises';
import { createEngine } from '../web/engine.mjs';
import { D11sTransport, WRITE_UUID, bytesFromHex, toHex } from '../web/bluetooth.mjs';
import { RustProcess } from '../tests/helpers.mjs';

const engine = await createEngine(await readFile(new URL('../web/pkg/labeler.wasm', import.meta.url)));
const results = [];
for (const scenario of ['baseline', 'paper_fault_during_raster', 'discarding_during_raster', 'fault_after_completion_ack', 'low_battery_preflight']) {
  const emulator = new RustProcess('device_emulator');
  const callbacks = new Map();
  const injected = [], completionReplies = [];
  let used = false, rasterStarted = 0, packetsAfterReport = 0;
  const notifier = {
    addEventListener(name, fn) { callbacks.set(name, fn); },
    removeEventListener(name) { callbacks.delete(name); },
    async startNotifications() {},
  };
  function notify(hex) {
    const bytes = bytesFromHex(hex);
    notifier.value = new DataView(bytes.buffer);
    callbacks.get('characteristicvaluechanged')?.({ target: notifier });
  }
  function report(hex) { injected.push(hex); used = true; notify(hex); }
  const writer = {
    properties: { writeWithoutResponse: true },
    async writeValueWithoutResponse(bytes) {
      const hex = toHex(bytes);
      if (used) packetsAfterReport++;
      const reply = await emulator.call({ feed: hex });
      if (!reply.ok) throw new Error(reply.error);
      for (const response of reply.value.replies) notify(response);
      if (!used && hex.startsWith('1d7630')) {
        if (scenario === 'paper_fault_during_raster') report('ff04');
        if (scenario === 'discarding_during_raster') report('ff1001000000');
      }
      if (!used && hex === '10fffe45' && scenario === 'fault_after_completion_ack') report('ff04');
    },
  };
  const device = {
    name: 'FICHERO_5836_AUDIT_ONLY',
    addEventListener() {}, removeEventListener() {},
    gatt: {
      connected: false,
      async connect() { this.connected = true; return this; },
      disconnect() { this.connected = false; },
      async getPrimaryService() { return { async getCharacteristic(uuid) { return uuid === WRITE_UUID ? writer : notifier; } }; },
    },
  };
  const transport = new D11sTransport({ engine: request => engine.dispatch(request), bluetooth: { async requestDevice() { return device; } }, timing: { chunk: 0, fragments: 1, reply: 100, complete: 100 } });
  try {
    if (scenario === 'low_battery_preflight') await emulator.call({ fault: 8 });
    await transport.connect();
    const plan = engine.dispatch({ text: 'AUDIT', copies: 2 });
    const protocol = engine.dispatch({ op: 'protocol', raster: plan.raster, rows: plan.rows, copies: 2 });
    let success = false, error = null;
    try {
      await transport.execute(protocol.steps.map(step => ({ ...step, delay: 0 })), request => {
        if (request.op === 'reply' && request.mode === 'complete') completionReplies.push(request.raster);
        return engine.dispatch(request);
      }, { onStarted() { rasterStarted++; } });
      success = true;
    } catch (e) { error = e.message; }
    const snapshot = (await emulator.call({ snapshot: true })).value;
    results.push({ scenario, injected_notifications: injected, transport_reported_success: success, raster_transfers_started: rasterStarted, packets_after_report: packetsAfterReport, emulator_pages_fed: snapshot.feeds, completion_replies_seen_by_core: completionReplies, error });
  } finally { transport.disconnect(); emulator.close(); }
}
console.log(JSON.stringify({
  scope: 'Client notification handling only. Injected reports do not change emulator sensor state; this does not claim physical printer behavior under a fault.',
  results,
}, null, 2));
