# Validation — 2026-11-12

Protocol safeguards, health diagnostics and firmware tools — 2026-11-16:

- Implemented shared Rust asynchronous-report framing in Android and WebAssembly transports. Fragmented `FF nn` faults and six-byte `FF 10` discard reports remain active outside command queries. Nonzero fault/discard reports latch the current job's failure, preventing later packets/copies even if a clear report follows. All-zero discard reports clear the connection latch; its fallback expiry is 60 seconds. Model identity is queried and must be D11s. Low battery now blocks printing. Completion accepts exactly `AA` or `OK`, never an arbitrary prefix with a trailing fault.
- Added website host-throughput trend, write avg/peak latency, reply timing, TX/RX counters, faults/discards/timeouts/disconnects, device identity/battery/status, idle health/wake actions, gentle pacing and a bounded in-memory protocol log with JSON export. Raster/text payloads are excluded; identifiers are included. Slow host writes increase spacing only. RSSI, negotiated browser MTU, true radio bandwidth and remote buffer occupancy are not claimed. Android exposes the corresponding host metrics and diagnostics JSON while printing.
- Added website firmware metadata/download/local-file inspection and an experimental SDK-derived flasher. The production metadata endpoint allowed `Origin: https://pawelchcki.github.io` in a direct CORS check. Binary hosting may differ. The uploader requires a verified idle D11s, screened 1–256-KiB raw D11s image, explicit exact-hardware/risk confirmation, a fresh fault-free status and at least 50% battery. It validates bootloader frames/types/checksums/challenge, sends 256-byte blocks, verifies the final additive checksum, then sends restart. It does not retry destructive commands. The connection is closed after an attempted bootloader session. Firmware flashing uses a screen wake lock when available and blocks concurrent printing/health probes/page updates.
- Firmware screening rejects the actual downloaded D11 Pro comparison image, including when its UI risk checkbox is selected. Model strings, code pointers and SHA-256 are screening/provenance aids, not vendor signature or hardware compatibility verification. No real D11s firmware was obtained and no physical flashing/recovery behavior has been tested. No firmware image or vendor decompiled source is committed.
- Checks: **13 Rust tests and 36 Node tests passed**, including native/WASM parity, fragmented/merged report framing, asynchronous heat/cover/paper/battery/discard interruption, unknown-model rejection, stalled-write/no-retry behavior, conservative slow-write pacing, and operation serialization. Firmware tests use a synthetic image and synthetic bootloader: success, challenge/type/checksum rejection, disconnect, battery/model/confirmation gates and bounded download/CORS-error handling. [Post-fix audit probe results](docs/validation/protocol-hardening-results.json) show zero further packets after injected fault/discard reports and no second copy after a merged completion/fault.
- Browser QA used an isolated local Chrome profile because the usual Linux browser host was unreachable. Simulated Bluetooth desktop/390px mobile checks passed for preview/printing, live device/transfer stats, gentle pacing, idle checks, JSON export, actual D11 Pro file rejection and absent-update/CORS handling. Offline reload also loaded the new firmware module and preserved uncertain-job tracking. No browser JavaScript errors or horizontal overflow were observed. Screenshots were inspected. Firmware hardware operation was not exercised.
- Android `assembleDebug assembleDebugAndroidTest --offline` passed. Installing/running the expanded read-only printer check was attempted, but the previously connected phone was no longer listed by ADB, so the update is built but not installed and this revision has no fresh physical-printer validation.

Firmware comparison audit — 2026-11-16:

Downloaded the official AiYin support attachment `NN0000007_D11Pro_V2.3.4_Aiyin_20240617.zip` and inspected its 107,032-byte raw ARM Thumb image with Capstone 5.0.9. Embedded identity strings identify **D11 Pro 2.3.4**, not D11s. Source URLs, hashes, command-handler addresses and limitations are recorded in [aiyin-d11pro-2.3.4-firmware-audit.json](docs/validation/aiyin-d11pro-2.3.4-firmware-audit.json). Firmware and disassembly remain under `/private/tmp/labeler-fichero-audit/firmware/`, outside the repository. Nothing was flashed or sent to the printer.

