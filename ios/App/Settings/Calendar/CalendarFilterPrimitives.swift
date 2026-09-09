import SwiftUI

/// Calendar scope selection keeps the shared checkbox's native Toggle semantics
/// while the filter owner maps its change back to CalendarFilters.
struct CalendarScopeCheckbox: View {
    let label: String
    let selected: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        DesignCheckbox(
            title: label,
            isOn: Binding(
                get: { selected },
                set: { _ in action() }
            ),
            accessibilityId: identifier
        )
    }
}

/// Calendar facets use the shared fixed-width-state chip without adding local
/// capsule fills, strokes, or button styling.
struct CalendarFilterChip: View {
    let label: String
    let selected: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        DesignChip(
            title: label,
            selected: selected,
            accessibilityId: identifier,
            action: action
        )
    }
}

/// Search remains parent-owned so existing debounce and projection behavior is
/// unchanged. The panel uses the reviewed icon-only field label composition.
struct CalendarSearchField: View {
    let text: String
    let onSearch: (String) -> Void

    var body: some View {
        DesignSearchField(
            prompt: "Search events",
            query: Binding(get: { text }, set: onSearch),
            accessibilityId: "calendar-filter-search",
            onClear: text.isEmpty ? nil : { onSearch("") },
            textFont: Typo.ui(TypeScale.sm),
            trailingPadding: 0,
            showsTitle: false,
            showsSearchIcon: true
        )
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .accessibilityLabel("Search calendar events")
    }
}
