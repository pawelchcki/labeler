# Validation — 2026-11-12

Fonts and cable-wrap guide — 2026-11-15:

- Added bundled Noto Sans Bold, Noto Sans Mono and Noto Serif alongside the original Noto Sans. Font provenance, revision, checksums and OFL license are in `core/assets/FONTS.md`. Both native and WASM rendering use the same font bytes.
- Added optional `font`, `font_size_px` (zero for Auto fit; otherwise 6–160) and `align` fields to the shared engine. Defaults retain the original Sans / Auto fit / center layout. A fixed size that does not fit returns an error rather than silently shrinking. Web and Android controls expose these settings; Android assistant requests inherit the saved appearance settings.
- The web guide includes schematic placement diagrams, one-click USB-C / Cat6a / thick-HDMI previews, the real repeated raster, and live geometry from Rust (circumference, overlap, repeats and minimum stock length). Examples never print automatically.
- Twelve Rust tests and twelve Node tests passed, covering distinct font rasters, Polish glyphs, exact fixed size, overflow rejection, alignment, geometry and expanded native/WASM parity. `assembleDebug --offline` passed for Android.
- Browser tests passed at desktop and 390 px mobile widths with no JavaScript errors: all font choices, fixed sizing and overflow, saved alignment/settings, all three wrap examples, insufficient-stock guidance, PNG downloads, offline rendering, simulated printing and the interrupted-job guard. The Android update was built but has not been installed or physically retested in this change.

Web app — 2026-11-15:

- Compiled the existing Rust engine to WebAssembly with a small JSON ABI; no separate browser layout or protocol implementation. Native/WASM comparison passed for eight large/wrap plans, Polish text, measured geometry, minimum/maximum stock lengths, printer sequences and reply parsing. Invalid input and repeated ABI calls were also tested.
- Eight Rust tests and twelve Node tests passed. The production browser transport was driven against the independent Rust printer emulator, including byte-exact output, 200-byte GATT writes, split notifications delivered before write completion, offset DataViews, busy polling, copies, sensor faults, rejected settings, disconnects, lost completion replies and concurrent requests.
- Desktop (1365 px) and mobile (390 px) UI checks passed in Firefox on the configured Linux test host. Checks covered unsupported-browser messaging, large/wrap preview dimensions, unsupported glyph errors, PNG downloads, no horizontal overflow, offline service-worker reload, and local rendering without network access. A simulated Web Bluetooth adapter exercised the connect/print UI and the persisted uncertain-job warning. No page JavaScript errors occurred.
- Physical printing from the webpage has not yet been established. Android physical printing is confirmed separately below. The browser requests the same UART service as the tested upstream web driver and uses 200-byte writes with 20 ms pacing; its operating system manages the BLE MTU.

BLE transfer update — 2026-11-15:

- A real phone print reached raster transmission, then Android reported Bluetooth disconnection status 8. The persisted job remains uncertain; no automatic retry was sent. The logs do not establish whether the disconnect originated in printer power, radio conditions or transfer timing.
- Android now requests a larger ATT MTU and high connection priority before service discovery. UART writes use up to 200 bytes, capped by the negotiated MTU minus three bytes, with a 20-byte fallback and the existing 20 ms pacing. This matches the upstream driver's 200-byte BLE packet cap. Added protocol-step, byte-progress and failure logs without recording label text.
- `assembleDebug assembleDebugAndroidTest lintDebug --offline` passed. Updated debug APK installed on the Xiaomi phone.
- The read-only `BleConnectionSmokeTest` passed on the phone against FICHERO_5836_BLE: negotiated MTU 240, selected 200-byte packets, and received a valid printer-status response. This test sends no raster, feed or print command. Run after installing the debug and androidTest APKs with `adb -s PHONE_SERIAL shell am instrument -w net.chcki.labeler.test/net.chcki.labeler.BleConnectionSmokeTest`.
- Three subsequent user-triggered jobs transferred all 2,600 raster bytes in approximately 0.35 seconds each and reached the completion-acknowledgement step. The user confirmed printing works again. The earlier disconnect's exact cause remains unproven; the successful retest validates this phone/printer combination with the updated BLE transport.

Python reference: https://github.com/0xMH/fichero-printer at `f945a87c43240c0c8689d1cce53772f8a20073a3`. The reference checkout is external and is not edited or replaced with a mock driver.

Passed:

- Eight Rust unit tests, including independent literal command vectors, fragmented device input, illegal ordering, sensor/busy responses, margins, Polish glyphs and raster headers.
- Eight differential test groups driving separate Rust D11s emulator instances with the actual upstream Python library and the Rust implementation.
- Forty-eight raster/settings/copy combinations: 72/216/240/480 rows, blank/solid/threshold/pattern pixels, densities 0/1/2 and one/three copies.
- Packet fragmentation at 1/2/7/20/199/200/4096 bytes and split notification replies.
- Three real fitted Polish text / cable-wrap plans sent through both pipelines.
- Cover-open, out-of-paper and both overheat bits stop before feeding paper.
- Missing completion acknowledgement stops before another copy; initial busy and busy-between-copies preserve correct feed counts.
- Rejected density settings demonstrate an intentional difference: upstream ignores a false acknowledgement and continues; Rust rejects the job before sending raster data.

