## What this changes

(One focused paragraph.)

## Why

(Explain the outcome and link the related issue when one exists.)

## How to verify

- (List the narrow checks you ran.)
- (State whether local-stack or device verification was required.)

## Checklist

- [ ] Lint passes (`bun run lint`)
- [ ] Typecheck passes (`bun run typecheck`)
- [ ] Relevant tests pass (`bun run test:unit` or narrower package checks)
- [ ] `git diff --check` passes
- [ ] Stable contracts, regressions, or security boundaries have appropriate tests
- [ ] Active docs and agent rules match behavior changed by this PR
- [ ] No credentials, private user data, message text, transcripts, or raw audio are included
- [ ] Commits use Conventional Commits and include `Co-Authored-By` when applicable
