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

# TARGET_TRIPLE lets the release matrix cross-build (Intel macOS on an arm64 runner, say). When it is
# set, platform/arch come from the triple instead of the host, and cargo is told to build for it.
target="${TARGET_TRIPLE:-}"
if [ -n "$target" ]; then
  case "$target" in
    aarch64-apple-darwin) platform=darwin; arch=arm64; lib=libsessiongraph_core.dylib ;;
    x86_64-apple-darwin) platform=darwin; arch=x64; lib=libsessiongraph_core.dylib ;;
    x86_64-unknown-linux-gnu) platform=linux; arch=x64; lib=libsessiongraph_core.so ;;
    aarch64-unknown-linux-gnu) platform=linux; arch=arm64; lib=libsessiongraph_core.so ;;
    x86_64-pc-windows-msvc) platform=win32; arch=x64; lib=sessiongraph_core.dll ;;
    *) echo "build-native: unsupported target $target" >&2; exit 1 ;;
  esac
  echo "build-native: cross-building for $target"
  host_arch=""   # the architecture check below only applies to a host build
fi

if [ -z "$target" ]; then
  case "$host_arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *)
      echo "build-native: unsupported architecture $host_arch" >&2
      exit 1
      ;;
  esac
fi

# Prefer the toolchain whose architecture matches the host, when rustup has it installed. Rustup
# spells it `aarch64`, while `uname -m`/Node say `arm64`; getting this wrong silently falls back to
# the x86_64 default and produces a binary an arm64 Node cannot load.
case "$host_arch" in
  arm64 | aarch64) rust_arch=aarch64 ;;
  *) rust_arch="$host_arch" ;;
esac

# `$platform` guards the whole block: this picks a *darwin* toolchain, and on Linux it would otherwise
# build a name like `stable--apple-darwin` out of the empty `$host_arch` and warn about it.
if [ "$platform" = darwin ] && [ -z "${RUSTUP_TOOLCHAIN:-}" ] && command -v rustup >/dev/null 2>&1; then
  native_toolchain="stable-$rust_arch-apple-darwin"
  if rustup toolchain list 2>/dev/null | sed 's/ .*//' | grep -qx "$native_toolchain"; then
    export RUSTUP_TOOLCHAIN="$native_toolchain"
    echo "build-native: using toolchain $native_toolchain (host $host_arch)"
  else
    echo "build-native: warning: $native_toolchain is not installed; the default toolchain may produce a binary this Node cannot load" >&2
    echo "build-native:          rustup toolchain install $native_toolchain" >&2
  fi
fi

if [ -n "$target" ]; then
  echo "build-native: cargo build --release --target $target ($crate)"
  (cd "$crate" && cargo build --release --target "$target")
  source_file="$crate/target/$target/release/$lib"
else
  echo "build-native: cargo build --release ($crate)"
  (cd "$crate" && cargo build --release)
  source_file="$crate/target/release/$lib"
fi
if [ ! -f "$source_file" ]; then
  echo "build-native: expected $source_file; check [lib] crate-type = [\"cdylib\"]" >&2
  exit 1
fi

# A cdylib built for the wrong architecture is the one failure that looks like success: cargo says
# "Finished", the file exists, and Node then refuses to load it.
#
# `uname -m` and `file(1)` spell the same architecture differently: uname says `x86_64`, while the ELF
# magic names EM_X86_64 `x86-64` (upstream `Magdir/elf`). Compare against the file(1) spelling, or a
# plain Linux host build is rejected as a mismatch. `$host_arch` itself is left alone — it spells the
# toolchain name above, and it also warns the reader which architecture was expected.
if [ -n "$host_arch" ]; then
  case "$host_arch" in
    x86_64) file_arch=x86-64 ;;
    *) file_arch=$host_arch ;;
  esac
  if command -v file >/dev/null 2>&1 && ! file "$source_file" | grep -qw "$file_arch"; then
    echo "build-native: $source_file is not built for $host_arch:" >&2
    file "$source_file" >&2
    exit 1
  fi
fi

destination="$here/sessiongraph-core.$platform-$arch.node"
cp "$source_file" "$destination"

# Also stage into the per-platform npm package. That is the copy the release publishes, and the only
# one a user ever receives — the loader prefers the local file first so a checkout keeps working, but
# Windows/Linux/Intel users get their kernel from here.
suffix="$platform-$arch"
case "$suffix" in
  linux-x64 | linux-arm64) suffix="$suffix-gnu" ;;
  win32-x64) suffix="$suffix-msvc" ;;
esac
package_dir="$crate/npm/$suffix"
if [ -d "$package_dir" ]; then
  cp "$destination" "$package_dir/sessiongraph-core.$platform-$arch.node"
  echo "build-native: staged $package_dir/sessiongraph-core.$platform-$arch.node"
else
  echo "build-native: warning: no platform package at $package_dir (kernel will not be published for this platform)" >&2
fi

# arm64 macOS kills an unsigned Mach-O outright (SIGKILL at dlopen, not an error the loader
# reports), and copying a linker-signed binary to a new path does not preserve that signature.
# Re-sign adhoc after every copy so a freshly built kernel actually loads.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$destination" >/dev/null 2>&1 || \
    echo "build-native: warning: adhoc signing failed; the .node may be killed on load" >&2
fi

echo "build-native: wrote $destination ($(wc -c < "$destination" | tr -d ' ') bytes)"
