export const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
export const WRITE_UUID = '00002af1-0000-1000-8000-00805f9b34fb';
export const NOTIFY_UUID = '00002af0-0000-1000-8000-00805f9b34fb';
export const bytesFromHex = hex => Uint8Array.from(hex.match(/.{2}/g) || [], pair => Number.parseInt(pair, 16));
export const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => globalThis.performance?.now() ?? Date.now();
function deadline(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

/** Commands and report framing come from Rust. GATT writes never imply printer delivery. */
export class D11sTransport {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, engine, onState = () => {}, onHealth = () => {}, timing = {} } = {}) {
    this.bluetooth = bluetooth; this.engine = engine; this.onState = onState; this.onHealth = onHealth;
    this.timing = { chunk: 20, fragments: 60, reply: 2500, complete: 60000, busy: 30000, poll: 500, write: 5000, ...timing };
    this.packetSize = 200; this.delayMs = this.timing.chunk;
    this.device = null; this.writer = null; this.notifier = null; this.waiter = null;
    this.executing = false; this.diagnosing = false; this.updating = false; this.connecting = false;
    this.pending = ''; this.incoming = Promise.resolve(); this.jobError = null; this.fault = ''; this.discardUntil = 0;
    this.identity = {}; this.verified = false; this.log = []; this.stats = this.emptyStats(); this.raw = false;
    this.onNotification = event => {
      const value = event.target.value;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      this.stats.rxBytes += bytes.length; this.stats.rxPackets++; this.stats.lastRxAt = Date.now();
      // Bind replies to the waiter present when the notification arrived. A delayed
      // worker response must never be consumed by a later command.
      const waiter = this.waiter;
      if (this.raw) { waiter?.push(bytes); this.emitHealth(); return; }
      this.incoming = this.incoming.then(async () => {
        const result = await this.engine({ op: 'reports', raster: this.pending + toHex(bytes) });
        this.pending = result.pending;
        for (const event of result.events) {
          this.record(event.kind, event);
          if (event.kind === 'fault') {
            this.fault = event.message;
            if (event.code) { this.stats.faults++; this.failJob(new Error(event.message)); }
          } else if (event.kind === 'discard') {
            this.stats.discardReports++;
            this.discardUntil = event.active ? Date.now() + 60000 : 0;
            if (event.active) this.failJob(new Error('Printer is discarding incoming data. Wait or reconnect before another label.'));
          }
        }
        if (result.reply) waiter?.push(bytesFromHex(result.reply));
        this.emitHealth();
      }).catch(error => { this.failJob(error); this.waiter?.fail(error); });
    };
    this.onDisconnected = () => {
      const error = new Error('Bluetooth disconnected. Keep the printer on and nearby.');
      this.stats.disconnects++; this.failJob(error); this.waiter?.fail(error);
      this.writer = null; this.verified = false;
      this.notifier?.removeEventListener('characteristicvaluechanged', this.onNotification); this.notifier = null;
      this.stats.phase = 'Disconnected'; this.record('disconnect', { message: error.message });
      this.onState({ connected: false }); this.emitHealth();
    };
  }
  emptyStats() { return { txBytes: 0, txPackets: 0, rxBytes: 0, rxPackets: 0, writeTotalMs: 0, writeMaxMs: 0, writeLastMs: 0, replyMs: null, timeouts: 0, disconnects: 0, faults: 0, discardReports: 0, phase: 'Disconnected', lastError: '', transferBytes: 0, transferMs: 0, lastRxAt: null }; }
  get connected() { return Boolean(this.device?.gatt?.connected && this.writer); }
  get occupied() { return this.executing || this.diagnosing || this.updating || this.connecting; }
  get discarding() { return Date.now() < this.discardUntil; }
  health() {
    return { ...this.stats, identity: { ...this.identity }, connected: this.connected, verified: this.verified,
      fault: this.fault, discarding: this.discarding, packetSize: this.packetSize, delayMs: this.delayMs,
      writeAvgMs: this.stats.txPackets ? this.stats.writeTotalMs / this.stats.txPackets : 0,
      bytesPerSecond: this.stats.transferMs ? this.stats.transferBytes * 1000 / this.stats.transferMs : 0 };
  }
  emitHealth() { this.onHealth(this.health()); }
  record(kind, details = {}) { this.log.push({ at: new Date().toISOString(), kind, ...details }); if (this.log.length > 200) this.log.shift(); }
  exportDiagnostics() { return { schema: 1, exportedAt: new Date().toISOString(), note: 'Host Bluetooth write timings are not printer acknowledgements or radio bandwidth. Label pixels and text are not logged.', health: this.health(), events: [...this.log] }; }
  setPacing(gentle) {
    if (this.occupied) throw new Error('Wait until the printer is idle to change pacing.');
    this.packetSize = gentle ? 100 : 200; this.delayMs = gentle ? Math.max(40, this.timing.chunk) : this.timing.chunk;
    this.record('pacing', { packetSize: this.packetSize, delayMs: this.delayMs }); this.emitHealth();
  }
  failJob(error) {
    this.stats.lastError = error.message;
    if (this.executing && !this.jobError) this.jobError = error;
    if (this.executing) this.waiter?.fail(error);
  }
  async checkHealthy({ allowFault = false } = {}) {
    await this.incoming;
    if (!this.connected) throw new Error('Connect your printer first.');
    if (this.jobError) throw this.jobError;
    if (this.discarding) throw new Error('Printer is discarding data. Wait up to 60 seconds or reconnect.');
    if (!allowFault && this.fault) throw new Error(this.fault);
    if (this.pending) {
      await sleep(this.timing.fragments); await this.incoming;
      if (this.pending) throw new Error('An incomplete printer report arrived. Reconnect before sending more data.');
    }
  }
  async connect() {
    if (this.occupied) throw new Error('Wait for the current printer operation to finish.');
    if (!this.bluetooth) throw new Error('Use Chrome on Android, macOS or Windows for Bluetooth printing.');
    if (!this.engine) throw new Error('Wait for the label engine to load.');
    this.disconnect(); this.connecting = true;
    // Invoke the chooser before any await, while the user gesture is active.
    let selection;
    try { selection = this.bluetooth.requestDevice({
      filters: [{ namePrefix: 'FICHERO_5836' }, { namePrefix: 'D11s' }, { namePrefix: 'D11S' }, { namePrefix: 'MULLER_6473' }], optionalServices: [SERVICE_UUID],
    }); } catch (error) { this.connecting = false; throw error; }
    try {
      const device = await selection; this.device = device;
      this.pending = ''; this.incoming = Promise.resolve(); this.fault = ''; this.discardUntil = 0; this.jobError = null;
      this.identity = {}; this.verified = false; this.stats = this.emptyStats(); this.log = [];
      this.stats.connectedAt = Date.now(); this.stats.phase = 'Connecting'; this.emitHealth();
      device.addEventListener('gattserverdisconnected', this.onDisconnected);
      const server = await deadline(device.gatt.connect(), 20000, 'The printer did not connect. Turn it on and try again.');
      const service = await deadline(server.getPrimaryService(SERVICE_UUID), 10000, 'The printer service did not respond.');
      this.writer = await deadline(service.getCharacteristic(WRITE_UUID), 10000, 'The printer write channel did not respond.');
      if (typeof this.writer.writeValueWithoutResponse !== 'function' || !this.writer.properties.writeWithoutResponse) throw new Error('This printer does not support the required Bluetooth writes.');
      this.notifier = await deadline(service.getCharacteristic(NOTIFY_UUID), 10000, 'The printer reply channel did not respond.');
      this.notifier.addEventListener('characteristicvaluechanged', this.onNotification);
      await deadline(this.notifier.startNotifications(), 10000, 'Could not enable printer replies.');
      this.identity.model = await this.textQuery('10ff20f0');
      if (this.identity.model.toLowerCase() !== 'd11s') throw new Error(`Unsupported printer model: ${this.identity.model || 'unknown'}. This page requires D11s.`);
      this.verified = true; this.stats.phase = 'Ready'; this.record('identity', { model: this.identity.model });
      this.onState({ connected: true, name: device.name || 'D11s printer' }); this.emitHealth();
      return device.name || 'D11s printer';
    } catch (error) { this.disconnect(); throw error; }
    finally { this.connecting = false; }
  }
  disconnect() {
    this.waiter?.fail(new Error('Printer disconnected.'));
    this.notifier?.removeEventListener('characteristicvaluechanged', this.onNotification);
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected); this.device?.gatt?.disconnect();
    this.device = null; this.writer = null; this.notifier = null; this.verified = false; this.raw = false;
    this.stats.phase = 'Disconnected'; this.onState({ connected: false }); this.emitHealth();
  }
  async write(bytes, progress = () => {}, { allowFault = false, raw = false } = {}) {
    if (!this.connected) throw new Error('Connect your printer first.');
    const start = now(); let sent = 0;
    if (bytes.length > 200) { this.stats.transferBytes = 0; this.stats.transferMs = 0; }
    for (let offset = 0; offset < bytes.length; offset += this.packetSize) {
      if (!raw) await this.checkHealthy({ allowFault });
      if (!this.connected) throw new Error('Bluetooth disconnected during the transfer.');
      const chunk = bytes.slice(offset, offset + this.packetSize), before = now();
      const previousPhase = this.stats.phase;
      const stallTimer = setTimeout(() => { this.stats.phase = 'Bluetooth write pending'; this.emitHealth(); }, 1000);
      try { await deadline(this.writer.writeValueWithoutResponse(chunk), this.timing.write, 'Bluetooth write stalled. Check the physical label before retrying.'); }
      catch (error) { this.stats.timeouts += /stall/.test(error.message) ? 1 : 0; this.stats.lastError = error.message; this.emitHealth(); throw error; }
      finally { clearTimeout(stallTimer); if (this.stats.phase === 'Bluetooth write pending') this.stats.phase = previousPhase; }
      const latency = now() - before;
      this.record('write', { bytes: chunk.length, ms: Math.round(latency) });
      this.stats.txBytes += chunk.length; this.stats.txPackets++; this.stats.writeTotalMs += latency;
      this.stats.writeLastMs = latency; this.stats.writeMaxMs = Math.max(this.stats.writeMaxMs, latency);
      // Only slow down. Never retransmit a failed packet or probe bandwidth with raster data.
      if (latency > 100 && this.delayMs < 80) this.delayMs = Math.min(80, this.delayMs + 10);
      if (!raw) await this.checkHealthy({ allowFault });
      sent += chunk.length; progress(sent, bytes.length);
      await sleep(this.delayMs);
      if (bytes.length > 200) { this.stats.transferBytes = sent; this.stats.transferMs = now() - start; }
      this.emitHealth();
    }
  }
  async query(bytes, timeout = this.timing.reply, { raw = false } = {}) {
    if (this.waiter) throw new Error('A printer reply is already pending.');
    let settleTimer, timeoutTimer, settled = false; const parts = []; const start = now(); let waiter;
    const response = new Promise((resolve, reject) => {
      const finish = error => {
        if (settled) return; settled = true;
        clearTimeout(settleTimer); clearTimeout(timeoutTimer);
        if (this.waiter === waiter) this.waiter = null;
        error ||= this.jobError;
        if (!error && !raw && this.pending) error = new Error('Incomplete printer report. Reconnect and check the label.');
        if (error) reject(error);
        else { this.stats.replyMs = now() - start; this.record('reply', { bytes: parts.reduce((n, p) => n + p.length, 0), ms: Math.round(this.stats.replyMs) }); resolve(Uint8Array.from(parts.flatMap(part => Array.from(part)))); }
      };
      waiter = { push: bytes => {
        if (settled) return;
        if (parts.reduce((n, p) => n + p.length, 0) + bytes.length > 4096) { finish(new Error('Printer response exceeded the receive limit.')); return; }
        parts.push(bytes); clearTimeout(settleTimer); settleTimer = setTimeout(() => finish(), this.timing.fragments);
      }, fail: finish };
      this.waiter = waiter;
      timeoutTimer = setTimeout(() => { this.stats.timeouts++; finish(new Error('No reply from the printer. Check its power, paper and cover.')); this.emitHealth(); }, timeout);
    });
    response.catch(() => {});
    // Do not log raster or firmware contents. Only small command headers.
    this.record('query', { command: bytes.length <= 12 ? toHex(bytes) : 'firmware frame', bytes: bytes.length });
    try { await this.write(bytes, undefined, { allowFault: true, raw }); return await response; }
    catch (error) { waiter.fail(error); throw error; }
  }
  async textQuery(hex) {
    const bytes = await this.query(bytesFromHex(hex));
    if (!bytes.length || bytes.length > 128 || bytes.some(b => b !== 0 && (b < 32 || b > 126))) throw new Error('Invalid printer identity response.');
    return new TextDecoder().decode(bytes).replace(/\0/g, '').trim();
  }
  async readDiagnostics() {
    if (this.occupied) throw new Error('Wait until the printer is idle to check its health.');
    this.diagnosing = true; this.stats.phase = 'Checking health'; this.jobError = null;
    try {
      this.identity.version = await this.textQuery('10ff20f1');
      this.identity.boot = await this.textQuery('10ff20ef');
      this.identity.serial = await this.textQuery('10ff20f2');
      const battery = await this.query(bytesFromHex('10ff50f1'));
      if (battery.length !== 2 || battery[1] > 100) throw new Error('Invalid battery response.');
      this.identity.battery = battery[1]; this.identity.batteryRaw = toHex(battery);
      const status = await this.query(bytesFromHex('10ff40'));
      this.identity.status = toHex(status);
      try { await this.engine({ op: 'reply', mode: 'status', raster: toHex(status) }); this.fault = ''; }
      catch (error) { this.fault = error.message; }
      this.stats.phase = this.fault ? 'Printer needs attention' : 'Ready';
      this.record('health', { battery: this.identity.battery, status: this.identity.status });
      return this.health();
    } catch (error) { this.stats.lastError = error.message; throw error; }
    finally { this.diagnosing = false; this.emitHealth(); }
  }
  async wake() {
    if (this.occupied) throw new Error('Wait until the printer is idle.');
    this.diagnosing = true;
    try { await this.write(new Uint8Array(12), undefined, { allowFault: true }); this.record('wake'); }
    finally { this.diagnosing = false; }
    return this.readDiagnostics();
  }
  async execute(steps, engine = this.engine, { onStarted = () => {}, onProgress = () => {} } = {}) {
    if (this.occupied) throw new Error('A label is already printing or another operation is active.');
    if (!this.verified) throw new Error('Connect a verified D11s printer first.');
    this.executing = true; this.jobError = null; this.stats.lastError = '';
    try {
      for (const step of steps) {
        const data = bytesFromHex(step.hex);
        this.stats.phase = step.starts_print ? 'Sending label' : step.wait === 'complete' ? 'Waiting for printer' : 'Preparing label'; this.emitHealth();
        if (step.wait === 'status') {
          const end = Date.now() + this.timing.busy;
          while (true) {
            const reply = await this.query(data);
            const result = await engine({ op: 'reply', mode: 'status', raster: toHex(reply) });
            if (result.low_battery) throw new Error('Charge the printer before printing.');
            this.fault = '';
            if (!result.busy) break;
            if (Date.now() >= end) throw new Error('The printer is still busy. Check the label before retrying.');
            await sleep(this.timing.poll);
          }
        } else if (step.wait === 'ack' || step.wait === 'complete') {
          const reply = await this.query(data, step.wait === 'complete' ? this.timing.complete : this.timing.reply);
          await engine({ op: 'reply', mode: step.wait, raster: toHex(reply) });
        } else {
          await this.checkHealthy();
          if (step.starts_print) onStarted();
          await this.write(data, step.starts_print ? onProgress : undefined);
        }
        await sleep(step.delay); await this.checkHealthy();
      }
      this.stats.phase = 'Ready';
    } catch (error) { this.stats.phase = 'Interrupted'; this.stats.lastError = error.message; this.record('error', { message: error.message }); throw error; }
    finally { this.executing = false; this.emitHealth(); }
  }
}