- The Fichero `public/firmware` endpoint returned success without a firmware record/download URL for the tested D11s selectors. No actual printer serial was submitted. This does not establish that a device-specific request could not return an update. No firmware download cache directory was present in the original app's external storage.
- The comparison image has the expected `10 FF` dispatcher and `FE 01` / `FE 45` handlers, plus other configuration/diagnostic families. It does not establish another mandatory startup handshake for Labeler's D11s path.
- A separate change-report routine builds a two-byte `FF nn` message and sends it independently of command replies. This supports the APK audit's finding that notification decoding must remain active during raster transfer. The firmware's sensor-bit meanings were not independently mapped.
- Receive routines use a 24,576-byte ring with bounded producers and congestion handling. This supports respecting backpressure, but its internal thresholds do not define a safe D11s BLE burst size or establish the `FF03` credit protocol on our alternate UART service.
- The parameter reader has a bounded retry loop with 2-tick waits; the tick duration is unresolved. The diagnostic `10 FF FF nn` handler transforms the byte's two nibbles into an OR/AND response, consistent with its use by the APK updater. Neither detail is evidence that normal printing needs an additional handshake.

This is a comparison-image static audit. It does not resolve the `FF 10` discard payload, prove behavior on D11s, or identify the cause of the previous physical disconnect. The client notification/fault/low-battery gaps below remain the actionable findings. No runtime behavior or deployed site was changed.

Original Fichero APK audit — 2026-11-16:

Examined the original Google Play-installed `com.lj.fichero` **1.1.18 / version code 166**, copied from the user's phone with ADB. Base and both configuration APKs verify with the same signing certificate; the Google source stamp verifies. APK hashes, signer, tool provenance and diagnostic results are recorded in [fichero-1.1.18-protocol-audit.json](docs/validation/fichero-1.1.18-protocol-audit.json). The APKs and decompiled vendor source remain outside the repository, under `/private/tmp/labeler-fichero-audit/`.

The main D11s sequence matches Labeler: a 96-dot printhead, density `10 FF 10 00 nn` (0–2), gap stock `10 FF 84 00`, twelve zero wake bytes, AiYin enable `10 FF FE 01`, uncompressed `1D 76 30 00` raster with little-endian byte width/row count and MSB-first black pixels, `1D 0C` positioning, and `10 FF FE 45` completion. The official AiYin completion filter accepts `AA` or an `OK` prefix and waits up to 60 seconds. No additional mandatory D11s startup, checksum, compression or authentication step was found in the reviewed path.

Important gaps found in Labeler at revision `1f3984561b52cac98463b819024f0c4757972fb7`:

| Priority | Gap | Evidence and consequence |
| --- | --- | --- |
| High | Unsolicited sensor reports need an always-active decoder | The APK's `AiYinUploadErrorCode` recognizes `FF nn`: bit 0 overheat, bit 1 cover open, bit 2 out of paper, bit 3 low battery. The transport dispatches these independently of pending command replies, and the print UI receives the fault. Web Labeler drops notifications when no query waiter exists; Android queues them but clears the queue before its next query. A diagnostic injected `FF 04` during raster transfer and Labeler still transmitted the second copy and reported success. |
| High | Discarding-data reports are unhandled | The APK's `BaseNormalDevice` recognizes a six-byte `FF 10 xx xx xx xx` report. Nonzero trailing bytes set a host-side discarding state with a 60-second expiry; all-zero trailing bytes clear it, and reconnect resets it. The original preflight blocks while that state is active. Labeler does not track it. Injecting `FF 10 01 00 00 00` during transfer was ignored and the second copy proceeded. The four payload bytes' numeric meaning was not established; they should not be guessed. |
| High | Merged completion and fault notifications can hide the fault | Labeler's query code concatenates notifications. The core accepts any completion buffer beginning with `AA` or `OK`. Injecting `AA` followed by `FF 04` produced `aaff04`, which was accepted as success. Stream framing and separate event dispatch are needed before completion validation. |
| Medium | Low-battery preflight does not stop printing | The original `PrinterHelper.getStatusBeforePrint` treats the one-byte status's low-battery bit `08` as a print-blocking condition. Our Rust parser returns `low_battery: true`, but both transports only inspect `busy`. The diagnostic status `08` allowed both copies. |
| Medium | Printer identity checking is broader than the supported protocol | The original catalog maps `FICHERO_5836`, `D11s_` and `MULLER_6473` to `D11s`, while other Fichero models map to different device classes and widths. Our chooser accepts any `FICHERO` prefix and does not query/validate the model. Restrict model selection and/or verify `10 FF 20 F0` before using the fixed 96-dot AiYin path. |

