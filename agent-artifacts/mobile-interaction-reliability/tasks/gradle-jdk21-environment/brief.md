# Task Brief: Make repository Gradle checks discover Homebrew JDK 21

## Contribution Goal

Sourcing scripts/env.sh consistently selects the installed JDK 21 on Apple-silicon development and harness shells, so Gradle does not depend on an interactive shell PATH or the macOS Java registry.

## Boundary — Included

- Portable JDK 21 discovery in scripts/env.sh
- JAVA_HOME and PATH setup without overwriting a valid caller-selected JAVA_HOME
- Clean-shell regression proof for Gradle 8.13 on Java 21

## Required Work

- 1. Extend scripts/env.sh with a small Java setup section that keeps an existing valid JAVA_HOME, otherwise discovers JDK 21 via /usr/libexec/java_home when registered or Homebrew prefixes on Apple silicon/Intel, and prepends JAVA_HOME/bin to PATH.
- 2. Prefer JDK 21; do not require, install, link, or update Homebrew and do not use JDK 17 as the project default.
- 3. Fail with a concise actionable diagnostic only when no runnable Java can be found. Keep the script source-safe and portable for non-macOS environments.
- 4. Add a shell-level regression check that starts with a minimal macOS PATH, sources scripts/env.sh, proves java and Gradle use major version 21, and does not mutate the machine.
- 5. Run Gradle --version and diff checks.

## Integration Expectation

Deliver this contribution for integration in stage foundation.

## Context

- The harness launches with a minimal PATH where /usr/bin/java is only a stub and /usr/libexec/java_home sees no registered runtime.
- Homebrew openjdk@21 21.0.12 is installed keg-only at /opt/homebrew/opt/openjdk@21; Gradle 8.13 runs successfully with that JAVA_HOME and PATH.
- The prior check-manifest workaround hard-coded openjdk@17. Replace it with the repository environment contract rather than requiring JDK 17.

## Boundary — Excluded

- Installing or updating a JDK
- Creating a privileged /Library/Java symlink
- Changing Gradle, AGP, Kotlin, JVM bytecode targets, or application code
- Repairing the unrelated product-tool catalog Android compilation regression

## Interfaces and Dependencies

- scripts/env.sh remains the repository-wide environment entry point required by AGENTS.md.
- All managed Gradle checks consume this setup by sourcing scripts/env.sh rather than embedding a JDK path.
