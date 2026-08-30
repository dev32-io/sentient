# Checks

- Focused `VisualDiffCaptureTests`: passed, 10 executed / 1 expected capture-request skip / 0 failures.
- Full iOS test suite: passed, 123 Swift tests plus XCTest suite; 0 failures.
- Signed iOS Simulator build: passed. Existing linker warnings note that bundled Opus objects target iOS Simulator 18.5 while the app links at 18.0.
- Visual-tool unit tests: passed, 6 tests / 0 failures.
- `git diff --check`: passed.
