#!/usr/bin/env bash
set -euo pipefail

readonly RIVE_CLI_REPOSITORY="https://github.com/George-RD/rive-rs-cli.git"
readonly RIVE_CLI_COMMIT="cc10173318409571926f6d1d37c796f52e5232e2"
readonly RIVE_CLI_CARGO_LOCK_SHA256="30566259e6f2d6c49d572c34b849f98bb7334ac25b45c397dc9bc2a36e710528"
readonly RUST_TOOLCHAIN="1.98.0"
readonly CHECKOUT="${SENTIENT_RIVE_CLI_CHECKOUT:-/tmp/sentient-rive-cli}"
readonly BINARY="${SENTIENT_RIVE_CLI:-$CHECKOUT/target/release/rive-cli}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "sha256sum, shasum, or openssl is required" >&2
    exit 1
  fi
}

if [[ ! -d "$CHECKOUT/.git" ]]; then
  rm -rf "$CHECKOUT"
  git init -q "$CHECKOUT"
  git -C "$CHECKOUT" remote add origin "$RIVE_CLI_REPOSITORY"
fi

actual_commit="$(git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null || true)"
if [[ "$actual_commit" != "$RIVE_CLI_COMMIT" ]]; then
  git -C "$CHECKOUT" fetch --depth 1 origin "$RIVE_CLI_COMMIT"
  git -C "$CHECKOUT" checkout --detach --force FETCH_HEAD
fi
actual_commit="$(git -C "$CHECKOUT" rev-parse HEAD)"
if [[ "$actual_commit" != "$RIVE_CLI_COMMIT" ]]; then
  echo "rive-cli checkout mismatch: expected $RIVE_CLI_COMMIT, got $actual_commit" >&2
  exit 1
fi
if ! git -C "$CHECKOUT" diff --quiet HEAD --; then
  echo "rive-cli checkout has modified tracked files; refusing an unreviewed build" >&2
  exit 1
fi

actual_lock_sha="$(sha256 "$CHECKOUT/Cargo.lock")"
if [[ "$actual_lock_sha" != "$RIVE_CLI_CARGO_LOCK_SHA256" ]]; then
  echo "rive-cli Cargo.lock mismatch: expected $RIVE_CLI_CARGO_LOCK_SHA256, got $actual_lock_sha" >&2
  exit 1
fi

if [[ -n "${SENTIENT_RIVE_CLI:-}" && ! -x "$BINARY" ]]; then
  echo "SENTIENT_RIVE_CLI is not executable: $BINARY" >&2
  exit 1
fi

if [[ -z "${SENTIENT_RIVE_CLI:-}" ]]; then
  if command -v brew >/dev/null 2>&1; then
    rustup_prefix="$(brew --prefix rustup 2>/dev/null || true)"
    if [[ -n "$rustup_prefix" ]]; then
      export PATH="$rustup_prefix/bin:$PATH"
    fi
  fi
  if ! command -v rustup >/dev/null 2>&1; then
    echo "rustup is required to build rive-cli with pinned Rust $RUST_TOOLCHAIN" >&2
    echo "Install it with: brew install rustup" >&2
    exit 1
  fi
  rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal >&2
  rustup run "$RUST_TOOLCHAIN" cargo build --release --locked --manifest-path "$CHECKOUT/Cargo.toml" >&2
fi

if [[ ! -x "$BINARY" ]]; then
  echo "rive-cli build did not produce an executable: $BINARY" >&2
  exit 1
fi

"$BINARY" --version >&2
printf '%s\n' "$BINARY"
