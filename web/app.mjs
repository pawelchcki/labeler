import { D11sTransport, bytesFromHex } from './bluetooth.mjs';
import { PrintGuard } from './jobs.mjs';

const $ = id => document.getElementById(id);
const worker = new Worker(new URL('./engine-worker.mjs', import.meta.url), { type: 'module' });
const calls = new Map();
let callId = 0, ready = false, preview = null, rendering = false, printing = false, connecting = false;
let renderVersion = 0, debounce, wakeLock;
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

const transport = new D11sTransport({ onState: ({ connected, name }) => {
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
  const busy = printing || connecting;
  $('connect').disabled = !supported || busy;
  $('connect').textContent = connecting ? 'Connecting…' : transport?.connected ? 'Change printer' : 'Connect printer';
  $('print').disabled = !supported || !ready || !preview || rendering || busy || !transport?.connected || guard.pending;
  $('download').disabled = !preview || rendering;
  $('uncertain-panel').hidden = !guard.pending;
  $('confirm-checked').disabled = printing;
  for (const element of document.querySelectorAll('.editor input, .editor textarea, .editor select, .examples button, .print-options input, .print-options select')) element.disabled = printing;
  if (!printing) $('print-label').textContent = Number($('copies').value) > 1 ? `Print ${$('copies').value} labels` : 'Print one label';
}

function request() {
  const copies = Number($('copies').value);
  if (!Number.isInteger(copies) || copies < 1 || copies > 10) throw new Error('Choose 1–10 copies.');
  for (const id of ['length', 'trim']) if ($(id).value.trim() === '') throw new Error('Enter the stock length and end clearance.');
  const mode = document.querySelector('input[name=mode]:checked').value;
  if (mode === 'wrap' && $('cable').value === 'custom' && $('diameter').value === '') throw new Error('Enter the measured cable diameter.');
  return {
    text: $('label-text').value,
    mode,
    cable: $('cable').value,
    diameter_mm: $('diameter').value === '' ? 0 : Number($('diameter').value),
    length_mm: Number($('length').value), trim_mm: Number($('trim').value), copies,
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
  $('preview-dimensions').textContent = `${(rows / 8).toFixed(1)} × 12 mm ink area · ${plan.font_px} px type`;
  $('placement-tips').replaceChildren(...plan.tips.map(tip => {
    const p = document.createElement('p'); p.textContent = tip; return p;
  }));
  $('placement-tips').hidden = false;
}

async function render() {
  clearTimeout(debounce);
  const version = ++renderVersion;
  const wrap = document.querySelector('input[name=mode]:checked').value === 'wrap';
  $('cable-fields').hidden = !wrap;
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
    try { localStorage.setItem('labeler.settings.v1', JSON.stringify({ length: input.length_mm, trim: input.trim_mm, cable: input.cable, density: $('density').value })); } catch { /* Optional preferences only. */ }
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
  clearTimeout(debounce);
  debounce = setTimeout(render, 180);
}

$('connect').addEventListener('click', async () => {
  if (connecting || printing) return;
  connecting = true;
  controls();
  status('Choose your Fichero or D11s printer in the Bluetooth dialog.');
  try {
    const name = await transport.connect();
    status(`Connected to ${name}. Ready to print.`, 'success');
  } catch (error) {
    status(error.name === 'NotFoundError' ? 'No printer selected. Turn it on nearby and try Connect printer.' : error.message, 'error');
  } finally { connecting = false; controls(); }
});

$('print').addEventListener('click', async () => {
  if (printing || !preview || guard.pending || !transport.connected || rendering) return;
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
  if (printing) return;
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
window.addEventListener('beforeunload', event => { if (printing) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { if (!printing) transport.disconnect(); });

try {
  const saved = JSON.parse(localStorage.getItem('labeler.settings.v1') || '{}');
  if (Number.isFinite(saved.length) && saved.length >= 15 && saved.length <= 60) $('length').value = saved.length;
  if (Number.isFinite(saved.trim) && saved.trim >= 0 && saved.trim <= 6) $('trim').value = saved.trim;
  if (Array.from($('cable').options).some(option => option.value === saved.cable)) $('cable').value = saved.cable;
  if (['0', '1', '2'].includes(saved.density)) $('density').value = saved.density;
} catch { /* Preferences are optional; label text is never saved. */ }
if (!supported) {
  $('browser-notice').hidden = false;
  $('browser-notice').textContent = window.isSecureContext
    ? 'Preview and save labels in this browser. For direct Bluetooth printing, open this page in Chrome on Android, macOS or Windows. Safari and Firefox do not support Web Bluetooth.'
    : 'Bluetooth printing requires HTTPS or localhost. Open the published GitHub Pages site to connect a printer.';
}
controls();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
