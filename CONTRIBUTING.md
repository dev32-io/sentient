# Contributing to Sentient

Sentient is a personal, open-source family assistant. Keep contributions narrow,
practical, and consistent with the current architecture.

## Before starting

- Read [`AGENTS.md`](AGENTS.md) and the rules for the area you will change.
- Search existing issues and pull requests.
- Open an issue before a substantial change so its product and architecture
  boundary can be agreed first.
- Never include credentials, `.env` files, private state, transcripts, or audio.

## Development setup

The supported full stack runs on Apple-silicon macOS. Install the prerequisites
and native service environments described in the
[README quick start](README.md#run-the-local-stack), including Gitleaks for the
pre-commit secret scan. The supported Bun version is recorded in
[`.bun-version`](.bun-version). Then install JavaScript dependencies:

```bash
git clone <fork-url> sentient
cd sentient
source scripts/env.sh
bun install
bun run ci
```

Cube work additionally requires the repository-supported ESP-IDF toolchain.
Android and iOS setup is documented in
[`android/README.md`](android/README.md) and [`ios/README.md`](ios/README.md).

## Run the local stack

Source the environment in each new shell, then use the root stack commands:

```bash
source scripts/env.sh
bun run dev
bun run stack:status
bun run stack:down
```

Open <https://localhost/> after startup. `https://localhost:8888` is the
gateway's loopback diagnostic endpoint, not the client URL.

Do not use `docker compose up` for the current stack. The gateway is a native
host process and supervises native services and Docker addons. Do not run the
gateway with `bun --hot`; the development path uses process-restarting
`bun --watch` through `bun run dev`.

## Make a change

- Preserve unrelated work and keep one logical change per pull request.
- Reuse existing boundaries and dependencies before adding new ones.
- Keep the append-only session store authoritative; do not add conversation
  mirrors or ambient current-user authority.
- Treat model output and tool results as untrusted. A tool call is not
  authorization.
- Do not log prompts, messages, transcripts, raw frames, secrets, or audio.
- Update current documentation when behavior or commands change. Preserve dated
  design and investigation records unless the task explicitly changes them.

TypeScript is formatted and linted with Biome. Follow the surrounding Swift,
Kotlin, Python, and ESP-IDF conventions for their subprojects.

## Checks

Run the narrowest relevant test while iterating, then the affected package
checks. Common root checks are:

```bash
source scripts/env.sh
bun run lint
bun run typecheck
bun run test:unit
# all three
bun run ci

git diff --check
```

Tests should protect wire contracts, state machines, security controls, and
reported regressions. Avoid tests for trivial wiring or presentation details
already covered at a stable consumer boundary. Local end-to-end tests use the
real local stack; never drive them against production.

## Pull requests

Use Conventional Commits: `type(scope): description`, with a concise subject
and a body explaining non-obvious decisions. A pull request should:

- explain the behavior change and its boundary;
- name the checks run and any expected failure;
- include relevant documentation changes;
- avoid generated files, unrelated formatting, and drive-by refactors.

If an AI tool materially shaped a commit, use GitHub's documented co-author
trailer convention.

## Bugs and security

For a bug, include expected behavior, actual behavior, reproduction steps, and
sanitized diagnostics. Do not include user content or secrets in logs or issue
attachments.

Do not report vulnerabilities in a public issue. Follow the private reporting
instructions in [`SECURITY.md`](SECURITY.md).

Be respectful and follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
