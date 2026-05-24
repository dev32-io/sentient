# Git Workflow Rules

- Work on `feature/*` branches only. Never push to `main` or `develop` directly.
- Commit message format: `type(scope): description` (feat, fix, refactor, test, chore, docs).
- One logical change per commit. Atomic commits.
- Before merging to develop: self-review diff, simplify, run quality gate, verify all tests pass.
- Merge feature branch into develop when all checks pass. Delete feature branch after merge.
