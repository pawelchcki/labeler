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
import hashlib
root = Path('web')
files = ['index.html', 'styles.css', 'app.mjs', 'engine.mjs', 'engine-worker.mjs', 'sw-template.js',
         'bluetooth.mjs', 'jobs.mjs', 'icon.svg', 'pkg/labeler.wasm', 'pkg/NotoSans-Regular.ttf', 'pkg/OFL.txt', 'pkg/Noto-fonts-LICENSE.txt']
digest = hashlib.sha256(b''.join((root / f).read_bytes() for f in files)).hexdigest()[:16]
template = (root / 'sw-template.js').read_text()
(root / 'service-worker.js').write_text(template.replace('__BUILD_HASH__', digest))
print(f'Built Labeler web app ({digest})')
PY
