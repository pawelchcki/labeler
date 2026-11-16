"""UI checks using invisible-playwright on Linux; never connects real hardware."""
import functools
import http.server
import json
import pathlib
import sys
import threading
from invisible_playwright import InvisiblePlaywright

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'web/build').resolve()
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
    const response = hex === '10ff20f0' ? Array.from(new TextEncoder().encode('D11s')) : hex === '10ff20f1' ? Array.from(new TextEncoder().encode('2.4.9')) : hex === '10ff20ef' ? Array.from(new TextEncoder().encode('V1.00')) : hex === '10ff20f2' ? Array.from(new TextEncoder().encode('QA-D11S')) : hex === '10ff50f1' ? [0,85] : hex === '10ff40' ? [0] : (hex.startsWith('10ff10') || hex.startsWith('10ff84')) ? [79, 75] : hex === '10fffe45' && !window.loseAck ? [170] : null;
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
        original = page.locator('#label-preview').evaluate("canvas => canvas.toDataURL()")
        for font, name in [('sans-bold', 'Sans bold'), ('mono', 'Mono'), ('serif', 'Serif')]:
            page.locator('#font').select_option(font)
            page.wait_for_function("!document.querySelector('#download').disabled && document.querySelector('#preview-dimensions').textContent.includes(" + json.dumps(name) + ")")
            assert page.locator('#label-preview').evaluate("canvas => canvas.toDataURL()") != original
        page.locator('#font-sizing').select_option('custom')
        page.wait_for_function("!document.querySelector('#font-size-field').hidden")
        page.locator('#font-size').fill('24')
        page.wait_for_function("!document.querySelector('#download').disabled && document.querySelector('#preview-dimensions').textContent.includes('24 px fixed')")
        page.locator('.alignment-picker label').nth(2).click()
        page.wait_for_function("!document.querySelector('#download').disabled && JSON.parse(localStorage.getItem('labeler.settings.v1')).align === 'right'")
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function("document.querySelector('#print-status').textContent.includes('Make a label')")
        assert page.locator('#font').input_value() == 'serif'
        assert page.locator('#font-sizing').input_value() == 'custom'
        assert page.locator('#font-size').input_value() == '24'
        assert page.locator('input[name=align][value=right]').is_checked()
        page.locator('[data-example="garaż 1"]').click()
        page.locator('#font-size').fill('160')
        page.wait_for_function("!document.querySelector('#editor-error').hidden")
        assert 'does not fit' in page.locator('#editor-error').inner_text()
        assert page.locator('#download').is_disabled()
        page.locator('#font-sizing').select_option('auto')
        page.locator('#font').select_option('sans')
        page.locator('.alignment-picker label').nth(1).click()
        page.wait_for_function("!document.querySelector('#download').disabled")
        results.append('PASS: four distinct fonts, exact fixed size, overflow rejection, alignment and saved settings')
        page.screenshot(path='/tmp/labeler-desktop.png', full_page=True)
        with page.expect_download() as download:
            page.locator('#download').click()
        assert download.value.suggested_filename == 'labeler-label.png'
        page.locator('[data-example="USB-C"]').click()
        page.wait_for_function("!document.querySelector('#download').disabled && !document.querySelector('#cable-fields').hidden")
        assert page.locator('#label-preview').get_attribute('width') == '96'
        assert page.locator('#cable').input_value() == 'usb-c'
        for example, circumference in [('usb', '14.1 mm'), ('network', '23.6 mm'), ('hdmi', '31.4 mm')]:
            page.locator('[data-wrap-example="' + example + '"]').click()
            page.wait_for_function("!document.querySelector('#download').disabled && document.querySelector('#wrap-circumference').textContent === " + json.dumps(circumference))
            assert page.locator('#wrap-strip-preview').is_visible()
            assert page.locator('#wrap-fit').is_visible()
            expected_caption = page.locator('#label-text').input_value()[:11]
            assert page.locator('#wrap-cable-text').text_content() == expected_caption
            assert page.locator('[data-wrap-copy]').nth(0).text_content() == expected_caption
            if example == 'hdmi':
                assert 'does-not-fit' in page.locator('#wrap-fit').get_attribute('class')
                assert '33.5 mm' in page.locator('#wrap-fit-message').inner_text()
            else:
                assert 'does-not-fit' not in page.locator('#wrap-fit').get_attribute('class')
        page.screenshot(path='/tmp/labeler-wrap-guide.png', full_page=True)
        results.append('PASS: USB-C, Cat6a and thick-HDMI examples, live repeat raster, circumference and insufficient-stock warning')
        page.locator('#label-text').fill('😀')
        page.wait_for_function("!document.querySelector('#editor-error').hidden")
        assert page.locator('#download').is_disabled()
        page.locator('#label-text').fill('')
        page.wait_for_function("!document.querySelector('#preview-empty').hidden")
        results.append('PASS: unsupported browser notice, exact preview sizes, wrap controls, unsupported glyph error, PNG download and empty state')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('[data-example="garaż 1"]').click()
        page.wait_for_function("!document.querySelector('#download').disabled")
        assert page.locator('#wrap-cable-text').text_content() == 'USB-C'
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
        page.locator('#diagnostics > summary').click()
        assert 'KiB/s' in page.locator('#stat-rate').inner_text()
        assert 'D11s' in page.locator('#device-details').inner_text()
        assert '85%' in page.locator('#device-details').inner_text()
        assert '200 B' in page.locator('#stat-pacing').inner_text()
        page.locator('#gentle-pacing').check()
        assert '100 B' in page.locator('#stat-pacing').inner_text()
        page.locator('#check-health').click()
        page.wait_for_function("document.querySelector('#print-status').textContent === 'Printer health checked.'")
        with page.expect_download() as report:
            page.locator('#export-diagnostics').click()
        assert report.value.suggested_filename == 'labeler-diagnostics.json'
        page.locator('.firmware-panel > summary').click()
        assert page.locator('#flash-firmware').is_disabled()
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path='/tmp/labeler-diagnostics-mobile.png',full_page=True)
        results.append('PASS: live diagnostics, device identity/battery, gentle pacing, health probe, JSON export, gated firmware controls and mobile layout')

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
