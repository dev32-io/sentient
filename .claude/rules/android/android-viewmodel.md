---
paths:
  - "android/**/*.kt"
---
# Android ViewModel Rules

- Define a single `data class {Feature}UiState` per ViewModel.
- Expose state as `StateFlow` via `_uiState.asStateFlow()`.
- Never expose `MutableStateFlow` publicly.
- Mutate state only via `_uiState.value = _uiState.value.copy(...)`.
- Launch async work with `viewModelScope.launch`.
- Keep ViewModel methods non-suspend.
- Derive computed values as `val` properties on the UiState data class.
- Cancel in-flight jobs by storing and canceling `Job` references.

> When a rule is unclear, read `agents/docs/android-viewmodel-details.md`.
