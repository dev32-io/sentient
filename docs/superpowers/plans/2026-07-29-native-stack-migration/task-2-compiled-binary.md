### Task 2: Compiled binary — asset resolution + build script

**Wave 1 · model: opus · spec §5**

**Files:**
- Create: `gateway/src/config/asset-root.ts`
- Create: `gateway/src/config/asset-root.test.ts`
- Modify: `gateway/src/profile-store/profile-renderer.ts` (and every other module-scope asset read found in Step 1)
- Create: `scripts/build-gateway.sh`

**Interfaces:**

Produces:
```ts
/** Absolute path to the directory holding templates/, system_prompts/, persona.md, webui/.
 *  Throws with an actionable message if it cannot be resolved — never returns a bogus path. */
export function resolveAssetRoot(): string;
export function assetPath(...segments: string[]): string;
```

**Why this task exists.** `bun build --compile` already works on this gateway (verified: 959 modules, one ~65 MB executable, and it does *not* need the `--external cpu-features --external ssh2` flags the Dockerfile carries). The single portability defect is module-scope `readFileSync` resolving against `import.meta.dir`, which inside a compiled binary points at the embedded `/$bunfs/root`. `profile-renderer.ts` computes:

```ts
const GATEWAY_ROOT = process.env.GATEWAY_RUNTIME_DIR ?? join(import.meta.dir, "..", "..");
```

With `GATEWAY_RUNTIME_DIR` unset in a compiled binary that yields `/`, and boot dies at:
```
ENOENT: no such file or directory, open '/templates/profile/hermes-config.yaml.tmpl'
```
The env var fixes it — but the failure is silent-until-boot and each new module-scope read reintroduces it. One shared helper that **fails loudly** removes the whole class.

---

- [ ] **Step 1: Find every module-scope asset read**

```bash
grep -rn "import.meta.dir" gateway/src --include="*.ts" | grep -v "\.test\."
grep -rn "readFileSync" gateway/src --include="*.ts" | grep -v "\.test\."
```
Record the full list — every hit that runs at module scope must route through the helper. Known: `profile-store/profile-renderer.ts`. Expect others under `system_prompts` / persona / template loading.

- [ ] **Step 2: Write the failing test**

Create `gateway/src/config/asset-root.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { assetPath, resolveAssetRoot } from "./asset-root.js";

describe("asset-root", () => {
  it("CONTRACT: honours GATEWAY_RUNTIME_DIR when set", () => {
    const prev = process.env.GATEWAY_RUNTIME_DIR;
    process.env.GATEWAY_RUNTIME_DIR = "/tmp/sentient-assets-fixture";
    try {
      expect(resolveAssetRoot()).toBe("/tmp/sentient-assets-fixture");
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_RUNTIME_DIR;
      else process.env.GATEWAY_RUNTIME_DIR = prev;
    }
  });

  it("INVARIANT: throws an actionable error instead of returning a bogus root", () => {
    const prev = process.env.GATEWAY_RUNTIME_DIR;
    process.env.GATEWAY_RUNTIME_DIR = "/definitely/not/a/real/asset/root";
    try {
      expect(() => assetPath("templates")).toThrow(/GATEWAY_RUNTIME_DIR/);
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_RUNTIME_DIR;
      else process.env.GATEWAY_RUNTIME_DIR = prev;
    }
  });

  it("resolves a real asset that ships with the repo", () => {
    expect(existsSync(assetPath("templates"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
cd gateway/src && bun test config/asset-root.test.ts
```
Expected: FAIL — `Cannot find module './asset-root.js'`.

- [ ] **Step 4: Implement the helper**

Create `gateway/src/config/asset-root.ts`:

```ts
// Resolves the runtime asset root (templates/, system_prompts/, persona.md, webui/).
//
// Two shapes must both work:
//   repo checkout   — assets sit at <repo>/gateway/, reachable from import.meta.dir
//   compiled binary — import.meta.dir is the embedded /$bunfs/root, which contains
//                     NO assets, so GATEWAY_RUNTIME_DIR must point at the unpacked
//                     share/ dir beside the executable.
//
// A wrong root previously surfaced as `ENOENT ... '/templates/profile/...'` at boot,
// which names neither the cause nor the fix. This module fails loudly instead.
import { existsSync } from "node:fs";
import { join } from "node:path";

const SENTINEL = "templates";

let cached: string | null = null;

export function resolveAssetRoot(): string {
  if (cached !== null) return cached;
  const fromEnv = process.env.GATEWAY_RUNTIME_DIR;
  cached = fromEnv && fromEnv.length > 0 ? fromEnv : join(import.meta.dir, "..", "..");
  return cached;
}

export function assetPath(...segments: string[]): string {
  const root = resolveAssetRoot();
  if (!existsSync(join(root, SENTINEL))) {
    throw new Error(
      `asset root has no ${SENTINEL}/ directory: ${root}. ` +
        `Set GATEWAY_RUNTIME_DIR to the directory containing templates/, system_prompts/, ` +
        `persona.md and webui/. In a compiled binary this MUST be set — import.meta.dir ` +
        `points at the embedded bundle, which carries no assets.`,
    );
  }
  return join(root, ...segments);
}

/** Test-only: clears the memoised root. */
export function resetAssetRootForTest(): void {
  cached = null;
}
```

