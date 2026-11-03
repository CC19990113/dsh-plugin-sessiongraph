#!/usr/bin/env bash
# Build the napi-rs kernel and drop it beside the loader, under the name
# `packages/native/src/index.ts` probes: sessiongraph-core.<platform>-<arch>.node
#
# Run from anywhere; the script resolves the repo layout from its own location.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$here/../../crates/sessiongraph-core"

case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
  darwin) platform=darwin; lib=libsessiongraph_core.dylib ;;
  linux) platform=linux; lib=libsessiongraph_core.so ;;
  mingw* | msys* | cygwin*) platform=win32; lib=sessiongraph_core.dll ;;
  *)
    echo "build-native: unsupported platform $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *)
    echo "build-native: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac

echo "build-native: cargo build --release ($crate)"
(cd "$crate" && cargo build --release)

source_file="$crate/target/release/$lib"
destination="$here/sessiongraph-core.$platform-$arch.node"

if [ ! -f "$source_file" ]; then
  echo "build-native: expected $source_file; check [lib] crate-type = [\"cdylib\"]" >&2
  exit 1
fi

cp "$source_file" "$destination"
echo "build-native: wrote $destination ($(wc -c < "$destination" | tr -d ' ') bytes)"
