# iOS Testing — Details & Examples

## Fake Implementation Pattern

```swift
final class FakeJournalRepository: JournalRepositoryProtocol {
    private var entries: [JournalEntry] = []

    func getAll() -> [JournalEntry] { entries }
    func save(_ entry: JournalEntry) { entries.append(entry) }
}
```

## Async Test Pattern

```swift
func testLoadsEntries() async {
    let repo = FakeJournalRepository()
    let viewModel = JournalViewModel(repository: repo)

    await viewModel.loadEntries()

    XCTAssertEqual(viewModel.entries.count, expectedCount)
}
```
