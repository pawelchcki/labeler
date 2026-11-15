export const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
export const WRITE_UUID = '00002af1-0000-1000-8000-00805f9b34fb';
export const NOTIFY_UUID = '00002af0-0000-1000-8000-00805f9b34fb';
export const bytesFromHex = hex => Uint8Array.from(hex.match(/.{2}/g) || [], pair => Number.parseInt(pair, 16));
export const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function deadline(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

/** Only Bluetooth transport lives here. Rust creates commands and validates replies. */
export class D11sTransport {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, onState = () => {}, timing = {} } = {}) {
    this.bluetooth = bluetooth;
    this.onState = onState;
    this.timing = { chunk: 20, fragments: 60, reply: 2500, complete: 60000, busy: 30000, poll: 500, ...timing };
    this.device = null;
    this.writer = null;
    this.notifier = null;
    this.waiter = null;
    this.executing = false;
    this.onNotification = event => {
      const value = event.target.value;
      // A DataView may cover only part of its backing buffer.
      this.waiter?.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
    };
    this.onDisconnected = () => {
      this.waiter?.fail(new Error('Bluetooth disconnected. Keep the printer on and nearby.'));
      this.writer = null;
      this.notifier?.removeEventListener('characteristicvaluechanged', this.onNotification);
      this.notifier = null;
      this.onState({ connected: false });
    };
  }

  get connected() { return Boolean(this.device?.gatt?.connected && this.writer); }

  async connect() {
    if (this.executing) throw new Error('Wait for the current label to finish.');
    if (!this.bluetooth) throw new Error('Use Chrome on Android, macOS or Windows for Bluetooth printing.');
    this.disconnect();
    // Keep the chooser before any await: Web Bluetooth requires a user gesture.
    const device = await this.bluetooth.requestDevice({
      filters: [{ namePrefix: 'FICHERO' }, { namePrefix: 'D11s' }, { namePrefix: 'D11S' }],
      optionalServices: [SERVICE_UUID],
    });
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    try {
      const server = await deadline(device.gatt.connect(), 20000, 'The printer did not connect. Turn it on and try again.');
      const service = await deadline(server.getPrimaryService(SERVICE_UUID), 10000, 'The printer service did not respond.');
      this.writer = await deadline(service.getCharacteristic(WRITE_UUID), 10000, 'The printer write channel did not respond.');
      if (typeof this.writer.writeValueWithoutResponse !== 'function' || !this.writer.properties.writeWithoutResponse) {
        throw new Error('This browser or printer does not support the required Bluetooth writes.');
      }
      this.notifier = await deadline(service.getCharacteristic(NOTIFY_UUID), 10000, 'The printer reply channel did not respond.');
      this.notifier.addEventListener('characteristicvaluechanged', this.onNotification);
      await deadline(this.notifier.startNotifications(), 10000, 'Could not enable printer replies.');
      this.onState({ connected: true, name: device.name || 'D11s printer' });
      return device.name || 'D11s printer';
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect() {
    this.waiter?.fail(new Error('Printer disconnected.'));
    this.notifier?.removeEventListener('characteristicvaluechanged', this.onNotification);
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device?.gatt?.disconnect();
    this.device = null;
    this.writer = null;
    this.notifier = null;
    this.onState({ connected: false });
  }

  async write(bytes, progress = () => {}) {
    if (!this.connected) throw new Error('Connect your printer first.');
    for (let offset = 0; offset < bytes.length; offset += 200) {
      if (!this.connected) throw new Error('Bluetooth disconnected during the transfer.');
      const chunk = bytes.slice(offset, offset + 200);
      await deadline(this.writer.writeValueWithoutResponse(chunk), 5000, 'Bluetooth stopped responding during the transfer.');
      progress(Math.min(offset + chunk.length, bytes.length), bytes.length);
      await sleep(this.timing.chunk);
    }
  }

  async query(bytes, timeout) {
    if (this.waiter) throw new Error('A printer reply is already pending.');
    let settleTimer, timeoutTimer;
    const parts = [];
    let waiter;
    const response = new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(settleTimer);
        clearTimeout(timeoutTimer);
        if (this.waiter === waiter) this.waiter = null;
        if (error) reject(error);
        else resolve(Uint8Array.from(parts.flatMap(part => Array.from(part))));
      };
      waiter = {
        push: bytes => {
          parts.push(bytes);
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => finish(), this.timing.fragments);
        },
        fail: finish,
      };
      this.waiter = waiter;
      timeoutTimer = setTimeout(() => finish(new Error('No reply from the printer. Check its power, paper and cover.')), timeout);
    });
    // Notifications can arrive before the write promise resolves.
    response.catch(() => {});
    try {
      await this.write(bytes);
      return await response;
    } catch (error) {
      waiter.fail(error);
      throw error;
    }
  }

  async execute(steps, engine, { onStarted = () => {}, onProgress = () => {} } = {}) {
    if (this.executing) throw new Error('A label is already printing.');
    this.executing = true;
    try {
      for (const step of steps) {
        const data = bytesFromHex(step.hex);
        if (step.wait === 'status') {
          const end = Date.now() + this.timing.busy;
          while (true) {
            const reply = await this.query(data, this.timing.reply);
            const result = await engine({ op: 'reply', mode: 'status', raster: toHex(reply) });
            if (!result.busy) break;
            if (Date.now() >= end) throw new Error('The printer is still busy. Check the label before retrying.');
            await sleep(this.timing.poll);
          }
        } else if (step.wait === 'ack' || step.wait === 'complete') {
          const reply = await this.query(data, step.wait === 'complete' ? this.timing.complete : this.timing.reply);
          await engine({ op: 'reply', mode: step.wait, raster: toHex(reply) });
        } else {
          if (step.starts_print) onStarted();
          await this.write(data, step.starts_print ? onProgress : undefined);
        }
        await sleep(step.delay);
      }
    } finally {
      this.executing = false;
    }
  }
}
