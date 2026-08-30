# iOS filter-bar checks

- iOS setup/project generation: passed.
- Focused `VisualDiffCaptureTests`: 41 tests passed, capture-request test intentionally skipped to avoid the shared serialized request.
- Full iOS suite: 73 XCTest tests and 123 Swift Testing tests passed; capture-request test intentionally skipped.
- Signed simulator build: passed with `ARCHS=arm64`, `ONLY_ACTIVE_ARCH=YES`, and `CODE_SIGNING_ALLOWED=YES`.
- Binary: Mach-O arm64.
- Codesign: valid on disk; satisfies designated requirement.
- Visual tools: 10/10 tests passed after installing the pinned package-lock dependencies.
- iOS design boundary: base and current both report the same 71 pre-existing violations; byte-for-byte diff is empty.
- `git diff --check`: passed before evidence staging.
