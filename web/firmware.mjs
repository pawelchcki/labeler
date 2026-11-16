import { bytesFromHex, toHex } from './bluetooth.mjs';
export const FIRMWARE_API = 'https://api.fichero.luckjingle.com/api/apis/public/firmware';
export const FLASH_START = 0x01020000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const put32 = (bytes, offset, value) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, false);
export const firmwareChecksum = bytes => bytes.reduce((sum, byte) => (sum + byte) >>> 0, 0);
export function firmwareFrame(type, payload = new Uint8Array()) {
  if (payload.length > 300) throw new Error('Firmware payload exceeds the SDK frame limit.');
  const bytes = new Uint8Array(payload.length + 13), view = new DataView(bytes.buffer);
  bytes.set([0x1b, 0x10]); view.setUint16(2, payload.length + 6); bytes[6] = type;
  view.setUint16(10, payload.length); bytes.set(payload, 12); bytes[bytes.length - 1] = firmwareChecksum(bytes) & 255;
  return bytes;
}
export function parseFirmwareFrame(bytes, expectedType) {
  if (bytes.length < 13 || bytes.length > 320 || bytes[0] !== 0x1b || bytes[1] !== 0x10) throw new Error('Invalid bootloader response header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = view.getUint16(10);
  if (bytes.length !== length + 13 || view.getUint16(2) !== length + 6 || length > 300 ||
      bytes[bytes.length - 1] !== (firmwareChecksum(bytes.subarray(0, -1)) & 255)) throw new Error('Invalid bootloader response length or checksum.');
  if (bytes[6] !== expectedType) throw new Error(`Bootloader rejected command ${expectedType}: reply type ${bytes[6]}.`);
  return bytes.slice(12, -1);
}
export async function inspectFirmware(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1024 || bytes.length > 256 * 1024) throw new Error('Select a raw .bin image between 1 and 256 KiB. ZIP archives must be extracted first.');
  const text = new TextDecoder('latin1').decode(bytes);
  const d11s = /(?:^|[^a-z0-9])D11s(?:[^a-z0-9]|$)/i.test(text);
  const wrongModel = /D11[ _-]*(?:Pro|Plus)|D12|A40/i.test(text);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Raw AiYin images contain code pointers relative to 0x01020000.
  let codePointers = 0;
  for (let offset = 0x100; offset < 0x13c; offset += 4) {
    const pointer = view.getUint32(offset, true);
    if ((pointer & 1) && pointer >= FLASH_START && pointer < FLASH_START + bytes.length) codePointers++;
  }
  const sha256 = toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
  return { bytes: bytes.length, sha256, checksum: firmwareChecksum(bytes), model: wrongModel ? 'Other model' : d11s ? 'D11s' : 'Unknown', codePointers,
    eligible: d11s && !wrongModel && codePointers >= 4,
    note: 'Model strings and code pointers are screening checks, not proof of authenticity or board compatibility. No vendor signature has been verified.' };
}
export function firmwareMetadataURL(identity, name) {
  if (identity.model?.toLowerCase() !== 'd11s' || !identity.serial || !identity.version) throw new Error('Check printer health first to read its model, serial and version.');
  const url = new URL(FIRMWARE_API);
  url.search = new URLSearchParams({ bluetooth_name: name || '', sn: identity.serial, model: identity.model, version: identity.version });
  return url.href;
}
export async function checkFirmware(identity, name, fetcher = fetch) {
  const response = await fetcher(firmwareMetadataURL(identity, name), { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Firmware server returned HTTP ${response.status}.`);
  const json = await response.json(), code = json.code ?? json.status;
  if (code !== undefined && code !== 200 && code !== 0) throw new Error(String(json.message || `Firmware API error ${code}`).slice(0, 200));
  const item = json.data ?? json.result;
  if (!item?.media?.files) return null;
  const url = new URL(item.media.files);
  if (url.protocol !== 'https:') throw new Error('The vendor returned a firmware URL without HTTPS.');
  return { url: url.href, version: String(item.version || ''), description: String(item.lang_content || '') };
}
export async function downloadFirmware(url, fetcher = fetch) {
  const source = new URL(url);
  if (source.protocol !== 'https:') throw new Error('Firmware downloads require HTTPS.');
  const response = await fetcher(source.href, { credentials: 'omit', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Firmware download returned HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > 256 * 1024) throw new Error('The download exceeds the raw firmware size limit. Save and inspect the vendor package separately.');
  // Bounded streaming also covers a missing or inaccurate Content-Length.
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > 256 * 1024) throw new Error('Firmware download exceeds 256 KiB.'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
/** Experimental SDK-derived updater. Never retry erase/data and never bypass model screening. */
export async function flashFirmware(transport, bytes, { confirmed = false, onProgress = () => {}, wait = sleep } = {}) {
  if (!confirmed) throw new Error('Confirm the exact-model firmware and update risk before flashing.');
  if (transport.occupied || !transport.connected || !transport.verified || transport.identity.model?.toLowerCase() !== 'd11s') throw new Error('Connect an idle, verified D11s printer first.');
  const inspection = await inspectFirmware(bytes);
  if (!inspection.eligible) throw new Error('Blocked: this file is not a recognized raw D11s image. D11 Pro firmware is incompatible.');
  // Recheck after asynchronous file inspection, then reserve the connection across
  // diagnostics and flashing so no print or second updater can interleave.
  if (transport.occupied) throw new Error('Another printer operation has started.');
  await transport.readDiagnostics();
  if (transport.occupied) throw new Error('Another printer operation has started.');
  transport.updating = true;
  let entered = false;
  try {
    const status = await transport.query(bytesFromHex('10ff40'));
    await transport.engine({ op: 'reply', mode: 'status', raster: toHex(status) });
    if (status.length !== 1 || status[0] !== 0 || transport.fault || transport.discarding) throw new Error('The printer must be idle and fault-free before updating.');
    if (!Number.isInteger(transport.identity.battery) || transport.identity.battery < 50) throw new Error('Charge the printer to at least 50% and connect USB power before updating.');
    transport.raw = true; transport.stats.phase = 'Entering bootloader'; transport.emitHealth();
    entered = true;
    await transport.write(bytesFromHex('10ffe0aaaa'), undefined, { raw: true }); await wait(1000);
    const command = async (type, payload) => parseFirmwareFrame(await transport.query(firmwareFrame(type, payload), 3000, { raw: true }), type);
    await command(2);
    const challenge = new Uint8Array(1); crypto.getRandomValues(challenge);
    const answer = await transport.query(Uint8Array.from([0x10, 0xff, 0xff, challenge[0]]), 3000, { raw: true });
    const high = challenge[0] >> 4, low = challenge[0] & 15;
    if (answer.length !== 1 || answer[0] !== (((high | low) << 4) | (high & low))) throw new Error('Bootloader challenge response did not match. No erase sent.');
    await command(2);
    const range = new Uint8Array(9); put32(range, 1, FLASH_START); put32(range, 5, FLASH_START + bytes.length);
    transport.stats.phase = 'Preparing flash'; transport.emitHealth(); await command(3, range);
    transport.stats.phase = 'Writing firmware'; transport.emitHealth();
    for (let offset = 0, index = 0; offset < bytes.length; offset += 256, index++) {
      const chunk = bytes.slice(offset, offset + 256), payload = new Uint8Array(chunk.length + 7);
      put32(payload, 1, index); new DataView(payload.buffer).setUint16(5, chunk.length); payload.set(chunk, 7);
      await command(4, payload); onProgress(Math.min(offset + chunk.length, bytes.length), bytes.length);
    }
    transport.stats.phase = 'Verifying firmware'; transport.emitHealth();
    const verification = await command(6, range);
    if (verification.length !== 5 || verification[0] !== 0 || new DataView(verification.buffer, verification.byteOffset).getUint32(1) !== inspection.checksum) throw new Error('Firmware checksum verification failed. Do not retry blindly; use the vendor recovery procedure.');
    await command(2);
    // The SDK sends reboot without validating its reply. A disconnect is expected.
    await transport.write(firmwareFrame(7), undefined, { raw: true });
    transport.record('firmware-verified', { sha256: inspection.sha256, bytes: bytes.length });
    return inspection;
  } catch (error) {
    transport.stats.lastError = error.message; transport.record('firmware-error', { message: error.message });
    throw new Error(`${entered ? 'Update interrupted; the printer may remain in its bootloader. Do not print or automatically retry. ' : ''}${error.message}`);
  } finally {
    transport.raw = false; transport.updating = false;
    // A fresh model/version query is required after either update or interruption.
    if (entered) transport.disconnect(); else transport.emitHealth();
  }
}
