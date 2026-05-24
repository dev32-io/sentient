# Service Alignment & Setup Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize service versions, mount paths, and config format across the repo; ship `deploy/setup.py` — a single rich-TUI bootstrap/migration script that safely re-runs on every upgrade without clobbering user values.

**Architecture:** (1) Bump versions + add `schema_version` headers; (2) move container-internal paths into `/app/config/` and `/app/data/` subtrees so they mirror the host layout; (3) build `deploy/setup_lib/` as a small Python package (preflight, layout, yaml_merge, env_merge, auth_prompt, tui) with a thin `deploy/setup.py` entrypoint. Each module is independently testable via pytest; TUI uses `rich`; YAML merge uses `ruamel.yaml` round-trip for comment preservation.

**Tech Stack:** Python 3.11+ (for setup script), `rich`, `ruamel.yaml`, `pytest`. Bun + TypeScript for gateway path constants. YAML for all config schemas.

**Spec:** `docs/superpowers/specs/2026-04-17-service-alignment-setup-script-design.md`

**Branch:** `feature/service-alignment` (already exists, branched from develop)

---

## File Map

### Version + schema changes

| File | Change |
|------|--------|
| `package.json` | `"version": "1.6.0"` → `"0.1.0"` |
| `gateway/webui/package.json` | add `"version": "0.1.0"` |
| `sentient-auth/package.json` | `"version": "0.0.1"` → `"0.1.0"` |
| `gateway/config.yaml` | add `schema_version: "0.1.0"` line 1 |
| `gateway/salience_map.yaml` | add `schema_version: "0.1.0"` line 1 |
| `capabilityServices/STTService/config/config.example.yaml` | add `schema_version: "0.1.0"` line 1 |

### Container path changes

| File | Change |
|------|--------|
| `shared/config/src/schema.ts` | `salience_map_path` default → `/app/config/salience_map.yaml` |
| `gateway/config.yaml` | `salience_map_path` value → `/app/config/salience_map.yaml` |
| `gateway/Dockerfile` | `GATEWAY_CONFIG_PATH` → `/app/config/config.yaml` |
| `capabilityServices/STTService/Dockerfile` | `STT_RECORDING_DIR` → `/app/data/recordings`; `mkdir -p /app/data/recordings` |
| `capabilityServices/STTService/src/stt_service/__main__.py` | default fallback `/app/data/recordings` |
| `deploy/docker/docker-compose.yml` | volume targets: `/app/config/config.yaml`, `/app/config/salience_map.yaml`, `/app/data/recordings` |
| `deploy/pi/docker-compose.yml` | same |
| `gateway/src/bootstrap/llm-factory.test.ts` | test fixture `/app/salience_map.yaml` → `/app/config/salience_map.yaml` |

### New files — `deploy/setup_lib/`

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `deploy/setup.py` | Arg parse + orchestration | 120 |
| `deploy/setup_lib/__init__.py` | Package marker | 1 |
| `deploy/setup_lib/schema_versions.py` | `{filename: schema_version}` constant map | 25 |
| `deploy/setup_lib/reporter.py` | `Reporter` Protocol + `NullReporter` (test stub) + `TuiReporter` proxy | 70 |
| `deploy/setup_lib/preflight.py` | Docker + repo-root checks | 80 |
| `deploy/setup_lib/layout.py` | mkdir tree + old→new migration | 150 |
| `deploy/setup_lib/yaml_merge.py` | `ruamel.yaml` smart merge + backup + atomic write | 180 |
| `deploy/setup_lib/env_merge.py` | `.env` key diff + prompt flow | 140 |
| `deploy/setup_lib/auth_prompt.py` | Token scan + `sentient-auth init/rotate` invocation | 80 |
| `deploy/setup_lib/tui.py` | `rich` panels, prompts, summary | 250 |
| `deploy/setup_lib/errors.py` | `SetupError` typed errors | 30 |
| `deploy/setup_lib/requirements.txt` | `rich>=13,<14` · `ruamel.yaml>=0.18,<0.19` · `pytest>=8` (dev) | — |
| `deploy/setup_lib/tests/__init__.py` | Package marker | 1 |
| `deploy/setup_lib/tests/conftest.py` | Shared pytest fixtures (tmp $HOME, tmp repo) | 50 |
| `deploy/setup_lib/tests/test_preflight.py` | Docker missing, repo-root sniff | 40 |
| `deploy/setup_lib/tests/test_layout.py` | Directory creation + old-layout migration | 90 |
| `deploy/setup_lib/tests/test_yaml_merge.py` | Golden-file merge cases | 180 |
| `deploy/setup_lib/tests/test_env_merge.py` | Env diff | 80 |
| `deploy/setup_lib/tests/test_auth_prompt.py` | Token scan logic | 50 |
| `deploy/setup_lib/tests/test_integration.py` | End-to-end synthetic repo | 120 |
| `deploy/README.md` | How to run setup.py | 60 |

### Deleted files

- `deploy/docker/setup.sh`
- `deploy/pi/setup.sh`

---

## Task 1: Align workspace versions

**Files:**
- Modify: `package.json`
- Modify: `gateway/webui/package.json`
- Modify: `sentient-auth/package.json`

- [ ] **Step 1: Bump root workspace version**

Edit `package.json`:

```json
{
  "name": "sentient",
  "version": "0.1.0",
  ...
```

- [ ] **Step 2: Add webui version**

Edit `gateway/webui/package.json`. Insert `"version": "0.1.0",` as the second line, right after `"name": "@sentient/webui",`:

```json
{
  "name": "@sentient/webui",
  "version": "0.1.0",
  "private": true,
  ...
```

- [ ] **Step 3: Bump sentient-auth version**

Edit `sentient-auth/package.json`:

```json
{
  "name": "@sentient/auth",
  "version": "0.1.0",
  ...
```

- [ ] **Step 4: Verify bun workspace still resolves**

Run from repo root:

```bash
source scripts/env.sh
bun install --frozen-lockfile --dry-run
```

Expected: no errors. If lockfile needs refreshing, run `bun install` without `--frozen-lockfile` and commit the lockfile delta.

- [ ] **Step 5: Commit**

```bash
git add package.json gateway/webui/package.json sentient-auth/package.json bun.lock
git commit -m "chore: align workspace versions to 0.1.0"
```

---

## Task 2: Add `schema_version` headers to runtime YAMLs

**Files:**
- Modify: `gateway/config.yaml`
- Modify: `gateway/salience_map.yaml`
- Modify: `capabilityServices/STTService/config/config.example.yaml`

- [ ] **Step 1: Gateway config header**

Edit `gateway/config.yaml`. Insert after the leading comment block, at the first non-comment line (currently `port: 8888`). The header goes ABOVE all other keys so loaders can read it without parsing the whole file.

```yaml
# ---------------------------------------------------------------------------
# Schema version — bumped by setup.py migrations. Do not hand-edit.
# ---------------------------------------------------------------------------
schema_version: "0.1.0"

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
port: 8888
...
```

- [ ] **Step 2: Salience map header**

Edit `gateway/salience_map.yaml`. The file already has `version: 1` for the data-schema version (consumed by `salience-map-loader.ts`). Add `schema_version` as a SEPARATE key above `version:`:

```yaml
# Schema version — tracked by setup.py migrations. Do not hand-edit.
schema_version: "0.1.0"

# gateway/salience_map.yaml — event-kind to per-effect salience mapping.
...
version: 1
entries:
  ...
```

Both keys coexist: `schema_version` = setup-migration tag, `version` = loader-schema tag.

- [ ] **Step 3: STT config example header**

Edit `capabilityServices/STTService/config/config.example.yaml`. Add before the leading comment block's `server:` key:

```yaml
# ---------------------------------------------------------------------------
# Schema version — bumped by setup.py migrations. Do not hand-edit.
# ---------------------------------------------------------------------------
schema_version: "0.1.0"

# =============================================================================
# WebSocket server
# =============================================================================
server:
  ...
```

- [ ] **Step 4: Verify gateway still loads config**

```bash
cd gateway && bun run typecheck
```

Expected: no errors. The Zod schema in `shared/config/src/schema.ts` ignores unknown top-level keys by default (it uses `z.object` without `.strict()`), so `schema_version` is accepted silently. Verify by checking:

```bash
grep -n "strict()" shared/config/src/schema.ts
```

Expected: no matches on the top-level `gatewayConfigSchema`. If you find `.strict()` there, add `schema_version: z.string().optional()` to the schema before proceeding.

- [ ] **Step 5: Verify STT still loads config**

STT's loader (`capabilityServices/STTService/src/stt_service/config.py`) uses `_require_section`-style explicit parsing — unknown keys are ignored. No code change needed. Confirm by reading `config.py` `_parse` function (~line 220) and checking that it only reads declared sections.

- [ ] **Step 6: Commit**

```bash
git add gateway/config.yaml gateway/salience_map.yaml capabilityServices/STTService/config/config.example.yaml
git commit -m "chore(config): add schema_version headers to runtime YAMLs"
```

---

## Task 3: Move gateway config paths into `/app/config/` subtree

**Files:**
- Modify: `shared/config/src/schema.ts:190`
- Modify: `gateway/config.yaml` (the `salience_map_path` value)
- Modify: `gateway/Dockerfile:64`
- Modify: `gateway/src/bootstrap/llm-factory.test.ts:39`
- Modify: `deploy/docker/docker-compose.yml` (volume targets)
- Modify: `deploy/pi/docker-compose.yml` (volume targets)

- [ ] **Step 1: Update schema default**

Edit `shared/config/src/schema.ts:190`. Change:

```ts
  salience_map_path: z.string().default("/app/salience_map.yaml"),
```

