#!/usr/bin/env bash
# Regression check for clean harness shells using the repository environment.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${HOME:?HOME must be set}"

exec env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  /bin/bash -c '
    set -e
    cd "$1"
    source scripts/env.sh
    test "$(java -version 2>&1 | head -1)" != ""
    ./gradlew --version | grep -E "Launcher JVM:.*21"
    ./gradlew --version | grep -E "Daemon JVM:.*21"
  ' bash "$ROOT_DIR"
