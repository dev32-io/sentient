import SwiftUI

/// Shared semantic chip for scope and group filters.
struct CalendarFilterChip: View {
    let label: String
    let selected: Bool
    let accessibilityPrefix: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(Typo.mono(TypeScale.xs))
                .foregroundStyle(selected ? DuskColors.ink : DuskColors.ink3)
                .padding(.horizontal, CalendarSurfaceLayout.filterHorizontalPadding)
                .frame(minHeight: CalendarSurfaceLayout.minimumTarget)
                .background(selected ? DuskColors.paper : .clear, in: Capsule())
                .overlay(Capsule().stroke(selected ? DuskColors.line : DuskColors.lineSoft))
        }
        .buttonStyle(CalendarPressButtonStyle())
        .accessibilityLabel("\(accessibilityPrefix), \(label)")
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
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
        Button(action: action) {
            Text(label)
                .font(Typo.mono(TypeScale.xs))
                .foregroundStyle(selected ? DuskColors.ink : DuskColors.ink3)
                .padding(.horizontal, CalendarSurfaceLayout.tagHorizontalPadding)
                .frame(height: CalendarSurfaceLayout.tagVisualHeight)
                .background(selected ? DuskColors.bgSunk : .clear, in: Capsule())
                .overlay(Capsule().stroke(DuskColors.lineSoft))
                .contentShape(Rectangle().inset(by: -5))
        }
        .frame(minHeight: CalendarSurfaceLayout.minimumTarget)
        .buttonStyle(CalendarPressButtonStyle())
        .accessibilityLabel("Tag or importance, \(label)")
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

/// Search field primitive for Calendar filters. It keeps the filter owner in
/// control of debouncing and shared projection updates.
struct CalendarSearchField: View {
    let text: String
    let onSearch: (String) -> Void

    var body: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(DuskColors.ink3)
                .accessibilityHidden(true)
            TextField("Search events", text: Binding(get: { text }, set: onSearch))
                .font(Typo.ui(TypeScale.sm))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel("Search calendar events")
                .accessibilityIdentifier("calendar-filter-search")
            if !text.isEmpty {
                Button("Clear search", systemImage: "xmark.circle.fill") { onSearch("") }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(DuskColors.ink3)
                    .frame(minWidth: CalendarSurfaceLayout.minimumTarget,
                           minHeight: CalendarSurfaceLayout.minimumTarget)
            }
        }
        .padding(.leading, Space.md)
        .frame(minHeight: CalendarSurfaceLayout.minimumTarget)
        .designWell()
    }
}
