# Task Acceptance: Make repository Gradle checks discover Homebrew JDK 21

## Deliverables

- Sourcing scripts/env.sh consistently selects the installed JDK 21 on Apple-silicon development and harness shells, so Gradle does not depend on an interactive shell PATH or the macOS Java registry.

## Acceptance

- A minimal harness shell can source scripts/env.sh and run ./gradlew --version
- Gradle reports launcher and daemon JVM 21
- A valid caller-supplied JAVA_HOME is respected
- No JDK 17 requirement or privileged system mutation is introduced

## Boundary Proof

- Clean-shell command output pins Java 21 selection and Gradle launcher/daemon versions