The raw streams intentionally differ in status preflight order and redundant density setup. Accepted jobs have matching captured raster bytes, settings and feed counts. The production renderer and the independent grayscale differential fixtures use the same Rust bit packer.

Android checks performed: debug APK assembly, Android lint (no errors), arm64 native loading on an API 36 emulator, a Polish large-label preview, and a cable-wrap deep link displaying diameter advice. Generated AppFunctions XML and its service are packaged. The API 36 emulator image did not expose AppFunctions shell execution; no successful Gemini invocation is claimed.

Not established by the protocol emulator: real BLE callback timing, heating, physical label registration, adhesion, and printing from an Android phone. Previous physical prints were made with the Python driver. Gemini requires Connected Console registration and tester enrollment. These limits are not hidden by the simulator.


Phone deployment: Action Printer was installed successfully on the connected Xiaomi 17T Pro (Android 16 / API 36) using ADB's non-streaming method. MainActivity launched successfully and its app process was running. Actual Bluetooth printing and Gemini invocation from this phone are still unverified.


Release preparation — 2026-11-12:

- `bundleRelease assembleRelease assembleDebug lintRelease` passed. Lint reported zero errors and 34 warnings (style/localization, optional platform support and dependency/target updates).
- Google's bundletool 1.18.3 `validate` accepted the AAB. Its native-library configuration is `PAGE_ALIGNMENT_16K`.
- Every one of the 85 AAB payload entries passed Java JarFile signature verification with the same locally generated upload certificate. The certificate is self-signed, as expected for an Android upload key. Jarsigner also notes AAB ZIP entry order differs from streaming JAR conventions; per-entry verification passed.
- The release APK passed `apksigner verify` and `zipalign -c -P 16 4`.
- Inspected the native ELF inside the AAB: all LOAD segment alignments are 0x4000, and the GNU_RELRO end is 16 KB aligned. A 16 KB Android runtime has not been tested.
- The generated bundle includes both previewLabel and printLabel metadata. Actual detection by Connected Console is still unverified.
- Prepared a 512 px icon, capabilities, prompts and setup guide in docs/gemini. The signed release AAB and APK plus refreshed debug APK are in dist; SHA256SUMS was regenerated.
- No upload, Connected App creation, terms acceptance, submission or release publication has occurred. Browser access and public Privacy Policy / Terms URLs are still needed. The phone has not been changed by this release preparation.


Labeler identity migration — 2026-11-13:

- Display name and Gradle project name changed to Labeler; namespace and application ID changed to net.chcki.labeler. Kotlin source directories, Rust JNI export, Android manifest, deep link (labeler://print), and Gemini metadata/prompts were updated together. Repository directory remains ~/startup/action-printer.
- bundleRelease, assembleRelease, assembleDebug, and lintRelease passed (zero lint errors; 34 warnings).
- Bundletool validated the signed AAB and confirmed manifest package net.chcki.labeler. Both generated AppFunctions IDs use net.chcki.labeler.BasePrinterFunctions. The shared library exports Java_net_chcki_labeler_NativeBridge_call.
- All 85 bundle payload entries verified against the original upload certificate; no upload key was regenerated. The release APK signature and 16 KB ZIP alignment passed, and the native library's LOAD segments remain 16 KB aligned.
- Dist contains labeler-release.aab, labeler-release.apk and labeler-debug.apk with refreshed SHA256SUMS. Obsolete Action Printer artifacts were replaced to avoid uploading the old package.
- The phone was absent from both existing ADB servers, so Labeler was not installed or tested on the phone. The new application ID creates a separate app and needs printer selection and Nearby devices permission again.
- No Play/Connected Console upload or submission occurred. Native loading through the renamed JNI binding has not yet been tested on a device.


Native crash symbols — 2026-11-13:

- Prepared dist/labeler-v1-native-debug-symbols.zip from the exact unstripped library in the previously supplied version 1 bundle. Archive bytes matched the original packaged library and contain its ELF symbol table.
- Pinned Gradle's NDK to 27.2.12479018 and set release ndk.debugSymbolLevel to SYMBOL_TABLE. bundleRelease passed, generated a .so.sym entry under BUNDLE-METADATA/com.android.tools.build.debugsymbols, and passed bundletool validation.
- The native .text section is unchanged by Gradle stripping. Refreshed the local AAB and checksums; versionCode remains 1. Existing Play uploads can receive the matching symbols ZIP separately; no console upload was performed.
- R8 remains disabled; no Java/Kotlin mapping file is generated or needed. Symbolication supplies native function names only; source line information is not provided.
