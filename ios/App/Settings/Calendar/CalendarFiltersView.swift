import MobileData
import SwiftUI

enum CalendarFilterMapping {
    static func groups(filters: CalendarFilters, facets: CalendarFacetOptions) -> [String] {
        Array(Set(facets.groups).union(filters.groups)).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    static func tags(filters: CalendarFilters, facets: CalendarFacetOptions) -> [String] {
        Array(Set(facets.tags).union(filters.tags)).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    static func importances(filters: CalendarFilters, facets: CalendarFacetOptions) -> [Importance] {
        var values = facets.importances
        if let selected = filters.importance, !values.contains(selected) { values.append(selected) }
        return Importance.allCases.filter(values.contains)
    }

    static func replacing(
        _ filters: CalendarFilters,
        scope: CalendarScope? = nil,
        groups: Set<String>? = nil,
        tags: Set<String>? = nil,
        importance: Importance?? = nil,
        text: String? = nil
    ) -> CalendarFilters {
        filters.doCopy(
            scope: scope ?? filters.scope,
            groups: groups ?? filters.groups,
            tags: tags ?? filters.tags,
            importance: importance ?? filters.importance,
            text: text ?? filters.text
        )
    }

    static func toggling(_ value: String, in selected: Set<String>) -> Set<String> {
        var result = selected
        if result.contains(value) { result.remove(value) } else { result.insert(value) }
        return result
    }

    static func scopeLabel(_ scope: CalendarScope) -> String {
        switch scope {
        case .private: "Private"
        case .household: "Household"
        case .all: "All"
        }
    }

    static func importanceLabel(_ importance: Importance) -> String {
        switch importance {
        case .normal: "Normal"
        case .important: "Important"
        case .pinned: "Pinned"
        }
    }
}

struct CalendarFiltersView: View {
    let filters: CalendarFilters
    let facets: CalendarFacetOptions
    let onChange: (CalendarFilters) -> Void
    let onSearch: (String) -> Void

    var body: some View {
        VStack(spacing: Space.sm) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.sm) {
                    ForEach(CalendarScope.allCases, id: \.self) { scope in
                        CalendarFilterChip(
                            label: CalendarFilterMapping.scopeLabel(scope),
                            selected: filters.scope == scope,
                            accessibilityPrefix: "Scope",
                            identifier: "calendar-filter-scope-\(scope.name.lowercased())"
                        ) {
                            onChange(CalendarFilterMapping.replacing(filters, scope: scope))
                        }
                    }
                    ForEach(Array(CalendarFilterMapping.groups(filters: filters, facets: facets).enumerated()), id: \.element) { index, group in
                        CalendarFilterChip(
                            label: group,
                            selected: filters.groups.contains(group),
                            accessibilityPrefix: "Group",
                            identifier: "calendar-filter-group-\(index)"
                        ) {
                            onChange(CalendarFilterMapping.replacing(
                                filters,
                                groups: CalendarFilterMapping.toggling(group, in: filters.groups)
                            ))
                        }
                    }
                }
                .padding(.horizontal, CalendarSurfaceLayout.contentInset)
            }
            .padding(.horizontal, -CalendarSurfaceLayout.contentInset)
            .accessibilityLabel("Calendar scope and group filters")

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.sm) {
                    ForEach(Array(CalendarFilterMapping.tags(filters: filters, facets: facets).enumerated()), id: \.element) { index, tag in
                        CalendarTagChip(label: tag, selected: filters.tags.contains(tag), identifier: "calendar-filter-tag-\(index)") {
                            onChange(CalendarFilterMapping.replacing(
                                filters,
                                tags: CalendarFilterMapping.toggling(tag, in: filters.tags)
                            ))
                        }
                    }
                    CalendarTagChip(label: "Any importance", selected: filters.importance == nil,
                                    identifier: "calendar-filter-importance-any") {
                        onChange(CalendarFilterMapping.replacing(filters, importance: .some(nil)))
                    }
                    ForEach(CalendarFilterMapping.importances(filters: filters, facets: facets), id: \.self) { importance in
                        CalendarTagChip(
                            label: CalendarFilterMapping.importanceLabel(importance),
                            selected: filters.importance == importance,
                            identifier: "calendar-filter-importance-\(importance.name.lowercased())"
                        ) {
                            onChange(CalendarFilterMapping.replacing(filters, importance: .some(importance)))
                        }
                    }
                }
                .padding(.horizontal, CalendarSurfaceLayout.contentInset)
            }
            .padding(.horizontal, -CalendarSurfaceLayout.contentInset)
            .accessibilityLabel("Calendar tag and importance filters")

            HStack(spacing: Space.sm) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(DuskColors.ink3)
                    .accessibilityHidden(true)
                TextField("Search events", text: Binding(get: { filters.text }, set: onSearch))
                    .font(CalendarFont.ui(TypeScale.sm))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Search calendar events")
                    .accessibilityIdentifier("calendar-filter-search")
                if !filters.text.isEmpty {
                    Button("Clear search", systemImage: "xmark.circle.fill") { onSearch("") }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(DuskColors.ink3)
                        .frame(minWidth: CalendarSurfaceLayout.minimumTarget, minHeight: CalendarSurfaceLayout.minimumTarget)
                }
            }
            .padding(.leading, Space.md)
            .frame(minHeight: CalendarSurfaceLayout.minimumTarget)
            .background(DuskColors.bgSunk, in: RoundedRectangle(cornerRadius: Radii.md))
            .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft))
        }
    }
}

private struct CalendarFilterChip: View {
    let label: String
    let selected: Bool
    let accessibilityPrefix: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(CalendarFont.mono(TypeScale.xs))
                .foregroundStyle(selected ? DuskColors.ink : DuskColors.ink3)
                .padding(.horizontal, 13)
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

private struct CalendarTagChip: View {
    let label: String
    let selected: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(CalendarFont.mono(TypeScale.xs))
                .foregroundStyle(selected ? DuskColors.ink : DuskColors.ink3)
                .padding(.horizontal, 10)
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
