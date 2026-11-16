import { D11sTransport, bytesFromHex } from './bluetooth.mjs';
import { inspectFirmware, checkFirmware, downloadFirmware, flashFirmware } from './firmware.mjs';
import { PrintGuard } from './jobs.mjs';
import { setupUpdates } from './updates.mjs';

const $ = id => document.getElementById(id);
const worker = new Worker(new URL('./engine-worker.mjs', import.meta.url), { type: 'module' });
const calls = new Map();
let callId = 0, ready = false, preview = null, rendering = false, printing = false, connecting = false;
let renderVersion = 0, debounce, wakeLock, maintenance = false;
let firmwareBytes = null, firmwareInspection = null, offeredFirmware = null;
let lastHealthDraw = 0; const rateHistory = [];
let storage;
try { storage = sessionStorage; } catch { storage = { getItem() { return null; }, setItem() { throw new Error('Allow browser storage before printing so interrupted jobs can be tracked.'); }, removeItem() {} }; }
const guard = new PrintGuard(storage);
const supported = Boolean(navigator.bluetooth && window.isSecureContext);

function engine(request) {
  return new Promise((resolve, reject) => {
    const id = ++callId;
    calls.set(id, { resolve, reject });
    worker.postMessage({ id, request });
  });
}
function engineFailed(message) {
  ready = false;
  preview = null;
  for (const call of calls.values()) call.reject(new Error(message));
  calls.clear();
  status(message, 'error');
  controls();
}
worker.onmessage = ({ data }) => {
  if (data.ready) {
    ready = true;
    status(guard.pending ? 'Check the previous label before printing again.' : 'Make a label, then connect your printer.');
    render();
  } else if (data.fatal) engineFailed(data.fatal);
  else {
    const call = calls.get(data.id);
    calls.delete(data.id);
    if (data.error) call?.reject(new Error(data.error));
    else call?.resolve(data.result);
  }
};
worker.onerror = () => engineFailed('The label engine could not load. Refresh this page to retry.');

const transport = new D11sTransport({ engine, onHealth: drawHealth, onState: ({ connected, name }) => {
  $('connection-dot').classList.toggle('connected', connected);
  $('printer-name').textContent = connected ? name : 'No printer connected';
  $('connection-description').textContent = connected ? 'Connected over Bluetooth. Ready for your label.' : 'Turn on your printer and keep it nearby.';
  controls();
} });

function status(message, tone = '') {
  $('print-status').textContent = message;
  $('print-status').className = `print-status ${tone}`;
}
function controls() {
  const busy = printing || connecting || maintenance;
  $('connect').disabled = !supported || !ready || busy;
  $('connect').textContent = connecting ? 'Connecting…' : transport?.connected ? 'Change printer' : 'Connect printer';
  for (const id of ['check-health', 'wake-printer', 'check-firmware']) $(id).disabled = busy || !transport?.connected;
  $('download-firmware').disabled = busy || !offeredFirmware;
  $('flash-firmware').disabled = busy || !transport?.connected || !firmwareInspection?.eligible || !$('confirm-firmware').checked || guard.pending;
  for (const id of ['gentle-pacing', 'firmware-file', 'confirm-firmware']) $(id).disabled = busy;
  $('print').disabled = !supported || !ready || !preview || rendering || busy || !transport?.connected || guard.pending;
  $('download').disabled = !preview || rendering;
  $('uncertain-panel').hidden = !guard.pending;
  $('confirm-checked').disabled = busy;
  $('load-update').disabled = busy;
  $('check-update').disabled = busy;
  for (const element of document.querySelectorAll('.editor input, .editor textarea, .editor select, .examples button, .print-options input, .print-options select, [data-wrap-example], #start-wrap')) element.disabled = printing || maintenance;
  if (!printing) $('print-label').textContent = Number($('copies').value) > 1 ? `Print ${$('copies').value} labels` : 'Print one label';
}