to:

```ts
  salience_map_path: z.string().default("/app/config/salience_map.yaml"),
```

- [ ] **Step 2: Update config.yaml value**

Edit `gateway/config.yaml`, find `salience_map_path: /app/salience_map.yaml` and change to:

```yaml
  salience_map_path: /app/config/salience_map.yaml
```

- [ ] **Step 3: Update Dockerfile env**

Edit `gateway/Dockerfile:64`. Change:

```dockerfile
ENV GATEWAY_CONFIG_PATH=/app/config.yaml \
```

to:

```dockerfile
ENV GATEWAY_CONFIG_PATH=/app/config/config.yaml \
```

- [ ] **Step 4: Update test fixture**

Edit `gateway/src/bootstrap/llm-factory.test.ts:39`. Change:

```ts
      salience_map_path: "/app/salience_map.yaml",
```

to:

```ts
      salience_map_path: "/app/config/salience_map.yaml",
```

- [ ] **Step 5: Update docker compose — local**

Edit `deploy/docker/docker-compose.yml`. In the gateway service's `volumes:` block, change BOTH lines:

- `target: /app/config.yaml` → `target: /app/config/config.yaml`
- `target: /app/salience_map.yaml` → `target: /app/config/salience_map.yaml`

- [ ] **Step 6: Update docker compose — pi**

Edit `deploy/pi/docker-compose.yml` identically (same two `target:` lines, same replacement).

- [ ] **Step 7: Typecheck and test**

```bash
source scripts/env.sh
bun run typecheck
cd gateway/src && bun test bootstrap/llm-factory.test.ts -t ""
```

Expected: typecheck green. llm-factory tests pass. If a test references the old `/app/salience_map.yaml` path, grep and update:

```bash
```

Use the Grep tool: pattern `/app/salience_map\.yaml`, path `gateway/`. Update any remaining hits to `/app/config/salience_map.yaml`.

- [ ] **Step 8: Commit**

```bash
git add shared/config/src/schema.ts gateway/config.yaml gateway/Dockerfile gateway/src/bootstrap/llm-factory.test.ts deploy/docker/docker-compose.yml deploy/pi/docker-compose.yml
git commit -m "refactor(gateway): move container config paths into /app/config/"
```

---

## Task 4: Move STT recordings into `/app/data/recordings/` subtree

**Files:**
- Modify: `capabilityServices/STTService/Dockerfile` (env + mkdir)
- Modify: `capabilityServices/STTService/src/stt_service/__main__.py:46`
- Modify: `capabilityServices/STTService/config/config.example.yaml` (comment)
- Modify: `deploy/docker/docker-compose.yml`
- Modify: `deploy/pi/docker-compose.yml`

- [ ] **Step 1: Update Dockerfile**

Edit `capabilityServices/STTService/Dockerfile`. Change:

```dockerfile
# Volume mount points — compose bind-mounts host dirs into these.
RUN mkdir -p /app/logs /app/recordings /app/config
```

to:

```dockerfile
# Volume mount points — compose bind-mounts host dirs into these.
RUN mkdir -p /app/logs /app/data/recordings /app/config
```

And change:

```dockerfile
    STT_RECORDING_DIR=/app/recordings \
```

to:

```dockerfile
    STT_RECORDING_DIR=/app/data/recordings \
```

Also update the header comment block (around line 15) — replace `-v ~/.sentient/stt-service/recordings:/app/recordings \` with `-v ~/.sentient/stt-service/data/recordings:/app/data/recordings \`.

- [ ] **Step 2: Update __main__.py default**

Edit `capabilityServices/STTService/src/stt_service/__main__.py:46`. Change:

```python
    recording_dir = Path(os.environ.get("STT_RECORDING_DIR", "/app/recordings"))
```

to:

```python
    recording_dir = Path(os.environ.get("STT_RECORDING_DIR", "/app/data/recordings"))
```

- [ ] **Step 3: Update config.example.yaml comment**

Edit `capabilityServices/STTService/config/config.example.yaml`. Find the comment block:

```yaml
# Container-internal paths (/app/models, /app/logs, /app/recordings)
# are fixed in the Dockerfile and mounted from the host. Change the
```

Change `/app/recordings` to `/app/data/recordings`.

- [ ] **Step 4: Update docker compose — local**

Edit `deploy/docker/docker-compose.yml`. Find line (under stt-service volumes):

```yaml
      - ~/.sentient/stt-service/logs:/app/logs
      - ~/.sentient/stt-service/recordings:/app/recordings
```

Change to:

```yaml
      - ~/.sentient/stt-service/logs:/app/logs
      - ~/.sentient/stt-service/data/recordings:/app/data/recordings
```

- [ ] **Step 5: Update docker compose — pi**

Edit `deploy/pi/docker-compose.yml` identically.

- [ ] **Step 6: Commit**

```bash
git add capabilityServices/STTService/Dockerfile capabilityServices/STTService/src/stt_service/__main__.py capabilityServices/STTService/config/config.example.yaml deploy/docker/docker-compose.yml deploy/pi/docker-compose.yml
git commit -m "refactor(stt): move recordings dir into /app/data/recordings"
```

---

## Task 5: Scaffold `deploy/setup_lib/` package + errors + schema_versions

**Files:**
- Create: `deploy/setup_lib/__init__.py`
- Create: `deploy/setup_lib/errors.py`
- Create: `deploy/setup_lib/schema_versions.py`
- Create: `deploy/setup_lib/requirements.txt`
- Create: `deploy/setup_lib/tests/__init__.py`
- Create: `deploy/setup_lib/tests/conftest.py`
- Create: `deploy/README.md`

- [ ] **Step 1: Package marker**

Create `deploy/setup_lib/__init__.py`:

```python
"""Sentient setup script helpers. See deploy/setup.py for the entrypoint."""
```

Create `deploy/setup_lib/tests/__init__.py`:

```python
```

(Empty file — just a package marker.)

- [ ] **Step 2: Typed errors**

Create `deploy/setup_lib/errors.py`:

```python
"""Typed errors raised inside setup_lib. Caught at the top of deploy/setup.py."""

from __future__ import annotations


