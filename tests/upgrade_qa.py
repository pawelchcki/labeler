"""Regression: upgrade an already cached original app, with a print in progress."""
import functools
import http.server
import json
import pathlib
import shutil
import sys
import tempfile
import threading
from invisible_playwright import InvisiblePlaywright

old_root, new_root = (pathlib.Path(value).resolve() for value in sys.argv[1:3])
state = {'root': old_root}
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(state['root']), **kwargs)
    def end_headers(self):
        self.send_header('Cache-Control', 'public, max-age=86400')
        super().end_headers()
    def log_message(self, *args):
        pass

MOCK = r"""
(() => {
  const notify = new EventTarget();
  notify.startNotifications = async () => notify;
  const send = bytes => {
    notify.value = new DataView(Uint8Array.from(bytes).buffer);
    notify.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  const writer = { properties: { writeWithoutResponse: true }, async writeValueWithoutResponse(bytes) {
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    if(hex === '10ff40') send([0]);
    else if(hex.startsWith('10ff10') || hex.startsWith('10ff84')) send([79,75]);
    else if(hex === '10fffe45') window.completePrint = () => send([170]);
  }};
  const device = new EventTarget(); device.name = 'FICHERO_UPGRADE_TEST';
  device.gatt = { connected:false, async connect(){this.connected=true;return this;}, disconnect(){this.connected=false;}, async getPrimaryService(){return {async getCharacteristic(uuid){return uuid.startsWith('00002af1') ? writer : notify;}};} };
  Object.defineProperty(navigator,'bluetooth',{value:{async requestDevice(){return device;}}});
})();
"""

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/'
build = json.loads((new_root / 'version.json').read_text())['build']
next_build = 'f' * 16 if build != 'f' * 16 else 'e' * 16
checks = []
try:
    with tempfile.TemporaryDirectory(prefix='labeler-next-release-') as tmp:
        next_root = pathlib.Path(tmp) / 'site'
        shutil.copytree(new_root, next_root)
        (next_root / 'assets' / build).rename(next_root / 'assets' / next_build)
        for name in ['index.html', 'service-worker.js', 'version.json']:
            p = next_root / name
            p.write_text(p.read_text().replace(build, next_build))
        with InvisiblePlaywright(headless=True, timezone='Europe/Warsaw', humanize=False) as browser:
            page = browser.new_page(viewport={'width': 1000, 'height': 900})
            page.add_init_script(MOCK)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_function("document.querySelector('#print-status').textContent.includes('Make a label')")
            page.wait_for_function('navigator.serviceWorker.controller !== null')
            assert page.locator('#font').count() == 0
            page.evaluate("localStorage.setItem('labeler.settings.v1', JSON.stringify({length:45,trim:2,cable:'cat6a'})); sessionStorage.setItem('labeler.pending-print.v1','pending')")
            state['root'] = new_root
            page.reload(wait_until='domcontentloaded')
            assert page.locator('#font').count() == 0, 'Expected the original cache-first navigation to show the stale UI'
            checks.append('Reproduced stale UI after ordinary reload despite a newer server deployment')
            page.goto(url + '?v=' + build, wait_until='domcontentloaded')
            page.wait_for_function("document.querySelector('#font') && document.querySelector('#print-status').textContent.includes('previous label')")
            assert page.locator('#font option').count() == 4
            assert page.locator('#length').input_value() == '45'
            assert page.locator('#uncertain-panel').is_visible()
            checks.append('Version link recovers all new assets and preserves preferences and uncertain-job tracking')
            page.locator('#confirm-checked').click()
            page.locator('[data-example="garaż 1"]').click()
            page.wait_for_function("!document.querySelector('#download').disabled")
            page.locator('#connect').click()
            page.wait_for_function("!document.querySelector('#print').disabled")
            page.locator('#print').click()
            page.wait_for_function("typeof window.completePrint === 'function'")
            state['root'] = next_root
            page.evaluate('navigator.serviceWorker.getRegistration().then(registration => registration.update())')
            page.wait_for_function("!document.querySelector('#app-update').hidden", timeout=30000)
            assert page.locator('#load-update').is_disabled()
            assert page.locator('#check-update').is_disabled()
            assert page.locator('#label-text').input_value() == 'garaż 1'
            assert page.locator('meta[name=labeler-build]').get_attribute('content') == build
            checks.append('A background update does not reload or interrupt a print; update controls remain disabled')
            page.evaluate('window.completePrint()')
            page.wait_for_function("document.querySelector('#print-status').textContent.startsWith('Printed.')")
            page.locator('#load-update').click()
            page.wait_for_function("document.querySelector('meta[name=labeler-build]').content === '" + next_build + "'")
            page.wait_for_function("document.querySelector('#print-status').textContent.includes('Make a label')")
            assert page.locator('#app-version').inner_text() == 'Build ' + next_build[:8]
            assert page.locator('#length').input_value() == '45'
            checks.append('Explicit update loads the next release after printing and retains settings')
            page.context.set_offline(True)
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function("document.querySelector('#print-status').textContent.includes('Make a label')")
            page.locator('[data-example="garaż 1"]').click()
            page.wait_for_function("!document.querySelector('#download').disabled")
            assert not errors, errors
            checks.append('The upgraded release still renders offline')
            print(json.dumps({'checks': checks, 'page_errors': errors}, indent=2))
finally:
    server.shutdown()