function request() {
  const copies = Number($('copies').value);
  if (!Number.isInteger(copies) || copies < 1 || copies > 10) throw new Error('Choose 1–10 copies.');
  for (const id of ['length', 'trim']) if ($(id).value.trim() === '') throw new Error('Enter the stock length and end clearance.');
  const mode = document.querySelector('input[name=mode]:checked').value;
  if (mode === 'wrap' && $('cable').value === 'custom' && $('diameter').value === '') throw new Error('Enter the measured cable diameter.');
  const fontSize = $('font-sizing').value === 'auto' ? 0 : Number($('font-size').value);
  if ($('font-sizing').value === 'custom' && (!Number.isInteger(fontSize) || fontSize < 6 || fontSize > 160)) throw new Error('Choose a whole-number font size from 6–160 px, or Auto fit.');
  return {
    text: $('label-text').value,
    mode,
    cable: $('cable').value,
    diameter_mm: $('diameter').value === '' ? 0 : Number($('diameter').value),
    length_mm: Number($('length').value), trim_mm: Number($('trim').value), copies,
    font: $('font').value, font_size_px: fontSize,
    align: document.querySelector('input[name=align]:checked').value,
  };
}

function draw(plan, mode) {
  const bytes = bytesFromHex(plan.raster), rows = plan.rows;
  const canvas = $('label-preview');
  canvas.width = mode === 'large' ? rows : 96;
  canvas.height = mode === 'large' ? 96 : rows;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < rows; y++) for (let x = 0; x < 96; x++) {
    const index = y * 96 + x;
    const black = bytes[index >> 3] & (0x80 >> (index % 8));
    // Same 90-degree display rotation as Android; the wire raster is unchanged.
    const target = mode === 'large' ? (x * rows + rows - 1 - y) * 4 : index * 4;
    pixels.data.set([black ? 0 : 255, black ? 0 : 255, black ? 0 : 255, 255], target);
  }
  context.putImageData(pixels, 0, 0);
  canvas.setAttribute('aria-label', `Print preview: ${$('label-text').value}`);
  $('preview-stage').classList.toggle('wrap', mode === 'wrap');
  $('label-paper').hidden = false;
  $('preview-empty').hidden = true;
  $('preview-dimensions').textContent = `${(rows / 8).toFixed(1)} × 12 mm · ${plan.font_px} px ${plan.auto_fit ? 'auto fit' : 'fixed'} · ${$('font').selectedOptions[0].textContent.split(' · ')[0]}`;
  $('placement-tips').replaceChildren(...plan.tips.map(tip => {
    const p = document.createElement('p'); p.textContent = tip; return p;
  }));
  $('placement-tips').hidden = false;
  updateWrapGuide(plan);
}

function updateWrapGuide(plan) {
  const geometry = plan?.wrap;
  $('wrap-fit').hidden = !geometry;
  $('wrap-strip-preview').hidden = !geometry;
  document.querySelector('.flat-illustration > svg').toggleAttribute('hidden', Boolean(geometry));
  const caption = geometry ? Array.from($('label-text').value).slice(0, 11).join('') : 'USB-C';
  document.querySelectorAll('#wrap-cable-text, [data-wrap-copy]').forEach(element => { element.textContent = caption; });
  if (!geometry) return;
  const strip = $('wrap-strip-preview');
  strip.width = 96;
  strip.height = plan.rows;
  strip.getContext('2d').drawImage($('label-preview'), 0, 0);
  $('wrap-diameter').textContent = `${plan.diameter_mm.toFixed(1)} mm`;
  $('wrap-circumference').textContent = `${geometry.circumference_mm.toFixed(1)} mm`;
  $('wrap-overlap').textContent = geometry.overlap_mm >= 0 ? `${geometry.overlap_mm.toFixed(1)} mm` : `${Math.abs(geometry.overlap_mm).toFixed(1)} mm short`;
  $('wrap-repeats').textContent = String(plan.repeats);
  $('wrap-fit').classList.toggle('does-not-fit', !geometry.fits);
  $('wrap-fit-message').textContent = geometry.fits
    ? `This stock has room for a full turn and at least 2 mm overlap. ${plan.repeats} copies of your text repeat around the wrap.`
    : `This cable needs at least ${(Math.ceil(geometry.minimum_length_mm * 10) / 10).toFixed(1)} mm of stock for a full turn plus 2 mm overlap. Use longer stock or a flag; change the stock-length setting only to match the labels you have.`;
}