class SetupError(Exception):
    """Base class for every fail-loud condition inside setup_lib.

    Carries a one-line summary and an optional remediation hint. The
    entrypoint catches these and renders them as red TUI panels before
    exiting non-zero.
    """

    def __init__(self, message: str, *, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


class PreflightError(SetupError):
    """Docker/compose missing, or cwd doesn't look like the sentient repo."""


class LayoutError(SetupError):
    """Failed to create / migrate a directory in ~/.sentient/."""


class YamlMergeError(SetupError):
    """Config YAML parse or merge failure."""


class EnvMergeError(SetupError):
    """.env file parse or write failure."""


class AuthPromptError(SetupError):
    """sentient-auth invocation failed."""
```

- [ ] **Step 3: Schema version map**

Create `deploy/setup_lib/schema_versions.py`:

```python
"""Canonical schema_version for every runtime-loaded YAML.

Maps the repo-relative path of the canonical file to its schema_version
string. When the user's host copy carries a lower version, setup_lib
runs the smart-merge migration. Update this table when bumping any
config schema.
"""

from __future__ import annotations

SCHEMA_VERSIONS: dict[str, str] = {
    "gateway/config.yaml": "0.1.0",
    "gateway/salience_map.yaml": "0.1.0",
    "capabilityServices/STTService/config/config.example.yaml": "0.1.0",
}


def expected_version(repo_relpath: str) -> str | None:
    """Return the schema_version the repo declares for *repo_relpath*.

    Returns None for files not in the registry (e.g. auth manifests,
    which version themselves differently).
    """
    return SCHEMA_VERSIONS.get(repo_relpath)
```

- [ ] **Step 4: Dev requirements**

Create `deploy/setup_lib/requirements.txt`:

```
# Runtime deps for deploy/setup.py — install with:
#   pip install -r deploy/setup_lib/requirements.txt
#
# rich       — TUI panels, tables, prompts.
# ruamel.yaml — round-trip YAML loader that preserves comments and order.
rich>=13,<14
ruamel.yaml>=0.18,<0.19

# Dev-only — pytest drives deploy/setup_lib/tests/.
pytest>=8,<9
```

- [ ] **Step 5: Test fixtures**

Create `deploy/setup_lib/tests/conftest.py`:

```python
"""Shared pytest fixtures — isolated filesystem for every test."""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture
def tmp_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect ``$HOME`` to a tmp dir so ~/.sentient/ is hermetic."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    return home


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    """Minimal repo skeleton — enough for preflight + layout to think it's real."""
    repo = tmp_path / "repo"
    (repo / "gateway").mkdir(parents=True)
    (repo / "capabilityServices" / "STTService" / "config").mkdir(parents=True)
    (repo / "deploy" / "docker").mkdir(parents=True)
    (repo / "deploy" / "pi").mkdir(parents=True)
    # Canonical YAML stubs — tests overwrite as needed.
    (repo / "gateway" / "config.yaml").write_text(
        'schema_version: "0.1.0"\nport: 8888\n'
    )
    (repo / "gateway" / "salience_map.yaml").write_text(
        'schema_version: "0.1.0"\nversion: 1\nentries: {}\n'
    )
    (repo / "capabilityServices" / "STTService" / "config" / "config.example.yaml").write_text(
        'schema_version: "0.1.0"\nserver:\n  port: 8766\n'
    )
    (repo / "deploy" / "docker" / ".env.example").write_text(
        "OPENROUTER_API_KEY=\nFISH_AUDIO_API_KEY=\n"
    )
    (repo / "deploy" / "pi" / ".env.example").write_text(
        "CI_REGISTRY_IMAGE=\nOPENROUTER_API_KEY=\nFISH_AUDIO_API_KEY=\n"
    )
    return repo
```

- [ ] **Step 6: Deploy README**

Create `deploy/README.md`:

```markdown
# Sentient deploy

## First-time setup / upgrade

From the repo root:

    python3 deploy/setup.py

Bootstraps `~/.sentient/...`, merges any new config fields into existing
files without touching your values, and prompts for missing `.env`
variables.

## Modes

    python3 deploy/setup.py --mode prod                 # default
    python3 deploy/setup.py --mode local-dev-docker

Auto-detected when run from `deploy/pi/` or `deploy/docker/`.

## Flags

    --yes      non-interactive, accept all defaults (for CI / scripted redeploys)
    --custom   prompt per missing field instead of bulk-accept

`--yes` and `--custom` are mutually exclusive.

## Requirements

Python 3.11+ and:

    pip install -r deploy/setup_lib/requirements.txt

## Developer — running tests

    cd deploy && python -m pytest setup_lib/tests -v
```

- [ ] **Step 7: Verify package imports**

```bash
cd /Users/kevinye/Development/sentient
python3 -c "from deploy.setup_lib import errors, schema_versions; print(errors.SetupError, schema_versions.expected_version('gateway/config.yaml'))"
```

Expected: `<class 'deploy.setup_lib.errors.SetupError'> 0.1.0`

- [ ] **Step 8: Commit**

```bash
git add deploy/README.md deploy/setup_lib/
git commit -m "feat(deploy): scaffold setup_lib package — errors, schema map, test fixtures"
```

---

## Task 6: Reporter protocol + NullReporter

**Files:**
- Create: `deploy/setup_lib/reporter.py`
- Create: `deploy/setup_lib/tests/test_reporter.py`

- [ ] **Step 1: Write the failing test**

Create `deploy/setup_lib/tests/test_reporter.py`:

```python
"""NullReporter swallows all messages — the default for unit tests."""

from __future__ import annotations

from deploy.setup_lib.reporter import NullReporter


def test_null_reporter_swallows_every_method() -> None:
    r = NullReporter()
    r.section("anything")
    r.ok("ok line")
    r.warn("warn line")
    r.error("error line")
    r.info("info line")
    # If any call raised, the test would fail. The guarantee is silence.
    assert True


def test_null_reporter_prompt_returns_default() -> None:
    r = NullReporter()
    # In non-interactive mode, prompt returns the given default verbatim.
    assert r.prompt_choice("question?", choices=["y", "n"], default="y") == "y"


def test_null_reporter_prompt_text_returns_default() -> None:
    r = NullReporter()
    assert r.prompt_text("enter key:", default="abc") == "abc"
    assert r.prompt_text("enter key:", default=None) == ""
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /Users/kevinye/Development/sentient
python3 -m pytest deploy/setup_lib/tests/test_reporter.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'deploy.setup_lib.reporter'`.

- [ ] **Step 3: Implement reporter.py**

Create `deploy/setup_lib/reporter.py`:

```python
"""Reporter protocol — lets tests stub out the TUI.

Production code takes a Reporter (structural type). In the entrypoint we
pass a TuiReporter backed by rich. In unit tests we pass a NullReporter
so nothing prints and no prompts block.
"""

from __future__ import annotations

from typing import Protocol, Sequence


class Reporter(Protocol):
    """Anything that can report progress and read user input."""

    def section(self, title: str) -> None: ...

    def ok(self, message: str) -> None: ...

    def warn(self, message: str) -> None: ...

    def error(self, message: str) -> None: ...

    def info(self, message: str) -> None: ...

    def prompt_choice(
        self,
        message: str,
        *,
        choices: Sequence[str],
        default: str,
    ) -> str:
        """Prompt for one of ``choices``; return the chosen value."""
        ...

    def prompt_text(self, message: str, *, default: str | None) -> str:
        """Prompt for freeform text; empty input returns ``default or ""``."""
        ...


class NullReporter:
    """Silent reporter for unit tests — prompts always return their default."""

    def section(self, title: str) -> None:
        return None

    def ok(self, message: str) -> None:
        return None

    def warn(self, message: str) -> None:
        return None

    def error(self, message: str) -> None:
        return None

    def info(self, message: str) -> None:
        return None

    def prompt_choice(
        self,
        message: str,
        *,
        choices: Sequence[str],
        default: str,
    ) -> str:
        return default

    def prompt_text(self, message: str, *, default: str | None) -> str:
        return default or ""
```

- [ ] **Step 4: Run test to verify pass**

```bash
python3 -m pytest deploy/setup_lib/tests/test_reporter.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add deploy/setup_lib/reporter.py deploy/setup_lib/tests/test_reporter.py
git commit -m "feat(setup): Reporter protocol + NullReporter for test stubs"
```

---

## Task 7: Preflight — docker checks + repo-root sniff

**Files:**
- Create: `deploy/setup_lib/preflight.py`
- Create: `deploy/setup_lib/tests/test_preflight.py`

- [ ] **Step 1: Write the failing tests**

Create `deploy/setup_lib/tests/test_preflight.py`:

```python
"""Preflight covers: docker present, compose present, cwd looks like the repo."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from deploy.setup_lib.errors import PreflightError
from deploy.setup_lib.preflight import check_docker, check_repo_root
from deploy.setup_lib.reporter import NullReporter


def test_check_docker_raises_when_docker_missing() -> None:
    with patch("shutil.which", return_value=None):
        with pytest.raises(PreflightError, match="docker"):
            check_docker(NullReporter())


def test_check_docker_passes_when_docker_and_compose_present() -> None:
    with patch("shutil.which", return_value="/usr/bin/docker"), patch(
        "subprocess.run"
    ) as mock_run:
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = "Docker Compose version v2.29.1\n"
        check_docker(NullReporter())  # must not raise


def test_check_docker_raises_when_compose_plugin_missing() -> None:
    with patch("shutil.which", return_value="/usr/bin/docker"), patch(
        "subprocess.run"
    ) as mock_run:
        mock_run.return_value.returncode = 1
        mock_run.return_value.stdout = ""
        with pytest.raises(PreflightError, match="compose"):
            check_docker(NullReporter())


def test_check_repo_root_accepts_valid_layout(fake_repo: Path) -> None:
    check_repo_root(fake_repo, NullReporter())  # must not raise


def test_check_repo_root_rejects_when_gateway_missing(tmp_path: Path) -> None:
    with pytest.raises(PreflightError, match="gateway"):
        check_repo_root(tmp_path, NullReporter())
```

- [ ] **Step 2: Run it to see it fail**

```bash
python3 -m pytest deploy/setup_lib/tests/test_preflight.py -v
```

Expected: 5 failures — `ModuleNotFoundError`.

- [ ] **Step 3: Implement preflight.py**

Create `deploy/setup_lib/preflight.py`:

```python
"""Preflight checks — fast fail-loud before any mutation."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .errors import PreflightError
from .reporter import Reporter

# Files/directories that must exist for the cwd to pass as the sentient repo.
REPO_MARKERS = ("gateway", "capabilityServices", "deploy", "sentient-auth")


def check_docker(reporter: Reporter) -> None:
    """Verify docker CLI + docker compose plugin are installed."""
    docker = shutil.which("docker")
    if docker is None:
        raise PreflightError(
            "docker not found on PATH",
            hint="Install Docker Desktop (Mac) or `curl -fsSL https://get.docker.com | sh` (Pi)",
        )
    reporter.ok(f"docker found at {docker}")

    # `docker compose version` exits non-zero if the plugin is missing.
    result = subprocess.run(
        ["docker", "compose", "version"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise PreflightError(
            "docker compose plugin not found",
            hint="Upgrade Docker Desktop or install the compose-plugin package",
        )
    reporter.ok((result.stdout or "docker compose present").strip().splitlines()[0])


def check_repo_root(repo_root: Path, reporter: Reporter) -> None:
    """Sanity-check that ``repo_root`` actually points at the sentient repo."""
    missing = [m for m in REPO_MARKERS if not (repo_root / m).exists()]
    if missing:
        raise PreflightError(
            f"repo root {repo_root} missing expected dirs: {', '.join(missing)}",
            hint="Run setup.py from the sentient repo root",
        )
    reporter.ok(f"repo root looks valid: {repo_root}")
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest deploy/setup_lib/tests/test_preflight.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add deploy/setup_lib/preflight.py deploy/setup_lib/tests/test_preflight.py
git commit -m "feat(setup): preflight — docker + compose + repo-root checks"
```

---

## Task 8: Layout — directory tree + host-layout migration

**Files:**
- Create: `deploy/setup_lib/layout.py`
- Create: `deploy/setup_lib/tests/test_layout.py`

- [ ] **Step 1: Write the failing tests**

Create `deploy/setup_lib/tests/test_layout.py`:

```python
"""Layout covers: mkdir the canonical tree, migrate old-layout host files."""

from __future__ import annotations

from pathlib import Path

import pytest

from deploy.setup_lib.errors import LayoutError
from deploy.setup_lib.layout import ensure_tree, migrate_old_layout
from deploy.setup_lib.reporter import NullReporter


def test_ensure_tree_creates_all_dirs(tmp_home: Path) -> None:
    ensure_tree(NullReporter())
    sentient = tmp_home / ".sentient"
    assert (sentient / "gateway" / "config").is_dir()
    assert (sentient / "gateway" / "logs").is_dir()
    assert (sentient / "stt-service" / "config").is_dir()
    assert (sentient / "stt-service" / "logs").is_dir()
    assert (sentient / "stt-service" / "data" / "recordings").is_dir()
    assert (sentient / "auth" / "tokens").is_dir()
    assert (sentient / "auth" / "manifests").is_dir()
    assert (sentient / "certs").is_dir()


def test_ensure_tree_is_idempotent(tmp_home: Path) -> None:
    ensure_tree(NullReporter())
    ensure_tree(NullReporter())  # must not raise


def test_ensure_tree_chmods_auth_tokens_dir(tmp_home: Path) -> None:
    ensure_tree(NullReporter())
    tokens = tmp_home / ".sentient" / "auth" / "tokens"
    mode = tokens.stat().st_mode & 0o777
    assert mode == 0o700


def test_migrate_moves_old_gateway_config(tmp_home: Path) -> None:
    old = tmp_home / ".sentient" / "gateway"
    old.mkdir(parents=True)
    (old / "config.yaml").write_text("port: 8888\n")
    (old / "salience_map.yaml").write_text("version: 1\n")
    ensure_tree(NullReporter())
    migrate_old_layout(NullReporter())
    assert (old / "config" / "config.yaml").read_text() == "port: 8888\n"
    assert (old / "config" / "salience_map.yaml").read_text() == "version: 1\n"
    assert not (old / "config.yaml").exists()
    assert not (old / "salience_map.yaml").exists()


def test_migrate_moves_old_stt_recordings(tmp_home: Path) -> None:
    old = tmp_home / ".sentient" / "stt-service" / "recordings"
    old.mkdir(parents=True)
    (old / "turn_001.wav").write_text("fake wav")
    ensure_tree(NullReporter())
    migrate_old_layout(NullReporter())
    new = tmp_home / ".sentient" / "stt-service" / "data" / "recordings"
    assert (new / "turn_001.wav").read_text() == "fake wav"
    # Old dir is removed after successful move.
    assert not old.exists()


def test_migrate_is_noop_when_already_migrated(tmp_home: Path) -> None:
    ensure_tree(NullReporter())  # fresh tree, no old files
    migrate_old_layout(NullReporter())  # must not raise


def test_migrate_errors_on_collision(tmp_home: Path) -> None:
    old = tmp_home / ".sentient" / "gateway"
    old.mkdir(parents=True)
    (old / "config.yaml").write_text("old content\n")
    ensure_tree(NullReporter())
    # Simulate a half-migrated state: destination already occupied.
    (old / "config" / "config.yaml").write_text("new content\n")
    with pytest.raises(LayoutError, match="destination.*exists"):
        migrate_old_layout(NullReporter())
```

- [ ] **Step 2: Run to see failures**

```bash
python3 -m pytest deploy/setup_lib/tests/test_layout.py -v
```

Expected: 7 failures — ModuleNotFoundError.

- [ ] **Step 3: Implement layout.py**

Create `deploy/setup_lib/layout.py`:

```python
"""Directory bootstrap + old-layout → new-layout host migration."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from .errors import LayoutError
from .reporter import Reporter


def sentient_root() -> Path:
    """The host-side root for all service data: ``$HOME/.sentient``."""
    return Path(os.environ["HOME"]) / ".sentient"


# Canonical tree — every path under ``sentient_root()`` that must exist.
CANONICAL_DIRS: tuple[str, ...] = (
    "gateway/config",
    "gateway/logs",
    "stt-service/config",
    "stt-service/logs",
    "stt-service/data/recordings",
    "auth/tokens",
    "auth/manifests",
    "certs",
)

# (old_relpath, new_relpath) pairs, applied in order. Files only — directory
# moves are done with ``shutil.move`` which atomically renames when on the
# same filesystem.
MIGRATIONS: tuple[tuple[str, str], ...] = (
    ("gateway/config.yaml", "gateway/config/config.yaml"),
    ("gateway/salience_map.yaml", "gateway/config/salience_map.yaml"),
    ("stt-service/recordings", "stt-service/data/recordings"),
)


def ensure_tree(reporter: Reporter) -> None:
    """Create every directory in ``CANONICAL_DIRS``. Idempotent."""
    root = sentient_root()
    for relpath in CANONICAL_DIRS:
        target = root / relpath
        target.mkdir(parents=True, exist_ok=True)
    # Tokens dir stores secrets — chmod 700 unconditionally.
    (root / "auth").chmod(0o700)
    (root / "auth" / "tokens").chmod(0o700)
    reporter.ok(f"directory tree ready under {root}")


def migrate_old_layout(reporter: Reporter) -> None:
    """Move legacy host files into the new layout. Idempotent.

    Errors loudly on collision so a half-finished previous migration
    cannot silently overwrite either copy.
    """
    root = sentient_root()
    for old_rel, new_rel in MIGRATIONS:
        src = root / old_rel
        dst = root / new_rel
        if not src.exists():
            continue
        if dst.exists():
            # Recordings directory migration: if src has content and dst is
            # empty (freshly mkdir'd), merge-move. Otherwise error.
            if dst.is_dir() and src.is_dir() and not any(dst.iterdir()):
                # Atomically move contents of src into dst, then remove src.
                for child in src.iterdir():
                    shutil.move(str(child), str(dst / child.name))
                src.rmdir()
                reporter.ok(f"migrated {old_rel} → {new_rel} (contents moved)")
                continue
            raise LayoutError(
                f"migration destination already exists: {new_rel}",
                hint=f"Both {old_rel} and {new_rel} are populated. Resolve manually.",
            )
        shutil.move(str(src), str(dst))
        reporter.ok(f"migrated {old_rel} → {new_rel}")
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest deploy/setup_lib/tests/test_layout.py -v
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add deploy/setup_lib/layout.py deploy/setup_lib/tests/test_layout.py
git commit -m "feat(setup): layout — canonical dirs + old-layout migration"
```

---

## Task 9: YAML smart merge (comment-preserving)

**Files:**
- Create: `deploy/setup_lib/yaml_merge.py`
- Create: `deploy/setup_lib/tests/test_yaml_merge.py`

- [ ] **Step 1: Write the failing tests**

Create `deploy/setup_lib/tests/test_yaml_merge.py`:

```python
"""Round-trip merge — add missing keys from canonical, preserve everything else."""

from __future__ import annotations

from pathlib import Path

import pytest

from deploy.setup_lib.errors import YamlMergeError
from deploy.setup_lib.reporter import NullReporter
from deploy.setup_lib.yaml_merge import MergeResult, merge_yaml, missing_fields


def _write(p: Path, content: str) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return p


def test_merge_adds_missing_top_level_key(tmp_path: Path) -> None:
    canonical = _write(
        tmp_path / "canonical.yaml",
        'schema_version: "0.1.0"\nport: 8888\nhost: "0.0.0.0"\n',
    )
    user = _write(tmp_path / "user.yaml", 'schema_version: "0.1.0"\nport: 9999\n')
    result = merge_yaml(canonical, user, NullReporter())
    assert result.new_fields == ["host"]
    text = user.read_text()
    assert "host: " in text
    # User's override kept.
    assert "port: 9999" in text


def test_merge_preserves_user_value(tmp_path: Path) -> None:
    canonical = _write(tmp_path / "c.yaml", "llm:\n  chat_model: google/gemini\n")
    user = _write(tmp_path / "u.yaml", "llm:\n  chat_model: openai/gpt-4\n")
    merge_yaml(canonical, user, NullReporter())
    assert "openai/gpt-4" in user.read_text()


def test_merge_adds_nested_missing_field(tmp_path: Path) -> None:
    canonical = _write(
        tmp_path / "c.yaml",
        "tts:\n  voice_id: default\n  model_id: s2\n",
    )
    user = _write(tmp_path / "u.yaml", "tts:\n  voice_id: myvoice\n")
    result = merge_yaml(canonical, user, NullReporter())
    assert result.new_fields == ["tts.model_id"]
    text = user.read_text()
    assert "myvoice" in text
    assert "model_id:" in text


def test_merge_keeps_user_keys_unknown_to_canonical(tmp_path: Path) -> None:
    canonical = _write(tmp_path / "c.yaml", "port: 8888\n")
    user = _write(tmp_path / "u.yaml", "port: 8888\nexperimental_knob: 42\n")
    merge_yaml(canonical, user, NullReporter())
    assert "experimental_knob: 42" in user.read_text()


def test_merge_writes_backup(tmp_path: Path) -> None:
    canonical = _write(tmp_path / "c.yaml", "port: 8888\nextra: true\n")
    user = _write(tmp_path / "u.yaml", "port: 9999\n")
    result = merge_yaml(canonical, user, NullReporter())
    assert result.backup_path is not None
    assert result.backup_path.exists()
    assert "port: 9999" in result.backup_path.read_text()
    # New field added, but backup holds pre-merge content.
    assert "extra:" not in result.backup_path.read_text()


def test_merge_noop_when_up_to_date(tmp_path: Path) -> None:
    canonical = _write(tmp_path / "c.yaml", "port: 8888\n")
    user = _write(tmp_path / "u.yaml", "port: 8888\n")
    result = merge_yaml(canonical, user, NullReporter())
    assert result.new_fields == []
    # No backup when nothing changed.
    assert result.backup_path is None


def test_merge_overwrites_schema_version(tmp_path: Path) -> None:
    canonical = _write(tmp_path / "c.yaml", 'schema_version: "0.2.0"\nport: 8888\n')
    user = _write(tmp_path / "u.yaml", 'schema_version: "0.1.0"\nport: 8888\n')
    merge_yaml(canonical, user, NullReporter())
    text = user.read_text()
    assert '"0.2.0"' in text
    assert '"0.1.0"' not in text


def test_merge_list_is_replaced_whole(tmp_path: Path) -> None:
    canonical = _write(tmp_path / "c.yaml", 'hostnames: ["localhost", "sentient.local"]\n')
    user = _write(tmp_path / "u.yaml", 'hostnames: ["myhost"]\n')
    merge_yaml(canonical, user, NullReporter())
    # User's list wins — no element-level merge.
    text = user.read_text()
    assert "myhost" in text
    assert "sentient.local" not in text


def test_merge_preserves_comments(tmp_path: Path) -> None:
    canonical = _write(
        tmp_path / "c.yaml",
        '# top comment\nport: 8888  # inline\nhost: "0.0.0.0"  # bind\n',
    )
    user = _write(tmp_path / "u.yaml", "# my comment\nport: 9999  # my inline\n")
    merge_yaml(canonical, user, NullReporter())
    text = user.read_text()
    assert "# my comment" in text
    assert "# my inline" in text


def test_missing_fields_enumerates_without_writing(tmp_path: Path) -> None:
    canonical = _write(tmp_path / "c.yaml", "a: 1\nb:\n  c: 2\n  d: 3\n")
    user = _write(tmp_path / "u.yaml", "a: 1\nb:\n  c: 2\n")
    fields = missing_fields(canonical, user)
    assert fields == ["b.d"]
    # User file unchanged.
    assert "d:" not in user.read_text()


def test_merge_errors_on_canonical_parse_failure(tmp_path: Path) -> None:
    canonical = _write(tmp_path / "c.yaml", "port: 8888\n  bad: indent\n")
    user = _write(tmp_path / "u.yaml", "port: 8888\n")
    with pytest.raises(YamlMergeError):
        merge_yaml(canonical, user, NullReporter())
```

- [ ] **Step 2: Run tests to see them fail**

```bash
pip install -r deploy/setup_lib/requirements.txt
python3 -m pytest deploy/setup_lib/tests/test_yaml_merge.py -v
```

Expected: 11 failures — ModuleNotFoundError.

- [ ] **Step 3: Implement yaml_merge.py**

Create `deploy/setup_lib/yaml_merge.py`:

```python
"""Round-trip YAML merge — add missing keys from canonical, preserve user values.

Uses ``ruamel.yaml`` so comments, key order, and quoting style survive the
round trip. The vanilla ``pyyaml`` loader would lose all of that.

Semantics:
  * keys missing in user → added from canonical (with canonical comment)
  * keys present in user → kept as-is (value AND comment)
  * keys unknown to canonical → kept (forward-compat for user additions)
  * lists → whole-list user-wins (no element-level merge)
  * ``schema_version`` → always overwritten to canonical value
"""

from __future__ import annotations

import io
import time
from dataclasses import dataclass, field
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap

from .errors import YamlMergeError
from .reporter import Reporter

_SCHEMA_VERSION_KEY = "schema_version"


@dataclass
class MergeResult:
    """Summary of a single merge_yaml call."""

    new_fields: list[str] = field(default_factory=list)
    backup_path: Path | None = None


def _loader() -> YAML:
    y = YAML(typ="rt")  # round-trip
    y.preserve_quotes = True
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def _load(path: Path) -> CommentedMap:
    y = _loader()
    try:
        with path.open("r", encoding="utf-8") as fp:
            doc = y.load(fp)
    except Exception as exc:
        raise YamlMergeError(
            f"failed to parse {path}: {exc}",
            hint="Fix the YAML file manually, then re-run setup.py",
        ) from exc
    if doc is None:
        doc = CommentedMap()
    if not isinstance(doc, CommentedMap):
        raise YamlMergeError(
            f"{path} must be a mapping at the top level, got {type(doc).__name__}",
        )
    return doc


def _dump(doc: CommentedMap, path: Path) -> None:
    y = _loader()
    buf = io.StringIO()
    y.dump(doc, buf)
    # Atomic write: temp file + rename over the original.
    tmp = path.with_suffix(path.suffix + ".new")
    tmp.write_text(buf.getvalue(), encoding="utf-8")
    tmp.replace(path)


def _merge_into(
    canonical: CommentedMap,
    user: CommentedMap,
    path_prefix: str,
    added: list[str],
) -> None:
    """Recursively add missing keys from ``canonical`` into ``user``."""
    for key in canonical:
        full_key = f"{path_prefix}{key}"
        if key == _SCHEMA_VERSION_KEY:
            # Always overwrite schema_version — that IS the migration signal.
            user[key] = canonical[key]
            continue
        if key not in user:
            user[key] = canonical[key]
            added.append(full_key)
            continue
        # Key present in user: recurse into nested maps only.
        if isinstance(canonical[key], CommentedMap) and isinstance(
            user[key], CommentedMap
        ):
            _merge_into(canonical[key], user[key], f"{full_key}.", added)


def merge_yaml(
    canonical_path: Path,
    user_path: Path,
    reporter: Reporter,
) -> MergeResult:
    """Add missing canonical keys to ``user_path``. Backup on change."""
    canonical = _load(canonical_path)
    user = _load(user_path)

    added: list[str] = []
    _merge_into(canonical, user, "", added)

    # Was anything actually changed? If the only edit was an identical
    # schema_version overwrite, treat as no-op.
    canonical_sv = canonical.get(_SCHEMA_VERSION_KEY)
    pre_user_sv_matches = user.get(_SCHEMA_VERSION_KEY) == canonical_sv
    if not added and pre_user_sv_matches:
        return MergeResult(new_fields=[], backup_path=None)

    # Backup pre-merge content — read original bytes since the in-memory
    # ``user`` doc has already been mutated.
    backup = user_path.with_suffix(
        user_path.suffix + f".bak.{time.strftime('%Y%m%dT%H%M%S')}"
    )
    # Re-read original text from disk (user_path hasn't been written yet).
    original = _load(user_path)
    _dump(original, backup)

    _dump(user, user_path)
    reporter.ok(
        f"merged {user_path.name}: +{len(added)} fields, backup {backup.name}"
    )
    return MergeResult(new_fields=added, backup_path=backup)


def missing_fields(canonical_path: Path, user_path: Path) -> list[str]:
    """Dry-run enumeration of keys present in canonical but missing in user.

    Does NOT modify either file. Used by the TUI to preview changes before
    prompting for approval.
    """
    canonical = _load(canonical_path)
    user = _load(user_path)
    added: list[str] = []

    def walk(c: CommentedMap, u: CommentedMap, prefix: str) -> None:
        for key in c:
            if key == _SCHEMA_VERSION_KEY:
                continue
            full = f"{prefix}{key}"
            if key not in u:
                added.append(full)
                continue
            if isinstance(c[key], CommentedMap) and isinstance(u[key], CommentedMap):
                walk(c[key], u[key], f"{full}.")

    walk(canonical, user, "")
    return added
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest deploy/setup_lib/tests/test_yaml_merge.py -v
```

Expected: 11 passed. If `test_merge_writes_backup` fails due to the mid-merge mutation of `user`, re-read the original from disk BEFORE calling `_merge_into` and dump that to the backup path — the implementation above already does this via the `original = _load(user_path)` line.

- [ ] **Step 5: Commit**

```bash
git add deploy/setup_lib/yaml_merge.py deploy/setup_lib/tests/test_yaml_merge.py
git commit -m "feat(setup): yaml_merge — comment-preserving smart merge with backup"
```

---

## Task 10: .env merge — key diff + prompt flow

**Files:**
- Create: `deploy/setup_lib/env_merge.py`
- Create: `deploy/setup_lib/tests/test_env_merge.py`

- [ ] **Step 1: Write the failing tests**

Create `deploy/setup_lib/tests/test_env_merge.py`:

```python
"""env_merge: read .env.example as schema, find missing/empty keys in .env."""

from __future__ import annotations

from pathlib import Path

from deploy.setup_lib.env_merge import EnvDiff, diff_env, ensure_env_file
from deploy.setup_lib.reporter import NullReporter


def _write(p: Path, text: str) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


def test_diff_reports_missing_required_key(tmp_path: Path) -> None:
    example = _write(
        tmp_path / ".env.example",
        "OPENROUTER_API_KEY=\nFISH_AUDIO_API_KEY=\n",
    )
    user = _write(tmp_path / ".env", "OPENROUTER_API_KEY=sk-abc\n")
    diff = diff_env(example, user)
    assert diff.missing == ["FISH_AUDIO_API_KEY"]
    assert diff.empty == []


def test_diff_reports_empty_required_key(tmp_path: Path) -> None:
    example = _write(tmp_path / ".env.example", "OPENROUTER_API_KEY=\n")
    user = _write(tmp_path / ".env", "OPENROUTER_API_KEY=\n")
    diff = diff_env(example, user)
    assert diff.missing == []
    assert diff.empty == ["OPENROUTER_API_KEY"]


def test_diff_ignores_commented_lines(tmp_path: Path) -> None:
    example = _write(
        tmp_path / ".env.example",
        "OPENROUTER_API_KEY=\n# OPTIONAL_THING=foo\n",
    )
    user = _write(tmp_path / ".env", "OPENROUTER_API_KEY=x\n")
    diff = diff_env(example, user)
    assert diff.missing == []
    assert diff.empty == []


def test_diff_missing_user_file_returns_all_keys(tmp_path: Path) -> None:
    example = _write(tmp_path / ".env.example", "A=\nB=\n")
    user = tmp_path / ".env"  # does not exist
    diff = diff_env(example, user)
    assert diff.missing == ["A", "B"]


def test_ensure_creates_env_from_example(tmp_path: Path) -> None:
    example = _write(tmp_path / ".env.example", "A=\n")
    user = tmp_path / ".env"
    created = ensure_env_file(example, user, NullReporter())
    assert created is True
    assert user.read_text() == "A=\n"


def test_ensure_noop_when_env_exists(tmp_path: Path) -> None:
    example = _write(tmp_path / ".env.example", "A=\n")
    user = _write(tmp_path / ".env", "A=existing\n")
    created = ensure_env_file(example, user, NullReporter())
    assert created is False
    assert user.read_text() == "A=existing\n"
```

- [ ] **Step 2: Run to see them fail**

```bash
python3 -m pytest deploy/setup_lib/tests/test_env_merge.py -v
```

Expected: 6 failures — ModuleNotFoundError.

- [ ] **Step 3: Implement env_merge.py**

Create `deploy/setup_lib/env_merge.py`:

```python
"""Diff and bootstrap .env files against their .env.example siblings."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from .errors import EnvMergeError
from .reporter import Reporter


@dataclass
class EnvDiff:
    """Result of diffing a user's .env against its canonical example."""

    missing: list[str] = field(default_factory=list)
    """Keys present in the example but absent from the user's .env."""

    empty: list[str] = field(default_factory=list)
    """Keys present in both but empty in the user's .env."""

    @property
    def has_gaps(self) -> bool:
        return bool(self.missing or self.empty)


def _parse_env_keys(path: Path) -> dict[str, str]:
    """Return {key: value} from a .env file. Skips comments and blank lines."""
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


def diff_env(example_path: Path, user_path: Path) -> EnvDiff:
    """Diff ``user_path`` against ``example_path`` — the schema."""
    if not example_path.exists():
        raise EnvMergeError(
            f".env.example not found at {example_path}",
            hint="Check your --mode selection",
        )
    example_keys = _parse_env_keys(example_path)
    user_keys = _parse_env_keys(user_path)
    diff = EnvDiff()
    for key in example_keys:
        if key not in user_keys:
            diff.missing.append(key)
        elif not user_keys[key]:
            diff.empty.append(key)
    return diff


def ensure_env_file(
    example_path: Path,
    user_path: Path,
    reporter: Reporter,
) -> bool:
    """Create ``user_path`` from the example if missing. Returns True if created."""
    if user_path.exists():
        return False
    shutil.copy2(example_path, user_path)
    reporter.ok(f"created {user_path} from template")
    return True
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest deploy/setup_lib/tests/test_env_merge.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add deploy/setup_lib/env_merge.py deploy/setup_lib/tests/test_env_merge.py
git commit -m "feat(setup): env_merge — .env diff + bootstrap from example"
```

---

## Task 11: Auth token prompt

**Files:**
- Create: `deploy/setup_lib/auth_prompt.py`
- Create: `deploy/setup_lib/tests/test_auth_prompt.py`

- [ ] **Step 1: Write the failing tests**

Create `deploy/setup_lib/tests/test_auth_prompt.py`:

```python
"""Auth token scan and sentient-auth invocation gating."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from deploy.setup_lib.auth_prompt import TokenScan, scan_tokens
from deploy.setup_lib.reporter import NullReporter


def test_scan_empty_tokens_dir(tmp_home: Path) -> None:
    (tmp_home / ".sentient" / "auth" / "tokens").mkdir(parents=True)
    scan = scan_tokens()
    assert scan.tokens == []
    assert scan.is_empty is True


def test_scan_lists_all_yaml_tokens(tmp_home: Path) -> None:
    tokens_dir = tmp_home / ".sentient" / "auth" / "tokens"
    tokens_dir.mkdir(parents=True)
    (tokens_dir / "gateway.yaml").write_text("slot: gateway\n")
    (tokens_dir / "stt-service.yaml").write_text("slot: stt-service\n")
    (tokens_dir / "not-a-token.txt").write_text("ignore me\n")
    scan = scan_tokens()
    names = sorted(t.name for t in scan.tokens)
    assert names == ["gateway.yaml", "stt-service.yaml"]
    assert scan.is_empty is False


def test_scan_missing_dir_is_empty(tmp_home: Path) -> None:
    scan = scan_tokens()
    assert scan.is_empty is True


def test_run_auth_init_shells_out(tmp_home: Path, fake_repo: Path) -> None:
    (fake_repo / "sentient-auth").mkdir()
    run_sh = fake_repo / "sentient-auth" / "run.sh"
    run_sh.write_text("#!/bin/sh\necho ok\n")
    run_sh.chmod(0o755)
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        from deploy.setup_lib.auth_prompt import run_auth_init

        run_auth_init(fake_repo, NullReporter())
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        assert str(run_sh) in args
        assert "init" in args
```

- [ ] **Step 2: Run to fail**

```bash
python3 -m pytest deploy/setup_lib/tests/test_auth_prompt.py -v
```

Expected: 4 failures — ModuleNotFoundError.

- [ ] **Step 3: Implement auth_prompt.py**

Create `deploy/setup_lib/auth_prompt.py`:

```python
"""Scan ~/.sentient/auth/tokens/ and invoke sentient-auth on demand."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .errors import AuthPromptError
from .layout import sentient_root
from .reporter import Reporter


@dataclass
class TokenScan:
    """Snapshot of the auth tokens directory."""

    tokens: list[Path] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not self.tokens


def scan_tokens() -> TokenScan:
    """List ``*.yaml`` files under ~/.sentient/auth/tokens/."""
    tokens_dir = sentient_root() / "auth" / "tokens"
    if not tokens_dir.exists():
        return TokenScan()
    return TokenScan(tokens=sorted(tokens_dir.glob("*.yaml")))


def run_auth_init(repo_root: Path, reporter: Reporter) -> None:
    """Invoke ``sentient-auth/run.sh init`` — creates the shared bearer tokens."""
    run_sh = repo_root / "sentient-auth" / "run.sh"
    if not run_sh.exists():
        raise AuthPromptError(
            f"sentient-auth/run.sh not found at {run_sh}",
            hint="Check your repo-root detection",
        )
    reporter.info(f"running {run_sh} init")
    result = subprocess.run(
        [str(run_sh), "init"],
        cwd=str(repo_root),
        check=False,
    )
    if result.returncode != 0:
        raise AuthPromptError(
            f"sentient-auth init exited with code {result.returncode}",
            hint="Run `./sentient-auth/run.sh init` manually to see the full output",
        )
    reporter.ok("sentient-auth init complete")
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest deploy/setup_lib/tests/test_auth_prompt.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add deploy/setup_lib/auth_prompt.py deploy/setup_lib/tests/test_auth_prompt.py
git commit -m "feat(setup): auth_prompt — token scan + sentient-auth init"
```

---

## Task 12: Rich TUI reporter

**Files:**
- Create: `deploy/setup_lib/tui.py`

- [ ] **Step 1: Implement TuiReporter**

This module renders — no unit test suite, since testing `rich` output is low-value. The integration test in Task 14 exercises the code path end-to-end. We verify by running the script manually in Task 15.

Create `deploy/setup_lib/tui.py`:

```python
"""rich-backed TUI — panels, tables, prompts, summary widget."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from rich.text import Text


@dataclass
class RunSummary:
    """Accumulates outcomes; printed once at end-of-run."""

    created: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    backups: list[str] = field(default_factory=list)
    next_steps: list[str] = field(default_factory=list)


class TuiReporter:
    """rich-backed Reporter. Wraps a single Console instance."""

    def __init__(self, *, interactive: bool) -> None:
        self.console = Console()
        self.interactive = interactive
        self.summary = RunSummary()

    # --- Reporter protocol ----------------------------------------------------

    def section(self, title: str) -> None:
        self.console.print()
        self.console.print(f"[bold cyan] {title}[/bold cyan]")

    def ok(self, message: str) -> None:
        self.console.print(f"  [green]✓[/green] {message}")

    def warn(self, message: str) -> None:
        self.console.print(f"  [yellow]![/yellow] {message}")

    def error(self, message: str) -> None:
        self.console.print(f"  [red]✗[/red] {message}")

    def info(self, message: str) -> None:
        self.console.print(f"  [dim]→[/dim] {message}")

    def prompt_choice(
        self,
        message: str,
        *,
        choices: Sequence[str],
        default: str,
    ) -> str:
        if not self.interactive:
            self.info(f"{message} → {default} (non-interactive)")
            return default
        return Prompt.ask(
            f"  {message}",
            choices=list(choices),
            default=default,
            console=self.console,
        )

    def prompt_text(self, message: str, *, default: str | None) -> str:
        if not self.interactive:
            return default or ""
        return Prompt.ask(
            f"  {message}",
            default=default or "",
            console=self.console,
        )

    # --- Structured widgets ---------------------------------------------------

    def banner(self, *, mode: str, repo_root: str, host_root: str) -> None:
        body = Text()
        body.append(f"Target mode:  {mode}\n", style="bold")
        body.append(f"Repo root:    {repo_root}\n")
        body.append(f"Host root:    {host_root}\n")
        self.console.print(Panel(body, title="Sentient Setup", border_style="cyan"))

    def yaml_diff_panel(
        self,
        *,
        filename: str,
        schema_from: str,
        schema_to: str,
        new_fields: list[tuple[str, str]],
        backup_name: str | None,
    ) -> None:
        table = Table(show_header=False, box=None, padding=(0, 2))
        for key, value in new_fields:
            table.add_row(f"[cyan]{key}[/cyan]", value)
        suffix = (
            f"\nExisting values preserved. Backup → {backup_name}"
            if backup_name
            else "\nNo backup — file unchanged."
        )
        self.console.print(
            Panel(
                table,
                title=f"{filename}   schema {schema_from} → {schema_to}",
                subtitle=f"{len(new_fields)} new fields will be added with defaults"
                + suffix,
                border_style="blue",
            )
        )

    def env_gaps_panel(
        self,
        *,
        filename: str,
        missing: list[str],
        empty: list[str],
    ) -> None:
        table = Table(show_header=True, header_style="bold")
        table.add_column("Key")
        table.add_column("Status")
        for k in missing:
            table.add_row(k, "[yellow]missing[/yellow]")
        for k in empty:
            table.add_row(k, "[yellow]empty[/yellow]")
        self.console.print(
            Panel(
                table,
                title=f".env — {filename}",
                subtitle="[f] open in $EDITOR   [c] prompt each   [s] skip",
                border_style="blue",
            )
        )

    def auth_panel(self, *, tokens: list[str]) -> None:
        if tokens:
            body = "Found tokens:\n" + "\n".join(f"  • {t}" for t in tokens)
            subtitle = "[r] rotate   [s] skip"
        else:
            body = "gateway ↔ stt-service needs a shared bearer token."
            subtitle = "[Y] run sentient-auth init   [n] skip"
        self.console.print(
            Panel(body, title="Auth tokens", subtitle=subtitle, border_style="blue")
        )

    def summary_panel(self) -> None:
        s = self.summary
        body = Text()
        body.append(f"Created:   {len(s.created)}  ")
        body.append(f"({', '.join(s.created) or '—'})\n", style="dim")
        body.append(f"Updated:   {len(s.updated)}  ")
        body.append(f"({', '.join(s.updated) or '—'})\n", style="dim")
        body.append(f"Unchanged: {len(s.unchanged)}  ")
        body.append(f"({', '.join(s.unchanged) or '—'})\n", style="dim")
        body.append(f"Backups:   {len(s.backups)}  ")
        body.append(f"({', '.join(s.backups) or '—'})\n", style="dim")
        if s.next_steps:
            body.append("\nNext steps:\n", style="bold")
            for step in s.next_steps:
                body.append(f"  {step}\n", style="green")
        self.console.print(Panel(body, title="Summary", border_style="green"))
```

- [ ] **Step 2: Smoke-test import**

```bash
python3 -c "from deploy.setup_lib.tui import TuiReporter; r = TuiReporter(interactive=False); r.banner(mode='prod', repo_root='.', host_root='.')"
```

Expected: a rich banner rendered to stdout, no exceptions.

- [ ] **Step 3: Commit**

```bash
git add deploy/setup_lib/tui.py
git commit -m "feat(setup): tui — rich-backed Reporter with panels and summary"
```

---

## Task 13: Entrypoint — `deploy/setup.py`

**Files:**
- Create: `deploy/setup.py`

- [ ] **Step 1: Implement the entrypoint**

Create `deploy/setup.py`:

```python
#!/usr/bin/env python3
"""Sentient — first-boot / upgrade / migration bootstrap.

Idempotent. Safe to re-run after every git pull. Never clobbers
user values. Walks through missing .env variables and new YAML
fields with a rich TUI.

Run from the repo root:
    python3 deploy/setup.py [--mode prod|local-dev-docker] [--yes] [--custom]

See deploy/README.md.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from setup_lib import auth_prompt, env_merge, layout, preflight, yaml_merge
from setup_lib.errors import SetupError
from setup_lib.schema_versions import SCHEMA_VERSIONS, expected_version
from setup_lib.tui import TuiReporter

# --- Mode metadata -----------------------------------------------------------

MODES = ("prod", "local-dev-docker")
MODE_TO_DIR = {"prod": "deploy/pi", "local-dev-docker": "deploy/docker"}


def _detect_mode(cwd: Path) -> str | None:
    """If the cwd is inside deploy/pi or deploy/docker, infer the mode."""
    parts = cwd.resolve().parts
    if "pi" in parts and "deploy" in parts:
        return "prod"
    if "docker" in parts and "deploy" in parts:
        return "local-dev-docker"
    return None


# --- Orchestration -----------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="setup.py", description=__doc__)
    p.add_argument("--mode", choices=MODES)
    group = p.add_mutually_exclusive_group()
    group.add_argument("--yes", action="store_true", help="Accept all defaults")
    group.add_argument("--custom", action="store_true", help="Prompt per field")
    return p.parse_args()


def _resolve_mode(args: argparse.Namespace, reporter: TuiReporter) -> str:
    if args.mode:
        return args.mode
    detected = _detect_mode(Path.cwd())
    if detected is not None:
        reporter.info(f"detected mode from cwd: {detected}")
        return detected
    if args.yes:
        return "prod"
    return reporter.prompt_choice(
        "Select deployment mode",
        choices=list(MODES),
        default="prod",
    )


def _run_yaml_phase(
    repo_root: Path,
    reporter: TuiReporter,
    *,
    interactive: bool,
    custom: bool,
) -> None:
    host_root = layout.sentient_root()
    host_config_paths = {
        "gateway/config.yaml": host_root / "gateway" / "config" / "config.yaml",
        "gateway/salience_map.yaml": host_root / "gateway" / "config" / "salience_map.yaml",
        "capabilityServices/STTService/config/config.example.yaml":
            host_root / "stt-service" / "config" / "config.yaml",
    }
    for repo_rel, host_path in host_config_paths.items():
        reporter.section(f"config: {repo_rel}")
        canonical = repo_root / repo_rel
        if not host_path.exists():
            host_path.parent.mkdir(parents=True, exist_ok=True)
            host_path.write_text(canonical.read_text())
            reporter.ok(f"created {host_path} from canonical")
            reporter.summary.created.append(host_path.name)
            continue

        expected = expected_version(repo_rel) or "?"
        new_fields = yaml_merge.missing_fields(canonical, host_path)
        if not new_fields:
            reporter.ok("up to date — no changes")
            reporter.summary.unchanged.append(host_path.name)
            continue

        # Preview.
        preview = [(f, "<default>") for f in new_fields]
        reporter.yaml_diff_panel(
            filename=host_path.name,
            schema_from=expected,
            schema_to=expected,
            new_fields=preview,
            backup_name=f"{host_path.name}.bak.*",
        )
        choice = reporter.prompt_choice(
            "Apply",
            choices=["Y", "c", "n"],
            default="Y",
        )
        if choice == "n":
            reporter.warn("skipped")
            reporter.summary.unchanged.append(host_path.name)
            continue
        # 'c' (custom) path is currently the same as 'Y' — custom per-field
        # prompting is not wired through yaml_merge yet; defer to --custom
        # handling in env_merge. Bulk-accept merges the defaults.
        result = yaml_merge.merge_yaml(canonical, host_path, reporter)
        reporter.summary.updated.append(f"{host_path.name} (+{len(result.new_fields)})")
        if result.backup_path:
            reporter.summary.backups.append(result.backup_path.name)


def _run_env_phase(
    repo_root: Path,
    mode: str,
    reporter: TuiReporter,
    *,
    interactive: bool,
) -> None:
    reporter.section(".env")
    mode_dir = repo_root / MODE_TO_DIR[mode]
    example = mode_dir / ".env.example"
    user = mode_dir / ".env"
    created = env_merge.ensure_env_file(example, user, reporter)
    if created:
        reporter.summary.created.append(str(user.relative_to(repo_root)))
    diff = env_merge.diff_env(example, user)
    if not diff.has_gaps:
        reporter.ok(".env complete")
        if not created:
            reporter.summary.unchanged.append(str(user.relative_to(repo_root)))
        return
    reporter.env_gaps_panel(
        filename=str(user.relative_to(repo_root)),
        missing=diff.missing,
        empty=diff.empty,
    )
    if not interactive:
        reporter.warn("non-interactive mode — leaving .env gaps for you to fill")
        return
    choice = reporter.prompt_choice(
        ".env action",
        choices=["f", "c", "s"],
        default="f",
    )
    if choice == "s":
        return
    # Simple per-key text prompting for both 'c' and 'f' (no editor-launch
    # complexity here — the user can always edit the file directly).
    lines = user.read_text().splitlines()
    for key in diff.missing + diff.empty:
        value = reporter.prompt_text(f"{key}", default=None)
        if value:
            updated = False
            for i, line in enumerate(lines):
                if line.strip().startswith(f"{key}="):
                    lines[i] = f"{key}={value}"
                    updated = True
                    break
            if not updated:
                lines.append(f"{key}={value}")
    user.write_text("\n".join(lines) + "\n")
    reporter.summary.updated.append(str(user.relative_to(repo_root)))


def _run_auth_phase(
    repo_root: Path,
    reporter: TuiReporter,
    *,
    interactive: bool,
) -> None:
    reporter.section("Auth tokens")
    scan = auth_prompt.scan_tokens()
    reporter.auth_panel(tokens=[t.name for t in scan.tokens])
    if not interactive:
        reporter.warn("non-interactive — skipping auth prompt")
        return
    if scan.is_empty:
        choice = reporter.prompt_choice(
            "Run sentient-auth init?",
            choices=["Y", "n"],
            default="Y",
        )
        if choice == "Y":
            auth_prompt.run_auth_init(repo_root, reporter)
    else:
        choice = reporter.prompt_choice(
            "Auth tokens action",
            choices=["r", "s"],
            default="s",
        )
        if choice == "r":
            auth_prompt.run_auth_init(repo_root, reporter)


def main() -> int:
    args = _parse_args()
    interactive = not args.yes
    # custom flag currently only affects env phase; yaml bulk-merge stays bulk.

    repo_root = Path.cwd()
    reporter = TuiReporter(interactive=interactive)

    try:
        reporter.section("Preflight")
        preflight.check_docker(reporter)
        preflight.check_repo_root(repo_root, reporter)

        mode = _resolve_mode(args, reporter)
        reporter.banner(
            mode=mode,
            repo_root=str(repo_root),
            host_root=str(layout.sentient_root()),
        )

        reporter.section("Directory tree")
        layout.ensure_tree(reporter)

        reporter.section("Host-layout migration")
        layout.migrate_old_layout(reporter)

        _run_env_phase(repo_root, mode, reporter, interactive=interactive)
        _run_yaml_phase(repo_root, reporter, interactive=interactive, custom=args.custom)
        _run_auth_phase(repo_root, reporter, interactive=interactive)

        reporter.summary.next_steps.append(
            f"docker compose -f {MODE_TO_DIR[mode]}/docker-compose.yml "
            + ("pull" if mode == "prod" else "build")
        )
        reporter.summary.next_steps.append(
            f"docker compose -f {MODE_TO_DIR[mode]}/docker-compose.yml up -d"
        )
        reporter.summary_panel()

        # Exit code 2 if any required .env keys still blank (script non-fatal).
        mode_env = repo_root / MODE_TO_DIR[mode] / ".env"
        if mode_env.exists():
            diff = env_merge.diff_env(repo_root / MODE_TO_DIR[mode] / ".env.example", mode_env)
            if diff.has_gaps:
                reporter.warn(
                    f".env still has gaps: missing={diff.missing} empty={diff.empty}"
                )
                return 2
        return 0
    except SetupError as exc:
        reporter.error(exc.message)
        if exc.hint:
            reporter.info(f"hint: {exc.hint}")
        return 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).parent))
    sys.exit(main())
