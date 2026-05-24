# Android Testing — Details & Examples

## Fake Implementation Pattern

Use hand-written fakes instead of mocking frameworks (Mockito, MockK).

```kotlin
class FakeJournalRepository : JournalRepository {
    private val entries = mutableListOf<JournalEntry>()

    override suspend fun getAll(): List<JournalEntry> = entries.toList()
    override suspend fun save(entry: JournalEntry) { entries.add(entry) }
}
```

## Coroutine Test Pattern

```kotlin
@Test
fun `loads entries on init`() = runTest {
    val repo = FakeJournalRepository()
    val viewModel = JournalViewModel(repo)

    advanceUntilIdle()

    assertEquals(expected, viewModel.uiState.value.entries)
}
```
