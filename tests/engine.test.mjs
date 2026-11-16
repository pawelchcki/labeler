import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEngine } from '../web/engine.mjs';
import { RustProcess } from './helpers.mjs';

const engine = await createEngine(await readFile(new URL('../web/pkg/labeler.wasm', import.meta.url)));

test('WebAssembly produces the same layout, raster, protocol and reply results as native Rust', async t => {
  const native = new RustProcess('rpc');
  t.after(() => native.close());
  const cases = [
    { text: 'garaż 1' },
    { text: 'mikuś 195m' },
    { text: 'Office supplies and spare cables' },
    { text: 'kamera wschód 2', mode: 'wrap', cable: 'cat6a' },
    { text: 'USB-C', mode: 'wrap', cable: 'usb-c' },
    { text: 'kotłownia 2', mode: 'wrap', cable: 'custom', diameter_mm: 10, length_mm: 45, trim_mm: 2.5 },
    { text: 'Long stock', length_mm: 60, trim_mm: 0 },
    { text: 'a', length_mm: 15, trim_mm: 6 },
    { text: 'garaż 1', font: 'sans-bold', align: 'left', font_size_px: 24 },
    { text: 'mikuś 195m', font: 'serif', align: 'right', font_size_px: 16 },
    { text: 'USB-C', mode: 'wrap', cable: 'usb-c', font: 'mono', font_size_px: 12 },
    { text: 'TV HDMI', mode: 'wrap', cable: 'hdmi', diameter_mm: 10, font: 'serif' },
  ];
  for (const request of cases) {
    const actual = engine.dispatch(request);
    assert.deepEqual(actual, await native.call(request), `Plan differs: ${JSON.stringify(request)}`);
    const protocol = { op: 'protocol', raster: actual.raster, rows: actual.rows, copies: 2, density: 2 };
    assert.deepEqual(engine.dispatch(protocol), await native.call(protocol));
  }
  for (const request of [
    { op: 'presets' },
    { op: 'reports', raster: 'aaff04ff1001000000ff' },
    { op: 'reply', mode: 'status', raster: '01' },
    { op: 'reply', mode: 'ack', raster: '4f4b' },
    { op: 'reply', mode: 'complete', raster: 'aa' },
  ]) assert.deepEqual(engine.dispatch(request), await native.call(request));
});

test('WebAssembly rejects unsupported glyphs, invalid geometry, bad acknowledgements and paper faults', async t => {
  const native = new RustProcess('rpc');
  t.after(() => native.close());
  for (const request of [
    { text: '' }, { text: '😀' }, { text: 'a'.repeat(241) },
    { text: 'x', length_mm: 61 }, { text: 'x', trim_mm: -1 },
    { text: 'x', mode: 'wrap', cable: 'custom', diameter_mm: 21 },
    { text: 'x', copies: 11 },
    { text: 'x', font: 'missing' }, { text: 'x', align: 'up' },
    { text: 'x', font_size_px: 5 }, { text: 'Does not fit', font_size_px: 160 },
    { op: 'reply', mode: 'status', raster: '04' },
    { op: 'reply', mode: 'status', raster: '08' },
    { op: 'reply', mode: 'complete', raster: 'aaff04' },
    { op: 'reply', mode: 'ack', raster: '4e4f' },
    { op: 'reply', mode: 'complete', raster: '00' },
  ]) {
    const expected = await native.call(request);
    assert.equal(expected.ok, false);
    assert.throws(() => engine.dispatch(request), error => error.message === expected.error);
  }
});

test('JSON ABI remains usable after repeated calls and failures', () => {
  for (let i = 0; i < 1000; i++) {
    assert.throws(() => engine.dispatch({ op: 'unknown' }), /Unknown operation/);
    assert.equal(engine.dispatch({ op: 'presets' }).cables.length, 8);
  }
});
