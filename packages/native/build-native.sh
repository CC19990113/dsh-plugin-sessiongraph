#!/usr/bin/env bash
# Build the napi-rs kernel and drop it beside the loader, under the name
# `packages/native/src/index.ts` probes: sessiongraph-core.<platform>-<arch>.node
#
# Run from anywhere; the script resolves the repo layout from its own location.
#
# Toolchain: this machine's default rustup toolchain is `stable-x86_64-apple-darwin` running under
# Rosetta, while the host and Node are arm64 — an x86_64 `.node` fails to load in an arm64 Node with
# "incompatible architecture". When the host architecture has a matching installed toolchain, this
# script selects it via RUSTUP_TOOLCHAIN and then refuses to copy a binary whose architecture does
# not match the host.
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

host_arch="$(uname -m)"
case "$host_arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *)
    echo "build-native: unsupported architecture $host_arch" >&2
    exit 1
    ;;
esac

# Prefer the toolchain whose architecture matches the host, when rustup has it installed.
if [ -z "${RUSTUP_TOOLCHAIN:-}" ] && command -v rustup >/dev/null 2>&1; then
  native_toolchain="stable-$host_arch-apple-darwin"
  if rustup toolchain list 2>/dev/null | sed 's/ .*//' | grep -qx "$native_toolchain"; then
    export RUSTUP_TOOLCHAIN="$native_toolchain"
    echo "build-native: using toolchain $native_toolchain (host $host_arch)"
  else
    echo "build-native: warning: $native_toolchain is not installed; the default toolchain may produce a binary this Node cannot load" >&2
    echo "build-native:          rustup toolchain install $native_toolchain" >&2
  fi
fi

echo "build-native: cargo build --release ($crate)"
(cd "$crate" && cargo build --release)

source_file="$crate/target/release/$lib"
if [ ! -f "$source_file" ]; then
  echo "build-native: expected $source_file; check [lib] crate-type = [\"cdylib\"]" >&2
  exit 1
fi

# A cdylib built for the wrong architecture is the one failure that looks like success: cargo says
# "Finished", the file exists, and Node then refuses to load it.
if command -v file >/dev/null 2>&1 && ! file "$source_file" | grep -qw "$host_arch"; then
  echo "build-native: $source_file is not built for $host_arch:" >&2
  file "$source_file" >&2
  exit 1
fi

destination="$here/sessiongraph-core.$platform-$arch.node"
cp "$source_file" "$destination"
echo "build-native: wrote $destination ($(wc -c < "$destination" | tr -d ' ') bytes)"
