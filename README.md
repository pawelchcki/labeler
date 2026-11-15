# Labeler

Labels for the Fichero / AiYin D11s printer, on Android and in your browser. Rust owns text shaping/rasterization, maximum-fit typography, cable geometry, bitmap packing and the printer command sequence. Android uses the engine through JNI; the website compiles the same code to WebAssembly. No account, API key or cloud rendering.

**[Open Labeler online](https://pawelchcki.github.io/labeler/)** · [Source](https://github.com/pawelchcki/labeler)

## Web app

Open the website, type your text, choose Large label or Cable wrap, and connect the printer using the browser's Bluetooth chooser. Review the exact raster preview, then press Print. Stock length, feed trim, cable presets, measured diameter, ink density and 1–10 copies are supported. Save image downloads the preview as a PNG.

Direct printing uses [Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth), which requires HTTPS and a supported browser: Chrome on Android, macOS or Windows. Safari and Firefox can preview and save labels but cannot connect a Bluetooth printer. Close other printer apps before connecting. Keep the page visible until the printer confirms completion.

Your label text and raster stay on your device. GitHub Pages serves the static app; no label content is uploaded. After the first successful load, the service worker caches the app and WebAssembly engine for offline use. Settings are saved locally; label text is not saved. An interrupted print remains marked as uncertain in that tab until you confirm you have checked the physical label. The page never resumes or automatically retries an interrupted job.

The browser transport sends at most 200 bytes per BLE write with 20 ms pacing, following the tested upstream driver. Browsers manage MTU negotiation; unlike Android, Web Bluetooth does not expose an MTU or connection-priority API.

### Build and test the website

Requirements: Rust stable, Python 3 and Node.js 22+.

```sh
rustup target add wasm32-unknown-unknown
sh scripts/build-web.sh
cargo test --locked --manifest-path core/Cargo.toml
cargo build --locked --manifest-path core/Cargo.toml --examples
node --test tests/*.test.mjs
python3 -m http.server 8080 --directory web
```

Open `http://localhost:8080`. The generated WASM and service worker are ignored by Git and rebuilt in CI. The GitHub Actions workflow tests native/WASM output parity, exercises browser transport against the independent Rust printer emulator, and deploys `web/` to GitHub Pages after a successful push to `main`. Browser UI checks can be run with `uv run --no-project --with invisible-playwright==0.44.1 python tests/browser_qa.py web` on Linux.

Only the static `web/` directory is published to Pages. Android signing keys, local configuration, build output and release binaries are excluded from the repository. Existing third-party font and Gradle wrapper licenses are included alongside those assets.

## Use

Install the debug APK on an arm64 Android 12+ phone. Grant Nearby devices, switch on the printer, and choose it once. Enter text and select Large label or Cable wrap. The preview shows the actual raster sent to the printer. Large mode chooses the biggest fitting font and up to four lines. Cable mode repeats text across the wrap, so it reads along the cable.

Default stock is 30 × 14 mm, 96-dot / 12 mm printable width, 203 DPI. The calibrated 3 mm feed trim sends 27 mm of image; 0.75 mm ink margins protect the ends. Adjust stock length and trim under Label size & alignment. These defaults come from physical printer tests. Android printing was confirmed on the Xiaomi phone after the BLE transfer update on 2026-11-15; see [VALIDATION.md](VALIDATION.md).

Cable diameter estimates: Cat6a 7.5 mm, Cat6 6.2 mm, Cat5e 5.2 mm, HDMI 7 mm, USB 4 mm, USB-C 4.5 mm, power 7 mm. These are starting assumptions, not dimensions specified by the connector or cable standard. Enter the measured jacket diameter for reliable geometry. The engine calculates circumference and overlap; it suggests longer stock or a flag if the selected stock is too short. Label adhesive and flexibility also affect whether a wrap stays attached.

## Assistant actions

On Android 16+, the app exposes `previewLabel` and `printLabel` via Jetpack AppFunctions. Preview returns fitted dimensions, repeat count and placement tips. Print takes exact text, a stable request ID, mode, cable preset, measured diameter and copies. Android supplies caller authorization through the signature-protected AppFunction service. Bluetooth selection and permissions must be completed once in the app.

Example requests: “Print mikuś 195m in the largest size”, “Print garaż 2 for a Cat6a cable”, “Use my measured 8 mm HDMI cable”. KDoc tells agents not to silently correct spelling, to use the same request ID on retries, and to explain fit warnings. The app persists job outcomes; an uncertain job is not automatically printed twice. Printed means acknowledged by the printer, not visual proof of placement.

**Gemini access:** Implementing AppFunctions does not make Labeler available in Gemini. Google documents a private preview with selected apps/agents and an [Early Access Program interest form](https://forms.gle/GN5ybjQFhzHRCguM7); submitting the form does not grant access automatically. Obtain the required access before following [Connected Console registration](docs/gemini/README.md). A Play developer account, bundle upload, or EXECUTE_APP_FUNCTIONS permission does not bypass this gate. Source: https://developer.android.com/ai/appfunctions .

Always available: share plain text to Labeler, or open a deep link. External links populate a preview; they never silently consume labels:

```
adb shell am start -a android.intent.action.VIEW -d 'labeler://print?text=gara%C5%BC%202&mode=wrap&cable=cat6a&diameter_mm=7.5'
```

## Build

Requirements: JDK 21, Android SDK platform `platforms;android-37.0` and build tools 37.0.0, NDK 27.2.12479018, Rust stable with `aarch64-linux-android` target. Set ANDROID_HOME and JAVA_HOME, and put cargo on PATH. Gradle calls `scripts/build-rust.sh` automatically. The Gradle wrapper originates from Google's Apache-2.0 AppFunctions sample (https://github.com/android/appfunctions).

```
rustup target add aarch64-linux-android
cargo test --manifest-path core/Cargo.toml
./gradlew assembleDebug
adb install --no-streaming -r app/build/outputs/apk/debug/app-debug.apk
```

Only arm64 is packaged initially. Noto Sans is bundled under the SIL Open Font License (core/assets/OFL.txt). This supports Polish accents; unsupported glyphs (including emoji) return a useful error instead of printing squares.

## On-device checks

1. Grant/deny Bluetooth permissions; disable Bluetooth; scan with printer off; reconnect after power cycling.
2. Compare preview with “garaż 1”, “mikuś 195m” and a long camera name. Check no clipping and adjust trim for your roll.
3. Print a flat label, a Cat6a wrap, then a measured HDMI wrap. Verify gap alignment, accents, repeat spacing, out-of-paper and cover-open messages.
4. Interrupt a print after transmission. Check physical output before requesting another copy. Reusing the same assistant request ID must not duplicate it.
5. On Android 16+, check generated AppFunctions metadata and invoke both functions with Google's testing agent. Gemini requires Connected Console registration and tester enrollment.


## D11s device emulator and differential validation

`core/src/emulator.rs` is a deterministic **printer protocol emulator**, not an Android emulator or BLE radio simulator. It consumes fragmented UART bytes, validates wake/enable/raster/feed/stop ordering, simulates sensors and replies, and captures exact bitmap bytes and feed counts. `core/examples/device_emulator.rs` exposes newline-delimited JSON over stdin/stdout. This never connects to a physical printer.

`tools/differential.py` runs the actual upstream `fichero.printer.PrinterClient` and `fichero.cli.do_print` through a Bleak-compatible adapter into that emulator. A second instance is driven by Rust protocol steps. It compares captured raster bytes, polarity and threshold boundaries, little-endian row counts, density, paper mode, copies, feeds and normalized command traces. The packer being tested is also used by the production Rust renderer. Cases include 1-byte fragmentation, split notifications, busy status, sensor faults and a lost stop acknowledgement.

Typography is deliberately **not** pixel-identical to Pillow's default font: the new fitter uses bundled Noto Sans and measures ink bounds. Generated Rust text and wrap rasters are nevertheless sent through both print pipelines and compared byte-for-byte at the simulated printhead. This validates the printer-facing result, not physical label registration, heat, real GATT timing or an actual phone's Bluetooth stack.

Documented safety differences from upstream: Rust checks status before settings, confirms setting acknowledgements, waits for busy to clear, and may repeat density setup per copy. Upstream ignores a rejected density setting; a dedicated test demonstrates that Rust stops instead. Raw command streams therefore differ in these specific cases; raster output and feed behavior are equivalent for accepted jobs.

```
cargo test --manifest-path core/Cargo.toml
cargo build --manifest-path core/Cargo.toml --examples
uv run tools/differential.py --python-reference /path/to/fichero-printer
```

The Python oracle is external and unmodified; pass the checkout path explicitly. Tests virtualize only wall-clock delays and transport, not upstream command or bitmap logic. The emulator also has literal byte-vector tests independent of the Rust production generator, so tests are not solely self-comparisons.

Latest results and explicit limits: [VALIDATION.md](VALIDATION.md).


### Xiaomi installation note

The earlier development app was installed on the connected Xiaomi 17T Pro using ADB's non-streaming method after streamed installs returned `INSTALL_FAILED_USER_RESTRICTED`. Prefer `adb install --no-streaming -r dist/labeler-debug.apk` on this phone, with its explicit serial and the ADB server that owns the USB connection.

Labeler uses application ID `net.chcki.labeler`. Android treats it as a separate app from the earlier `dev.pawel.actionprinter` build, so choose the Bluetooth printer and grant Nearby devices again after installing Labeler. The repository remains in `~/startup/action-printer`.


## Play upload bundle

Create a local upload key once with `python3 scripts/init-upload-key.py`, then run `./gradlew bundleRelease`. Signing material stays in ignored `.signing/` with private file permissions; back it up securely. Release packaging requires that key. The Rust build supports 16 KB memory pages with explicit NDK linker flags. Console assets and registration instructions are in [docs/gemini](docs/gemini/README.md).

### Play crash-reporting warnings

R8 is disabled, so this release has no obfuscation mapping file. The corresponding Play warning needs no mapping upload. Release builds pin the installed NDK and request SYMBOL_TABLE native debug metadata; new AABs include Rust function symbols automatically.

For the already-uploaded version 1, upload dist/labeler-v1-native-debug-symbols.zip under Play Console → Test and release → App bundle explorer → version 1 → Downloads → Assets → Native debug symbols. This archive contains the exact unstripped library extracted from the previous version 1 AAB. It provides function names, not source-file/line information. Source artifact hashes are recorded in docs/validation/native-symbols.json. Manual upload instructions: https://support.google.com/googleplay/android-developer/answer/9848633 .