async function render() {
  clearTimeout(debounce);
  const version = ++renderVersion;
  const wrap = document.querySelector('input[name=mode]:checked').value === 'wrap';
  $('cable-fields').hidden = !wrap;
  $('font-size-field').hidden = $('font-sizing').value !== 'custom';
  updateWrapGuide(null);
  $('character-count').textContent = `${Array.from($('label-text').value).length} / 240`;
  $('settings-summary').textContent = `${$('length').value} mm · ${$('trim').value} mm trim`;
  preview = null;
  $('editor-error').hidden = true;
  rendering = true;
  controls();
  if (!ready || !$('label-text').value.trim()) {
    rendering = false;
    $('label-paper').hidden = true;
    $('preview-empty').hidden = false;
    $('placement-tips').hidden = true;
    $('preview-dimensions').textContent = '96-dot printhead · 203 DPI';
    controls();
    return;
  }
  try {
    const input = request();
    const plan = await engine(input);
    if (version !== renderVersion) return;
    preview = { plan, input };
    draw(plan, input.mode);
    try { localStorage.setItem('labeler.settings.v1', JSON.stringify({ length: input.length_mm, trim: input.trim_mm, cable: input.cable, density: $('density').value, font: input.font, fontSize: input.font_size_px, align: input.align })); } catch { /* Optional preferences only. */ }
  } catch (error) {
    if (version !== renderVersion) return;
    $('editor-error').textContent = error.message;
    $('editor-error').hidden = false;
    $('label-paper').hidden = true;
    $('preview-empty').hidden = false;
    $('placement-tips').hidden = true;
  } finally {
    if (version === renderVersion) { rendering = false; controls(); }
  }
}

function scheduleRender() {
  // Invalidate the previous result immediately, before the debounce delay.
  ++renderVersion;
  preview = null;
  rendering = true;
  controls();
  document.querySelectorAll('[data-wrap-example]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  clearTimeout(debounce);
  debounce = setTimeout(render, 180);
}

$('connect').addEventListener('click', async () => {
  if (connecting || printing || maintenance) return;
  connecting = true;
  offeredFirmware = null; $('firmware-vendor-link').hidden = true;
  $('confirm-firmware').checked = false;
  controls();
  status('Choose your Fichero or D11s printer in the Bluetooth dialog.');
  try {
    const name = await transport.connect();
    status(`Connected to ${name}. Ready to print.`, 'success');
    await transport.readDiagnostics();
  } catch (error) {
    status(error.name === 'NotFoundError' ? 'No printer selected. Turn it on nearby and try Connect printer.' : error.message, 'error');
  } finally { connecting = false; controls(); }
});

$('print').addEventListener('click', async () => {
  if (printing || maintenance || !preview || guard.pending || !transport.connected || rendering) return;
  const { plan, input } = preview;
  printing = true;
  let started = false;
  controls();
  $('print-progress').value = 0;
  $('print-progress').hidden = false;
  $('print-label').textContent = 'Printing…';
  status('Checking the printer… Keep this tab open.');
  try {
    if (navigator.wakeLock) try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* Printing still works with the tab visible. */ }
    const protocol = await engine({ op: 'protocol', raster: plan.raster, rows: plan.rows, copies: input.copies, density: Number($('density').value) });
    await transport.execute(protocol.steps, engine, {
      onStarted() { guard.start(); started = true; },
      onProgress(sent, total) {
        $('print-progress').value = Math.round(sent / total * 100);
        status(sent === total ? 'Label transferred. Waiting for the printer to finish…' : `Sending label… ${Math.round(sent / total * 100)}%`);
      },
    });
    guard.clear();
    status(input.copies === 1 ? 'Printed. Ready for the next label.' : `${input.copies} labels printed. Ready for the next batch.`, 'success');
  } catch (error) {
    transport.disconnect();
    status(started ? `Printing was interrupted. Check the physical label before retrying. ${error.message}` : error.message, 'error');
  } finally {
    await wakeLock?.release().catch(() => {});
    wakeLock = null;
    printing = false;
    $('print-progress').hidden = true;
    controls();
  }
});

