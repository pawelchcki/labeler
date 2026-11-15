import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../web/build/', import.meta.url);
const read = path => readFile(new URL(path, root));

test('Published HTML, modules, worker and WASM form one complete versioned release', async () => {
  const { build } = JSON.parse(await read('version.json'));
  assert.match(build, /^[0-9a-f]{16}$/);
  const html = (await read('index.html')).toString();
  assert.ok(html.includes(`name="labeler-build" content="${build}"`));
  const app = html.match(/src="(\.\/assets\/[^"]+\/app\.mjs)"/)[1];
  const css = html.match(/href="(\.\/assets\/[^"]+\/styles\.css)"/)[1];
  assert.ok(app.includes(`/assets/${build}/`));
  assert.ok(css.includes(`/assets/${build}/`));
  const base = new URL(`assets/${build}/`, root);
  for (const name of ['app.mjs', 'updates.mjs', 'engine.mjs', 'engine-worker.mjs', 'bluetooth.mjs', 'jobs.mjs']) {
    const source = (await readFile(new URL(name, base))).toString();
    for (const [, imported] of source.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) {
      assert.ok((await stat(new URL(imported, base))).isFile(), `${name} imports missing ${imported}`);
    }
  }
  const deployedWasm = await readFile(new URL('pkg/labeler.wasm', base));
  const testedWasm = await readFile(new URL('../web/pkg/labeler.wasm', import.meta.url));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(deployedWasm), hash(testedWasm));
  const serviceWorker = (await read('service-worker.js')).toString();
  const files = JSON.parse(serviceWorker.match(/const FILES = (\[[^\n]+\]);/)[1]);
  assert.ok(files.includes(app));
  assert.ok(files.includes(css));
  assert.ok(files.includes(`./assets/${build}/pkg/labeler.wasm`));
  for (const path of files) {
    assert.ok((await stat(new URL(path === './' ? './index.html' : path, root))).isFile(), `Offline cache references missing ${path}`);
  }
});
