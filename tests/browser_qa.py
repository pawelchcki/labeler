"""UI checks using invisible-playwright on Linux; never connects real hardware."""
import functools
import http.server
import json
import pathlib
import sys
import threading
from invisible_playwright import InvisiblePlaywright

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'web').resolve()
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(root)))
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/'

MOCK_BLUETOOTH = r"""
(() => {
  const notify = new EventTarget();
  notify.startNotifications = async () => notify;
  window.testWrites = [];
  window.loseAck = false;
  const writer = { properties: { writeWithoutResponse: true }, async writeValueWithoutResponse(bytes) {
    window.testWrites.push(Array.from(bytes));
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const response = hex === '10ff40' ? [0] : (hex.startsWith('10ff10') || hex.startsWith('10ff84')) ? [79, 75] : hex === '10fffe45' && !window.loseAck ? [170] : null;
    if (response) {
      notify.value = new DataView(Uint8Array.from(response).buffer);
      notify.dispatchEvent(new Event('characteristicvaluechanged'));
    }
  } };
  const device = new EventTarget();
  device.name = 'FICHERO_BROWSER_TEST';
  device.gatt = { connected: false, async connect() { this.connected = true; return this; }, disconnect() { this.connected = false; }, async getPrimaryService() { return { async getCharacteristic(uuid) { return uuid.startsWith('00002af1') ? writer : notify; } }; } };
  Object.defineProperty(navigator, 'bluetooth', { value: { async requestDevice() { return device; } } });
})();
"""

results = []
try:
    with InvisiblePlaywright(headless=True, timezone='Europe/Warsaw', humanize=False) as browser:
        page = browser.new_page(viewport={'width': 1365, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url, wait_until='domcontentloaded')
        page.wait_for_function("document.querySelector('#print-status').textContent.includes('Make a label')")
        assert page.locator('#browser-notice').is_visible()
        assert page.locator('#connect').is_disabled()
        page.locator('[data-example="garaż 1"]').click()
        page.wait_for_function("!document.querySelector('#download').disabled")
        page.evaluate('document.fonts.ready')
        assert page.locator('#label-text').input_value() == 'garaż 1'
        assert page.locator('#label-preview').get_attribute('width') == '216'
        assert page.locator('#label-preview').get_attribute('height') == '96'
        assert not page.locator('#label-paper').is_hidden()
        page.screenshot(path='/tmp/labeler-desktop.png', full_page=True)
        with page.expect_download() as download:
            page.locator('#download').click()
        assert download.value.suggested_filename == 'labeler-label.png'
        page.locator('[data-example="USB-C"]').click()
        page.wait_for_function("!document.querySelector('#download').disabled && !document.querySelector('#cable-fields').hidden")
        assert page.locator('#label-preview').get_attribute('width') == '96'
        assert page.locator('#cable').input_value() == 'usb-c'
        page.locator('#label-text').fill('😀')
        page.wait_for_function("!document.querySelector('#editor-error').hidden")
        assert page.locator('#download').is_disabled()
        page.locator('#label-text').fill('')
        page.wait_for_function("!document.querySelector('#preview-empty').hidden")
        results.append('PASS: unsupported browser notice, exact preview sizes, wrap controls, unsupported glyph error, PNG download and empty state')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('[data-example="garaż 1"]').click()
        page.wait_for_function("!document.querySelector('#download').disabled")
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path='/tmp/labeler-mobile.png', full_page=True)
        results.append('PASS: 390px mobile layout without horizontal overflow')
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        page.context.set_offline(True)
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function("document.querySelector('#print-status').textContent.includes('Make a label')")
        page.locator('[data-example="garaż 1"]').click()
        page.wait_for_function("!document.querySelector('#download').disabled")
        page.context.set_offline(False)
        results.append('PASS: service-worker offline reload and WebAssembly rendering')
        assert not errors, errors
        page.close()

        page = browser.new_page(viewport={'width': 1365, 'height': 1000})
        page.add_init_script(MOCK_BLUETOOTH)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url, wait_until='domcontentloaded')
        page.wait_for_function("document.querySelector('#print-status').textContent.includes('Make a label')")
        assert page.locator('#browser-notice').is_hidden()
        page.locator('[data-example="garaż 1"]').click()
        page.wait_for_function("!document.querySelector('#download').disabled")
        page.locator('#connect').click()
        page.wait_for_function("document.querySelector('#printer-name').textContent === 'FICHERO_BROWSER_TEST'")
        page.wait_for_function("!document.querySelector('#print').disabled")
        page.locator('#print').click()
        page.wait_for_function("document.querySelector('#print-status').textContent.startsWith('Printed.')")
        assert page.evaluate('testWrites.some(bytes => bytes.length === 200)')
        assert page.evaluate('testWrites.every(bytes => bytes.length <= 200)')
        assert page.locator('#uncertain-panel').is_hidden()
        results.append('PASS: connect and print UI with simulated Web Bluetooth, full raster and completion acknowledgement')
        page.evaluate("sessionStorage.setItem('labeler.pending-print.v1', 'pending')")
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function("!document.querySelector('#uncertain-panel').hidden")
        assert page.locator('#print').is_disabled()
        page.locator('#confirm-checked').click()
        assert page.locator('#uncertain-panel').is_hidden()
        results.append('PASS: uncertain job survives reload and requires explicit physical-label check')
        assert not errors, errors
        print(json.dumps({'checks': results, 'page_errors': errors, 'screenshots': ['/tmp/labeler-desktop.png', '/tmp/labeler-mobile.png']}, indent=2))
finally:
    server.shutdown()