$('confirm-checked').addEventListener('click', () => {
  if (printing || maintenance) return;
  try { guard.clear(); status('Ready. A new print will make a new label.'); controls(); }
  catch { status('Could not clear the previous job. Allow browser storage and refresh.', 'error'); }
});
$('download').addEventListener('click', () => {
  if (!preview) return;
  const a = document.createElement('a');
  a.download = 'labeler-label.png';
  a.href = $('label-preview').toDataURL('image/png');
  a.click();
});
document.querySelectorAll('.editor input, .editor textarea, .editor select, .print-options input, .print-options select').forEach(element => element.addEventListener('input', scheduleRender));
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => {
  $('label-text').value = button.dataset.example;
  if (button.dataset.wrap) {
    document.querySelector('input[name=mode][value=wrap]').checked = true;
    $('cable').value = 'usb-c';
  } else document.querySelector('input[name=mode][value=large]').checked = true;
  render();
}));
const wrapExamples = {
  usb: { text: 'DESK USB-C', cable: 'usb-c', diameter: '' },
  network: { text: 'ROUTER 01', cable: 'cat6a', diameter: '' },
  hdmi: { text: 'TV HDMI', cable: 'hdmi', diameter: '10' },
};
$('start-wrap').addEventListener('click', () => {
  if (printing || maintenance) return;
  document.querySelector('input[name=mode][value=wrap]').checked = true;
  render();
  $('label-text').focus();
});
document.querySelectorAll('[data-wrap-example]').forEach(button => button.addEventListener('click', () => {
  if (printing || maintenance) return;
  const example = wrapExamples[button.dataset.wrapExample];
  $('label-text').value = example.text;
  $('cable').value = example.cable;
  $('diameter').value = example.diameter;
  $('length').value = '30';
  $('trim').value = '3';
  $('font-sizing').value = 'auto';
  document.querySelector('input[name=mode][value=wrap]').checked = true;
  document.querySelectorAll('[data-wrap-example]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  status('Example loaded. Review the preview and fit before printing.');
  render();
  $('editor-title').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}));
window.addEventListener('beforeunload', event => { if (printing || maintenance) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { if (!printing && !maintenance) transport.disconnect(); });


function drawHealth(health) {
  const stamp = performance.now();
  const rate = health.bytesPerSecond / 1024;
  const issue = health.fault || (health.discarding ? 'Printer discarding data' : '');
  $('link-health').textContent = issue || `${health.phase} · ${rate.toFixed(1)} KiB/s · ${health.writeAvgMs.toFixed(0)} ms avg write${health.writeLastMs > 100 ? ' · Slow writes: pacing reduced' : ''}`;
  $('link-health').classList.toggle('attention', Boolean(issue || health.lastError));
  if (stamp - lastHealthDraw < 200 && health.phase === 'Sending label') return;
  lastHealthDraw = stamp;
  $('stat-rate').textContent = `${rate.toFixed(1)} KiB/s`;
  $('stat-latency').textContent = `${health.writeAvgMs.toFixed(0)} / ${health.writeMaxMs.toFixed(0)} ms`;
  $('stat-reply').textContent = health.replyMs === null ? '—' : `${health.replyMs.toFixed(0)} ms`;
  $('stat-bytes').textContent = `${health.txBytes.toLocaleString()} / ${health.rxBytes.toLocaleString()} B`;
  $('stat-packets').textContent = `${health.txPackets} / ${health.rxPackets}`;
  $('stat-errors').textContent = `${health.timeouts} / ${health.disconnects}`;
  $('stat-reports').textContent = `${health.faults} / ${health.discardReports}`;
  $('stat-pacing').textContent = `${health.packetSize} B / ${health.delayMs} ms`;
  const d = health.identity;
  $('device-details').textContent = d.model ? `${d.model} · Firmware ${d.version || '—'} · Boot ${d.boot || '—'} · Battery ${d.battery ?? '—'}% · Serial ${d.serial || '—'}${d.status ? ` · Status 0x${d.status}` : ''}` : 'Connect a D11s printer to read its identity, firmware and battery.';
  rateHistory.push(rate); if (rateHistory.length > 60) rateHistory.shift();
  const max = Math.max(1, ...rateHistory);
  $('bandwidth-line').setAttribute('d', rateHistory.map((r, i) => `${i ? 'L' : 'M'}${(i * 400 / 59).toFixed(1)} ${(60 - r / max * 52).toFixed(1)}`).join(' '));
  $('protocol-log').textContent = transport.log.slice(-24).map(event => `${event.at.slice(11, 23)} ${event.kind} ${event.command || event.message || (event.kind === 'write' || event.kind === 'reply' ? `${event.bytes} B / ${event.ms} ms` : event.kind === 'discard' ? `active=${event.active} payload=${event.payload}` : '')}`).join('\n') || 'No protocol events yet.';
}
async function printerTool(action) {
  if (printing || connecting || maintenance) return;
  maintenance = true; controls();
  try { await action(); }
  catch (error) { status(error.message, 'error'); }
  finally { maintenance = false; controls(); }
}
$('check-health').addEventListener('click', () => printerTool(async () => {
  const health = await transport.readDiagnostics(); status(health.fault || 'Printer health checked.', health.fault ? 'error' : 'success');
}));
$('wake-printer').addEventListener('click', () => printerTool(async () => {
  await transport.wake(); status('Wake bytes sent and printer checked. A powered-off printer must be turned on manually.');
}));
$('gentle-pacing').addEventListener('change', () => { try { transport.setPacing($('gentle-pacing').checked); } catch (error) { status(error.message, 'error'); } });
$('export-diagnostics').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(transport.exportDiagnostics(), null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'labeler-diagnostics.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function selectFirmware(bytes, name) {
  firmwareBytes = null; firmwareInspection = null; $('confirm-firmware').checked = false;
  const inspection = await inspectFirmware(bytes);
  firmwareBytes = bytes; firmwareInspection = inspection;
  $('firmware-info').textContent = `${name} · ${inspection.bytes.toLocaleString()} bytes · Model: ${inspection.model} · SHA-256: ${inspection.sha256} · ${inspection.eligible ? 'Passed file screening. Verify source and hardware match before flashing.' : 'Blocked: only a recognized raw D11s image may be flashed.'}`;
}
$('firmware-file').addEventListener('change', () => printerTool(async () => {
  firmwareBytes = null; firmwareInspection = null; $('confirm-firmware').checked = false;
  const file = $('firmware-file').files[0]; if (!file) return;
  if (file.size > 256 * 1024) { $('firmware-info').textContent = 'Blocked: raw firmware must be at most 256 KiB.'; return; }
  try { await selectFirmware(new Uint8Array(await file.arrayBuffer()), file.name); }
  catch (error) { $('firmware-info').textContent = error.message; throw error; }
}));
$('confirm-firmware').addEventListener('change', controls);
$('check-firmware').addEventListener('click', () => printerTool(async () => {
  offeredFirmware = null; firmwareBytes = null; firmwareInspection = null;
  $('confirm-firmware').checked = false; $('firmware-file').value = ''; $('firmware-vendor-link').hidden = true;
  await transport.readDiagnostics();
  try {
    offeredFirmware = await checkFirmware(transport.identity, transport.device?.name);
    $('firmware-info').textContent = offeredFirmware ? `Vendor offers version ${offeredFirmware.version}. Download and inspect the image before flashing.` : 'The vendor returned no update for this device. No firmware was downloaded.';
    if (offeredFirmware) { $('firmware-vendor-link').href = offeredFirmware.url; $('firmware-vendor-link').hidden = false; }
  } catch (error) { $('firmware-info').textContent = `Could not read vendor metadata: ${error.message} The server may block CORS. You can select a file downloaded separately.`; }
}));
$('download-firmware').addEventListener('click', () => printerTool(async () => {
  try { await selectFirmware(await downloadFirmware(offeredFirmware.url), `Vendor ${offeredFirmware.version}`); }
  catch (error) { $('firmware-info').textContent = `Download or inspection failed: ${error.message} If CORS is blocked, open the vendor download and select the extracted .bin locally.`; }
}));
$('flash-firmware').addEventListener('click', () => printerTool(async () => {
  if (guard.pending || !firmwareBytes || !$('confirm-firmware').checked) return;
  $('firmware-progress').hidden = false; $('firmware-progress').value = 0;
  status('Updating firmware. Keep USB power connected and this tab open.');
  try {
    if (navigator.wakeLock) try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* Keep the tab visible if screen wake lock is unavailable. */ }
    await flashFirmware(transport, firmwareBytes, { confirmed: true, onProgress(sent, total) { $('firmware-progress').value = Math.round(sent / total * 100); } });
    $('firmware-info').textContent = 'Firmware bytes verified by the bootloader; restart sent. Reconnect and check the reported version before printing.';
    status('Update transfer verified. Reconnect and check firmware version.', 'success');
  } catch (error) { $('firmware-info').textContent = error.message; throw error; }
  finally {
    await wakeLock?.release().catch(() => {}); wakeLock = null;
    $('firmware-progress').hidden = true; $('confirm-firmware').checked = false;
  }
}));

try {
  const saved = JSON.parse(localStorage.getItem('labeler.settings.v1') || '{}');
  if (Number.isFinite(saved.length) && saved.length >= 15 && saved.length <= 60) $('length').value = saved.length;
  if (Number.isFinite(saved.trim) && saved.trim >= 0 && saved.trim <= 6) $('trim').value = saved.trim;
  if (Array.from($('cable').options).some(option => option.value === saved.cable)) $('cable').value = saved.cable;
  if (['0', '1', '2'].includes(saved.density)) $('density').value = saved.density;
  if (['sans', 'sans-bold', 'mono', 'serif'].includes(saved.font)) $('font').value = saved.font;
  if (Number.isInteger(saved.fontSize) && saved.fontSize >= 6 && saved.fontSize <= 160) { $('font-sizing').value = 'custom'; $('font-size').value = saved.fontSize; }
  if (['left', 'center', 'right'].includes(saved.align)) document.querySelector(`input[name=align][value=${saved.align}]`).checked = true;
} catch { /* Preferences are optional; label text is never saved. */ }
if (!supported) {
  $('browser-notice').hidden = false;
  $('browser-notice').textContent = window.isSecureContext
    ? 'Preview and save labels in this browser. For direct Bluetooth printing, open this page in Chrome on Android, macOS or Windows. Safari and Firefox do not support Web Bluetooth.'
    : 'Bluetooth printing requires HTTPS or localhost. Open the published GitHub Pages site to connect a printer.';
}
controls();
if (window.isSecureContext) setupUpdates({ isPrinting: () => printing || maintenance, onAvailable: controls });