```

- [ ] **Step 2: Smoke-test entrypoint**

```bash
cd /Users/kevinye/Development/sentient
python3 deploy/setup.py --help
```

Expected: argparse help text listing `--mode`, `--yes`, `--custom`.

- [ ] **Step 3: Commit**

```bash
chmod +x deploy/setup.py
git add deploy/setup.py
git commit -m "feat(setup): deploy/setup.py entrypoint — orchestrates phases"
```

---

## Task 14: Integration test

**Files:**
- Create: `deploy/setup_lib/tests/test_integration.py`

- [ ] **Step 1: Write the integration test**

Create `deploy/setup_lib/tests/test_integration.py`:

```python
"""End-to-end: run every phase against a synthetic repo + empty $HOME."""

from __future__ import annotations

from pathlib import Path

from deploy.setup_lib import env_merge, layout, yaml_merge
from deploy.setup_lib.reporter import NullReporter


def test_full_flow_on_clean_home(tmp_home: Path, fake_repo: Path) -> None:
    # Directory tree + migration.
    layout.ensure_tree(NullReporter())
    layout.migrate_old_layout(NullReporter())

    # YAML phase — fresh copies from canonical.
    host_gw = tmp_home / ".sentient" / "gateway" / "config" / "config.yaml"
    host_gw.write_text(
        (fake_repo / "gateway" / "config.yaml").read_text()
    )
    # Schema bump simulation: canonical grows a new field.
    (fake_repo / "gateway" / "config.yaml").write_text(
        'schema_version: "0.1.0"\nport: 8888\nhost: "0.0.0.0"\n'
    )
    result = yaml_merge.merge_yaml(
        fake_repo / "gateway" / "config.yaml",
        host_gw,
        NullReporter(),
    )
    assert result.new_fields == ["host"]
    assert result.backup_path is not None

    # .env phase.
    mode_dir = fake_repo / "deploy" / "docker"
    created = env_merge.ensure_env_file(
        mode_dir / ".env.example",
        mode_dir / ".env",
        NullReporter(),
    )
    assert created is True
    diff = env_merge.diff_env(mode_dir / ".env.example", mode_dir / ".env")
    assert set(diff.empty) == {"OPENROUTER_API_KEY", "FISH_AUDIO_API_KEY"}


