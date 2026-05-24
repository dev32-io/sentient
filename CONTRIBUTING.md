# Contributing to Sentient

Thanks for considering a contribution. This is a personal project run as
open source, so the bar is pragmatism over process — but a few things
will save us both time.

## Before you open a PR

- **Open an issue first** if the change is more than a one-liner. It
  saves you implementing something that turns out to conflict with
  in-flight work or roadmap direction.
- **Search existing issues + closed PRs.** The thing you want to fix may
  already be tracked or rejected.

## Setting up a dev environment

You'll need:
- Bun (https://bun.sh)
- Docker
- Python 3.11+ (for the STT service)
- Optionally: ESP-IDF v5.x for cube firmware work

Then:

```bash
git clone https://github.com/${OWNER}/sentient.git
cd sentient
source scripts/env.sh
bun install
bun run ci        # lint + typecheck + unit tests; should pass clean
```

## Running the stack locally

See `README.md` quick start. After you have a `.env` with provider keys:

```bash
docker compose -f deploy/docker/docker-compose.yml up -d
```

Open `https://localhost:8888/`.

## Coding standards

- **Rules live under `.claude/rules/`.** Cross-cutting rules are at the
  top level; subproject rules nest under
  `.claude/rules/<subproject>/`. Each rule file has a `paths:` glob in
  frontmatter so Claude Code auto-loads matching rules. These are also
  good context for human contributors — read the ones that apply to the
  area you're touching.
- **Style:** Biome handles lint + format (`bun run lint`).
- **Types:** strict TypeScript (`bun run typecheck`).
- **Tests:** Vitest. Mock at process boundaries only — see
  `.claude/rules/testing.md` for the full philosophy.

## Commit messages

Conventional Commits format: `type(scope): description`. Common types:
`feat`, `fix`, `refactor`, `chore`, `docs`, `test`. Subject under 72
chars. Body explains the *why* if not obvious from the diff.

If a commit was meaningfully shaped by Claude Code (or any other AI
pair-programming tool), include the `Co-Authored-By` trailer per the
[GitHub convention](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors).

## PR review

- One logical change per PR. If the diff covers two unrelated things,
  split it.
- Pass CI: lint + typecheck + unit tests + build.
- Update relevant docs (README / ARCHITECTURE / rules / agents/docs)
  where the change affects them.

## Reporting bugs

Use the `Bug report` issue template. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Relevant log excerpts (see `gateway/logs/` and `~/.sentient/gateway/logs/`)

## Reporting security issues

Do not open a public issue for security vulnerabilities. Email the
maintainer directly. A `SECURITY.md` with the contact address will land
post-v1.

## Code of conduct

See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
