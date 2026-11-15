#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK}"
NDK_ROOT=${ANDROID_NDK_HOME:-"$ANDROID_HOME/ndk/27.2.12479018"}
case "$(uname -s)" in Darwin) NDK_HOST=darwin-x86_64;; Linux) NDK_HOST=linux-x86_64;; *) echo 'Build on macOS or Linux'; exit 1;; esac
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK_ROOT/toolchains/llvm/prebuilt/$NDK_HOST/bin/aarch64-linux-android31-clang"
# NDK r27 needs both flags for 16 KB ELF and RELRO alignment.
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="${CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384"
cargo build --manifest-path core/Cargo.toml --locked --release --target aarch64-linux-android
mkdir -p app/src/main/jniLibs/arm64-v8a
cp core/target/aarch64-linux-android/release/libaction_printer_core.so app/src/main/jniLibs/arm64-v8a/