Reproduction: build the native examples and web engine, then run `node tools/protocol-audit-probe.mjs`. It uses the production browser transport, production WASM reply parser, the Rust printer emulator, and a fake GATT adapter. The injected report intentionally does **not** alter the emulator's sensor state, so this establishes missing client event handling, not the physical printer's behavior under a fault. The baseline completes two copies; the fault/discard/merged-ack cases also incorrectly complete two copies. These diagnostics are not passing reliability tests and are deliberately separate from the regular test suite. Runtime printing behavior was not changed by this audit.

Other audited details and limits:

- `D11s` inherits the normal AiYin path with compression and grayscale disabled by default. Extra compression, speed, heating, reverse-feed, firmware and Lujiang batch commands present elsewhere in the SDK are not evidence that the D11s needs them. The standard 30 × 14 mm gap-label sequence is correct. Black-mark and continuous-paper modes exist but are outside the current stock mode.
- The APK's BLE implementation uses service `FF00`, replies on `FF01`, writes selected by properties, and a separate `FF03` credit/MTU notification channel (`01 nn` adds credits; `02 LL HH` reports payload capacity). Its packet size is negotiated dynamically, not a fixed 200-byte constant. However, the shipped D11s/FICHERO_5836 catalog entries have BLE disabled by default, and the default transport is Classic SPP, which writes in up-to-16-KiB chunks. Remote custom configuration could affect transport selection. Labeler uses the distinct `18F0 / 2AF1 / 2AF0` UART route, which has already printed successfully; this audit does not establish that the `FF03` credit scheme is mandatory on that route. Do not copy its control traffic into the alternate UART without verifying actual hardware traces.
- Labeler's 200-byte / 20-ms BLE pacing is an independently working transport policy, not an exact copy of this version of the official app. Existing physical success does not establish buffer behavior for every long/dense/batch print.
- The official `printerWakeupLuck` sends only twelve zero bytes over an **already connected** transport. It is not a radio/power-on operation. A website can attempt a previously authorized connection and this wake-up when the printer remains Bluetooth-reachable; a fully powered-off or non-advertising printer cannot be reached this way. Current Labeler sends wake bytes during printing and still requires a manual connection. Automatic reconnection/wake was not implemented by this audit.
- JADX 1.5.6 processed 15,703 classes and reported 251 decompilation errors across the app. The reviewed D11s/AiYin, default mono raster, status and notification methods did not contain method-error markers; the AiYin error-bit mapping was also checked against JADX's fallback DEX instruction output. No claim of complete decompilation of every unrelated SDK/UI path is made.

Evidence locations in the local decompilation: `com/luckprinter/sdk_new/device/aiyin/{D11s,AiYinNormalDevice,AiYinUploadErrorCode}.java`; `device/normal/base/{BaseNormalDevice,PrinterImageProcessor}.java`; `device/PrinterHelper.java`; `device/PrinterEnum.java`; and transport classes `F/c.java`, `T3/{a,c,d,e,f,g}.java`, `V3/c.java`. The first implementation priority is notification framing and fault/discard dispatch, followed by a low-battery gate and verified model selection.

Cached-version upgrade fix — 2026-11-15:

- Confirmed the font release was deployed successfully and present in live HTML. Reproduced the reported stale controls using the original committed web app and its cache-first service worker, with a warm HTTP cache and then a newer server deployment. A fresh-browser check had missed this upgrade path.
- The deployment now uses content-versioned asset directories, network-first online navigation, a fully precached offline fallback, and cache-reloading precache requests. A footer build identifier, manual update check and explicit update banner make new releases visible. Updates never automatically navigate a page and cannot be loaded while printing.
- The upgrade browser regression (`tests/upgrade_qa.py`) passed: a versioned URL recovers the new controls from the original cached app, preferences and pending-job tracking survive, an update arriving during a simulated print does not interrupt it, the explicit update works after completion, and the upgraded release renders offline.
- Desktop/mobile, all font and wrap-example checks, simulated printing, offline reload and deployment-asset integrity checks passed against the actual `web/build/` artifact. No browser JavaScript errors occurred.

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
