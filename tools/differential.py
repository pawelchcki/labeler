# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==12.1.1", "numpy==2.4.2", "bleak==2.1.1"]
# ///
"""Run the real upstream Python printer driver and Rust against the Rust D11s model.
No Bluetooth, saved credentials or physical printer is accessed.
"""
import argparse
import asyncio
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument('--python-reference', type=Path, required=True)
args, remaining = parser.parse_known_args()
sys.path.insert(0, str(args.python_reference.resolve()))
import fichero.cli as python_cli
import fichero.printer as python_printer
from fichero.imaging import prepare_image, image_to_raster
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / 'core/target/debug/examples'

class Rpc:
    def __init__(self, name):
        self.process = subprocess.Popen([str(BIN/name)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    def call(self, request):
        self.process.stdin.write(json.dumps(request)+'\n'); self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line: raise RuntimeError('Rust subprocess terminated unexpectedly')
        return json.loads(line)
    def close(self):
        self.process.stdin.close(); self.process.wait(timeout=3); self.process.stdout.close()
        if self.process.returncode: raise RuntimeError('Rust subprocess failed')

class Model:
    def __init__(self, fragment=200, **faults):
        self.rpc = Rpc('device_emulator'); self.fragment=fragment
        self.request(faults)
    def request(self, value):
        result=self.rpc.call(value)
        if not result['ok']: raise RuntimeError(result['error'])
        return result['value']
    def feed(self, data):
        replies=[]
        for offset in range(0,len(data),self.fragment):
            replies.extend(bytes.fromhex(r) for r in self.request({'feed':data[offset:offset+self.fragment].hex()})['replies'])
        return replies
    def snapshot(self): return self.request({'snapshot':True})
    def close(self): self.rpc.close()

class PythonBle:
    """Bleak-compatible edge adapter. Every received byte goes into the model."""
    def __init__(self, model, split_notifications=False):
        self.model=model; self.notify=None; self.split_notifications=split_notifications
    async def start_notify(self, uuid, callback): self.notify=callback
    async def write_gatt_char(self, uuid, data, response=False):
        if uuid != python_printer.WRITE_UUID: raise ValueError('Wrong UART write characteristic')
        for reply in self.model.feed(data):
            fragments=[bytes([b]) for b in reply] if self.split_notifications else [reply]
            for fragment in fragments: self.notify(None,bytearray(fragment))

class Differential(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.core=Rpc('rpc')
    @classmethod
    def tearDownClass(cls): cls.core.close()
    def core_call(self, request):
        value=self.core.call(request)
        if not value['ok']: raise ValueError(value['error'])
        return value
    async def python_print(self, model, image, copies=1, density=2, split=False):
        client=python_printer.PrinterClient(PythonBle(model,split))
        await client.start()
        # Only virtualize wall-clock delays, preserving all upstream command logic.
        with contextlib.ExitStack() as stack:
            for name in ('DELAY_AFTER_DENSITY','DELAY_COMMAND_GAP','DELAY_RASTER_SETTLE','DELAY_AFTER_FEED'):
                stack.enter_context(patch.object(python_cli,name,0))
            stack.enter_context(patch.object(python_printer,'DELAY_CHUNK_GAP',0))
            stack.enter_context(patch.object(python_printer,'DELAY_NOTIFY_EXTRA',0))
            with contextlib.redirect_stdout(io.StringIO()):
                return await python_cli.do_print(client,image,density=density,copies=copies,dither=False,max_rows=image.height)
    def rust_print(self, model, raster, rows, copies=1, density=2):
        steps=self.core_call({'op':'protocol','raster':raster.hex(),'rows':rows,'copies':copies,'density':density})['steps']
        for step in steps:
            data=bytes.fromhex(step['hex'])
            # Match Android's 20-byte transport, independently of model fragmentation.
            replies=[]
            for offset in range(0,len(data),20): replies.extend(model.feed(data[offset:offset+20]))
            phase=step['wait']
            if phase!='none':
                reply=b''.join(replies)
                result=self.core_call({'op':'reply','raster':reply.hex(),'mode':phase})
                if phase=='status':
                    for _ in range(30):
                        if not result['busy']: break
                        result=self.core_call({'op':'reply','raster':b''.join(model.feed(data)).hex(),'mode':'status'})
                    else: raise TimeoutError('Printer busy')
    def bitmap(self, rows, pattern):
        if pattern=='white': return Image.new('L',(96,rows),255)
        if pattern=='black': return Image.new('L',(96,rows),0)
        image=Image.new('L',(96,rows))
        image.putdata([([0,127,128,255][(x//24)%4] if pattern=='threshold' else (0 if (x*13+y*7)%19<7 else 255)) for y in range(rows) for x in range(96)])
        return image
    async def compare(self, image, copies=1, density=2, fragment=200, split=False):
        pixels=image.tobytes()
        rust_raster=bytes.fromhex(self.core_call({'op':'pack','raster':pixels.hex(),'rows':image.height})['raster'])
        python_raster=image_to_raster(prepare_image(image,max_rows=image.height,dither=False))
        self.assertEqual(rust_raster,python_raster,'Raster threshold/bit order differs from upstream')
        left,right=Model(fragment),Model(fragment)
        try:
            await self.python_print(left,image,copies,density,split)
            self.rust_print(right,rust_raster,image.height,copies,density)
            py,rs=left.snapshot(),right.snapshot()
            self.assertEqual(py['pages'],rs['pages'])
            self.assertEqual(len(rs['pages']),copies)
            self.assertEqual(py['feeds'],rs['feeds'])
            self.assertEqual(rs['feeds'],copies)
            self.assertFalse(rs['enabled']);self.assertEqual(rs['buffered'],0)
            # Status preflight order and redundant density setters intentionally differ.
            normalize=lambda commands:[c for c in commands if c!='10ff40' and not c.startswith('10ff1000')]
            self.assertEqual(normalize(py['commands']),normalize(rs['commands']))
        finally: left.close();right.close()
    async def test_pixel_polarity_threshold_rows_copies_density(self):
        count=0
        for rows in (72,216,240,480):
            for pattern in ('white','black','threshold','pattern'):
                for density in (0,1,2):
                    with self.subTest(rows=rows,pattern=pattern,density=density):
                        await self.compare(self.bitmap(rows,pattern),copies=3 if density==2 else 1,density=density)
                        count+=1
        print(f'Compared {count} independent raster/settings/copy cases.')
    async def test_arbitrary_transport_fragments_and_notifications(self):
        for fragment in (1,2,7,20,199,200,4096):
            with self.subTest(fragment=fragment):await self.compare(self.bitmap(216,'pattern'),fragment=fragment,split=True)
    async def test_real_rust_text_and_wrap_plans(self):
        for text,mode in (('mikuś 195m','large'),('garaż 1','wrap'),('kamera wschód 2','wrap')):
            plan=self.core_call({'text':text,'mode':mode,'cable':'cat6a'})
            raster=bytes.fromhex(plan['raster'])
            image=Image.frombytes('1',(96,plan['rows']),raster).convert('L').point(lambda p:255-p)
            await self.compare(image)
    async def test_sensor_faults_stop_both_before_any_paper(self):
        for fault in (2,4,16,64):
            left,right=Model(fault=fault),Model(fault=fault)
            try:
                with self.assertRaises(python_printer.PrinterNotReady):await self.python_print(left,self.bitmap(216,'pattern'))
                with self.assertRaises(ValueError):self.rust_print(right,bytes(216*12),216)
                self.assertEqual(left.snapshot()['pages'],[]);self.assertEqual(right.snapshot()['pages'],[])
                self.assertEqual(left.snapshot()['feeds'],0);self.assertEqual(right.snapshot()['feeds'],0)
            finally:left.close();right.close()
    async def test_lost_completion_ack_never_sends_next_copy(self):
        left,right=Model(lose_stop_ack=True),Model(lose_stop_ack=True)
        original=asyncio.wait_for
        async def bounded(awaitable,timeout): return await original(awaitable,min(timeout,0.02))
        try:
            with patch.object(asyncio,'wait_for',bounded):
                with self.assertRaises(python_printer.PrinterTimeout):await self.python_print(left,self.bitmap(216,'pattern'),copies=3)
            with self.assertRaises(ValueError):self.rust_print(right,bytes(216*12),216,copies=3)
            self.assertEqual(len(left.snapshot()['pages']),1);self.assertEqual(len(right.snapshot()['pages']),1)
            self.assertEqual(left.snapshot()['feeds'],right.snapshot()['feeds'])
        finally:left.close();right.close()
    async def test_rejected_settings_are_an_intentional_rust_safety_improvement(self):
        left,right=Model(reject_density=True),Model(reject_density=True)
        try:
            # Upstream do_print ignores the boolean result of set_density.
            await self.python_print(left,self.bitmap(216,'pattern'))
            with self.assertRaises(ValueError):self.rust_print(right,bytes(216*12),216)
            self.assertEqual(len(left.snapshot()['pages']),1)
            self.assertEqual(right.snapshot()['pages'],[])
        finally:left.close();right.close()
    async def test_busy_between_copies_preserves_exact_feed_count(self):
        model=Model(busy_after_stop=3)
        try:
            self.rust_print(model,bytes(216*12),216,copies=3)
            snapshot=model.snapshot()
            self.assertEqual(len(snapshot['pages']),3)
            self.assertEqual(snapshot['feeds'],3)
            self.assertEqual(snapshot['commands'].count('10ff40'),9)
        finally:model.close()
    async def test_rust_waits_for_busy_without_advancing_paper(self):
        model=Model(busy_polls=3)
        try:
            self.rust_print(model,bytes(216*12),216)
            self.assertEqual(model.snapshot()['commands'][:4],['10ff40']*4)
            self.assertEqual(model.snapshot()['feeds'],1)
        finally:model.close()

if __name__=='__main__':unittest.main(argv=[sys.argv[0],*remaining],verbosity=2)
