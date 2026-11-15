#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo build --manifest-path core/Cargo.toml --locked --release --target wasm32-unknown-unknown
mkdir -p web/pkg
cp core/target/wasm32-unknown-unknown/release/action_printer_core.wasm web/pkg/labeler.wasm
cp core/assets/NotoSans-Regular.ttf web/pkg/NotoSans-Regular.ttf
cp core/assets/OFL.txt web/pkg/OFL.txt
cp core/assets/Noto-fonts-LICENSE.txt web/pkg/Noto-fonts-LICENSE.txt
python3 - <<'PY'
from pathlib import Path
import hashlib, json, shutil
root = Path('web')
files = ['index.html', 'styles.css', 'app.mjs', 'updates.mjs', 'engine.mjs', 'engine-worker.mjs', 'sw-template.js',
         'bluetooth.mjs', 'jobs.mjs', 'icon.svg', 'pkg/labeler.wasm', 'pkg/NotoSans-Regular.ttf', 'pkg/OFL.txt', 'pkg/Noto-fonts-LICENSE.txt']
digest = hashlib.sha256(b''.join((root / f).read_bytes() for f in files)).hexdigest()[:16]
template = (root / 'sw-template.js').read_text()
(root / 'service-worker.js').write_text(template.replace('__BUILD_HASH__', digest))
(root / 'version.json').write_text(json.dumps({'build': digest}) + '\n')
# Each HTML release names its own immutable module/worker/WASM directory. An
# older service worker or HTTP cache cannot combine new controls with old code.
output = root / 'build'
if output.exists(): shutil.rmtree(output)
assets = output / 'assets' / digest
assets.mkdir(parents=True)
for name in files:
    if name in ('index.html', 'sw-template.js'): continue
    target = assets / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / name, target)
html = (root / 'index.html').read_text().replace('__BUILD_HASH__', digest)
html = html.replace('href="./styles.css"', f'href="./assets/{digest}/styles.css"')
html = html.replace('src="./app.mjs"', f'src="./assets/{digest}/app.mjs"')
(output / 'index.html').write_text(html)
for name in ['icon.svg', 'version.json']:
    shutil.copyfile(root / name, output / name)
cache_files = ['./', './index.html', './icon.svg'] + [f'./assets/{digest}/{name}' for name in files if name not in ('index.html', 'sw-template.js')]
built_worker = template.replace('__BUILD_HASH__', digest)
start = built_worker.index('const FILES = ')
end = built_worker.index('\n', start)
built_worker = built_worker[:start] + 'const FILES = ' + json.dumps(cache_files) + ';' + built_worker[end:]
(output / 'service-worker.js').write_text(built_worker)
print(f'Built Labeler web app ({digest})')
PY
