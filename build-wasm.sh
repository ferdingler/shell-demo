#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${WASI_SDK_PATH:?Set WASI_SDK_PATH to a wasi-sdk >= 32 installation}"
export CC_wasm32_wasip2="$WASI_SDK_PATH/bin/clang"
export AR_wasm32_wasip2="$WASI_SDK_PATH/bin/ar"
export CFLAGS_wasm32_wasip2="--sysroot=$WASI_SDK_PATH/share/wasi-sysroot"
cargo build --locked --target wasm32-wasip2 --release
npx --no-install jco transpile target/wasm32-wasip2/release/strands_shell_demo.wasm \
  --name shell --out-dir generated --no-nodejs-compat --bindgen-enable-wasm-exnref \
  --async-mode jspi --async-wasi-imports --async-exports execute