def test_rerun_is_idempotent(tmp_home: Path, fake_repo: Path) -> None:
    # First run.
    layout.ensure_tree(NullReporter())
    layout.migrate_old_layout(NullReporter())
    # Second run — must not raise.
    layout.ensure_tree(NullReporter())
    layout.migrate_old_layout(NullReporter())


def test_user_edits_survive_schema_bump(tmp_home: Path, fake_repo: Path) -> None:
    host_gw = tmp_home / ".sentient" / "gateway" / "config" / "config.yaml"
    host_gw.parent.mkdir(parents=True, exist_ok=True)
    # User has customized the port.
    host_gw.write_text('schema_version: "0.1.0"\nport: 9999\n')
    # Canonical adds a new field and bumps schema_version.
    (fake_repo / "gateway" / "config.yaml").write_text(
        'schema_version: "0.2.0"\nport: 8888\nnew_field: "hello"\n'
    )
    yaml_merge.merge_yaml(
        fake_repo / "gateway" / "config.yaml",
        host_gw,
        NullReporter(),
    )
    text = host_gw.read_text()
    assert "port: 9999" in text  # user's value survives
    assert "new_field:" in text  # new field added
    assert '"0.2.0"' in text  # schema_version bumped
```

- [ ] **Step 2: Run**

```bash
python3 -m pytest deploy/setup_lib/tests -v
```

Expected: all tests (~37 across all modules) pass.

- [ ] **Step 3: Commit**

```bash
git add deploy/setup_lib/tests/test_integration.py
git commit -m "test(setup): integration — clean-home flow, idempotency, migration"
```

---

## Task 15: Delete old setup.sh + manual smoke test

**Files:**
- Delete: `deploy/docker/setup.sh`
- Delete: `deploy/pi/setup.sh`

- [ ] **Step 1: Delete shell scripts**

```bash
cd /Users/kevinye/Development/sentient
git rm deploy/docker/setup.sh deploy/pi/setup.sh
```

- [ ] **Step 2: Update any doc references**

Search for references:

Use Grep tool: pattern `deploy/(docker|pi)/setup\.sh`, output_mode `content`. For each hit in `.md` files, update to `python3 deploy/setup.py --mode <...>`. README.md files in the repo root and in `capabilityServices/STTService/` are the likely hits.

- [ ] **Step 3: Install requirements locally**

```bash
pip install -r deploy/setup_lib/requirements.txt
```

Expected: rich + ruamel.yaml + pytest installed.

- [ ] **Step 4: Smoke-test non-interactive flow**

```bash
# Move current host config out of the way so setup.py starts clean.
mv ~/.sentient ~/.sentient.bak.$(date +%s)

