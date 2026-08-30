# Security policy

## Reporting a vulnerability

Please do not report security vulnerabilities in a public issue, discussion, or
pull request. Use GitHub's private
[Report a vulnerability](https://github.com/dev32-io/sentient/security/advisories/new)
form instead.

Include the affected component and commit, the impact, minimal reproduction
steps, and any suggested mitigation. Do not include real household data,
credentials, prompts, transcripts, or audio. Use synthetic identifiers and
redacted diagnostics.

The maintainer will acknowledge a report as soon as practical, investigate it
privately, and coordinate disclosure after a fix or mitigation is available.
This is a personal open-source project, so no response-time SLA is promised.

## Supported versions

Sentient is developed from `develop` and does not currently publish supported
release branches. Security fixes are made against the current codebase. Older
commits and retired Raspberry Pi, Cerebrum, and container-gateway deployments
are unsupported.

## Secrets

Never commit provider keys, household credentials, signing material, private
configuration, transcripts, or raw audio. The repository uses staged secret
checks, Gitleaks in CI, and GitHub secret-scanning push protection, but these are
backstops rather than permission to store sensitive data in the repository.
