import SwiftUI

/// Shared semantic chip for scope and group filters.
struct CalendarFilterChip: View {
    let label: String
    let selected: Bool
    let accessibilityPrefix: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        DesignSelectableButton(
            accessibilityLabel: "\(accessibilityPrefix), \(label)",
            state: selected ? .selected : .normal,
            accessibilityId: identifier,
            pressedScale: CalendarSurfaceLayout.pressedScale,
            action: action
        ) {
            Text(label)
                .font(Typo.mono(TypeScale.xs))
                .foregroundStyle(selected ? DuskColors.ink : DuskColors.ink3)
                .padding(.horizontal, CalendarSurfaceLayout.filterHorizontalPadding)
                .frame(minHeight: CalendarSurfaceLayout.minimumTarget)
                .background(selected ? DuskColors.paper : .clear, in: Capsule())
                .overlay(Capsule().stroke(selected ? DuskColors.line : DuskColors.lineSoft))
        }
    }
}

/// Tag and importance filters retain their compact visual height while the
/// outer frame supplies the full native target size.
struct CalendarTagChip: View {
    let label: String
    let selected: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        DesignSelectableButton(
            accessibilityLabel: "Tag or importance, \(label)",
            state: selected ? .selected : .normal,
            accessibilityId: identifier,
            pressedScale: CalendarSurfaceLayout.pressedScale,
            action: action
        ) {
            Text(label)
                .font(Typo.mono(TypeScale.xs))
                .foregroundStyle(selected ? DuskColors.ink : DuskColors.ink3)
                .padding(.horizontal, CalendarSurfaceLayout.tagHorizontalPadding)
                .frame(height: CalendarSurfaceLayout.tagVisualHeight)
                .background(selected ? DuskColors.bgSunk : .clear, in: Capsule())
                .overlay(Capsule().stroke(DuskColors.lineSoft))
                .contentShape(Rectangle().inset(by: -5))
        }
    }
}

/// Search field primitive for Calendar filters. It keeps the filter owner in
/// control of debouncing and shared projection updates.
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
            trailingPadding: 0
        )
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .accessibilityLabel("Search calendar events")
    }
}