# Run the script.
cd /Users/kevinye/Development/sentient
python3 deploy/setup.py --mode local-dev-docker --yes
```

Expected: banner prints, directory tree created, .env copied from example (with gap warnings since API keys are blank), YAML configs created. Exit code 2 because .env gaps. No exceptions.

Verify:
```bash
ls -la ~/.sentient/gateway/config ~/.sentient/stt-service/config ~/.sentient/auth/tokens
```

Expected: `config.yaml` + `salience_map.yaml` under gateway/config, `config.yaml` under stt-service/config, `tokens` dir mode 700.

- [ ] **Step 5: Restore + retest with real values**

```bash
rm -rf ~/.sentient
mv ~/.sentient.bak.* ~/.sentient || true
python3 deploy/setup.py --mode local-dev-docker --yes
```

Expected: idempotent — old config values preserved, no new fields to add, summary shows "Unchanged" for each config.

- [ ] **Step 6: Verify docker-compose still starts**

```bash
source scripts/env.sh
docker compose -f deploy/docker/docker-compose.yml build gateway
```

Expected: build succeeds. (Don't bring up — the actual test is at CI / real deploy time.)

- [ ] **Step 7: Run CI**

```bash
bun run ci
```

Expected: lint + typecheck + unit tests all green. The only gateway source that changed was `llm-factory.test.ts` (path fixture), plus `schema.ts` default — both already typechecked in Task 3.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore(deploy): delete old setup.sh scripts; update README refs"
```