Note: the memo must be cleared between the tests above — add `resetAssetRootForTest()` calls in each test's setup.

- [ ] **Step 5: Run to green**

```bash
cd gateway/src && bun test config/asset-root.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Route every module-scope read through the helper**

For each hit from Step 1, replace the ad-hoc root computation. In `profile-store/profile-renderer.ts`:

```ts
// before
const GATEWAY_ROOT = process.env.GATEWAY_RUNTIME_DIR ?? join(import.meta.dir, "..", "..");
const TMPL_DIR = join(GATEWAY_ROOT, "templates", "profile");
const HERMES_CONFIG_TMPL = readFileSync(join(TMPL_DIR, "hermes-config.yaml.tmpl"), "utf8");

// after
import { assetPath } from "../config/asset-root.js";
const HERMES_CONFIG_TMPL = readFileSync(assetPath("templates", "profile", "hermes-config.yaml.tmpl"), "utf8");
```

- [ ] **Step 7: Run the full gateway suite**

```bash
cd gateway/src && bun test
bun run --filter '@sentient/gateway' typecheck
```
Expected: 1190+ pass / 0 fail; typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git commit -m "refactor(gateway): resolve runtime assets through one fail-loud helper" -- \
  gateway/src/config/asset-root.ts gateway/src/config/asset-root.test.ts \
  gateway/src/profile-store/profile-renderer.ts
```

- [ ] **Step 9: Read the existing build-script conventions**

```bash
sed -n '1,60p' scripts/build-android.sh
```
Match its flag style (`--release`, `--deploy`), its `set -euo pipefail` discipline, and its error messages. Do not invent a new convention.

- [ ] **Step 10: Write `scripts/build-gateway.sh`**

A shell script has no meaningful unit test — do not invent one. Its correctness is proven by Step 11's smoke check, which is part of the script itself.

```bash
#!/usr/bin/env bash
# Build the gateway as a standalone native executable plus its runtime assets.
#
#   ./scripts/build-gateway.sh              debug   (sourcemaps, no minify)
#   ./scripts/build-gateway.sh --release    release (minified + bytecode)
#
# Output: dist/gateway/<version>/{bin/sentient-gateway, share/...} plus a
# tarball and a sha256 the installer verifies.
#
# Both dev Mac and mini are arm64 macOS, so there is no cross-compilation.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

PROFILE="debug"
[ "${1:-}" = "--release" ] && PROFILE="release"

VERSION="$(node -p "require('./gateway/package.json').version")"
OUT="$REPO/dist/gateway/$VERSION"
rm -rf "$OUT"; mkdir -p "$OUT/bin" "$OUT/share"

echo "==> building webui"
( cd gateway/webui && bun run build )

echo "==> compiling gateway ($PROFILE)"
if [ "$PROFILE" = "release" ]; then
  # --bytecode moves parse/transpile cost to build time, cutting startup.
  ( cd gateway && bun build src/main.ts --compile --minify --bytecode \
      --outfile "$OUT/bin/sentient-gateway" )
else
  ( cd gateway && bun build src/main.ts --compile --sourcemap=inline \
      --outfile "$OUT/bin/sentient-gateway" )
fi

echo "==> staging runtime assets"
cp -R gateway/templates       "$OUT/share/templates"
cp -R gateway/system_prompts  "$OUT/share/system_prompts"
cp    gateway/persona.md      "$OUT/share/persona.md"
cp -R gateway/webui/dist      "$OUT/share/webui"

echo "==> smoke: assets must resolve from the compiled binary"
# A deliberately-absent config path. The binary must get PAST asset loading and
# fail at CONFIG loading. If GATEWAY_RUNTIME_DIR were wrong it would fail EARLIER
# with ENOENT on a template — that distinction is the whole regression guard.
set +e
SMOKE="$(GATEWAY_RUNTIME_DIR="$OUT/share" GATEWAY_CONFIG_PATH=/nonexistent/config.yaml \
  "$OUT/bin/sentient-gateway" 2>&1)"
set -e
if echo "$SMOKE" | grep -q "templates/profile"; then
  echo "FAIL: binary could not resolve assets (GATEWAY_RUNTIME_DIR handling is broken)" >&2
  echo "$SMOKE" | tail -5 >&2
  exit 1
fi
if ! echo "$SMOKE" | grep -q "loadGatewayConfig"; then
  echo "FAIL: binary did not reach config loading; unexpected early failure" >&2
  echo "$SMOKE" | tail -5 >&2
  exit 1
fi
echo "    ok — reached config loading, assets resolved"

echo "==> packaging"
tar -czf "$OUT.tar.gz" -C "$REPO/dist/gateway" "$VERSION"
shasum -a 256 "$OUT.tar.gz" > "$OUT.tar.gz.sha256"
echo "✓ $OUT.tar.gz"
cat "$OUT.tar.gz.sha256"
```

- [ ] **Step 11: Run both variants**

```bash
chmod +x scripts/build-gateway.sh
./scripts/build-gateway.sh
./scripts/build-gateway.sh --release
```
Expected for each: `ok — reached config loading, assets resolved`, then a tarball path and its sha256. The release binary should be materially smaller than the debug one — record both sizes in your report.

- [ ] **Step 12: Commit**

```bash
git commit -m "feat(build): compile the gateway to a standalone binary with staged assets" -- \
  scripts/build-gateway.sh
```