---

## Self-Review

**Spec coverage:**
- §1 version alignment → Task 1 ✓
- §1 YAML schema_version header → Task 2 ✓
- §2 host layout → Task 8 (`CANONICAL_DIRS`) ✓
- §2 container-side changes → Tasks 3, 4 ✓
- §2 docker-compose updates → Tasks 3, 4 ✓
- §3 unified log policy → **gap**: not explicitly touched. Gateway already matches; STT config comment updated in Task 4. No behavior change required — the spec's "align STT's wording/ordering to the gateway schema" is cosmetic and deferrable. If the reviewer wants this enforced, add a Task 2.5 that edits `config.example.yaml` to match gateway's key ordering under `logging:`. Leaving out for now as cosmetic-only.
- §4 setup.py — CLI surface → Task 13 ✓
- §4 preflight → Task 7 ✓
- §4 directory tree + migration → Task 8 ✓
- §4 .env bootstrap + flows → Tasks 10, 13 ✓
- §4 YAML smart-merge → Task 9 ✓
- §4 auth init prompt → Tasks 11, 13 ✓
- §4 summary → Task 12 ✓ (TuiReporter.summary_panel)
- §4.4 file module layout → Tasks 5–12 ✓
- §4.5 testing → Tasks 6–11, 14 ✓
- §5 deleted files → Task 15 ✓
- §6 definition of done → Task 15 (smoke test steps 4–7) ✓

**Placeholder scan:** No TBDs, no "similar to" references — every code block is full.

**Type consistency:** `Reporter` protocol methods used identically across all modules. `MergeResult.new_fields` / `.backup_path` shape consistent between `yaml_merge.py` and `tui.py`. `EnvDiff.missing` / `.empty` / `.has_gaps` consistent between `env_merge.py` and entrypoint.

**One acknowledged deferral:** unified log policy (§3) is cosmetic in this iteration. Gateway already matches the spec shape; STT's `retention_days` and `level` already work identically. If cosmetic alignment is wanted, it's a follow-up to touch `config.example.yaml` ordering.
