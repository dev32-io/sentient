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

    static let visibleScopes: [CalendarScope] = [.private, .household]

    static func scopeLabel(_ scope: CalendarScope) -> String {
        switch scope {
        case .private: "Private"
        case .household: "Household"
        case .all: "All"
        }
    }

    static func isScopeSelected(_ scope: CalendarScope, in filters: CalendarFilters) -> Bool {
        filters.scope == .all || filters.scope == scope
    }

    /// Shared CalendarFilters currently models scope as private, household, or
    /// both (`all`). The native checkbox composition therefore keeps the last
    /// scope selected rather than manufacturing an iOS-only no-match state.
    static func togglingScope(_ scope: CalendarScope, in filters: CalendarFilters) -> CalendarFilters {
        var selected = Set(visibleScopes.filter { isScopeSelected($0, in: filters) })
        if selected.contains(scope) { selected.remove(scope) } else { selected.insert(scope) }
        let mapped: CalendarScope
        if selected == Set(visibleScopes) { mapped = .all }
        else if let remaining = selected.first { mapped = remaining }
        else { mapped = filters.scope }
        return replacing(filters, scope: mapped)
    }

    static func importanceLabel(_ importance: Importance) -> String {
        switch importance {
        case .normal: "Normal"
        case .important: "Important"
        case .pinned: "Pinned"
        }
    }

    static func togglingImportance(_ importance: Importance, in filters: CalendarFilters) -> CalendarFilters {
        replacing(filters, importance: .some(filters.importance == importance ? nil : importance))
    }

    static func activeCount(in filters: CalendarFilters) -> Int {
        (filters.scope == .all ? 0 : 1)
            + filters.groups.count
            + filters.tags.count
            + (filters.importance == nil ? 0 : 1)
            + (filters.text.isEmpty ? 0 : 1)
    }

    static func resetting(_ filters: CalendarFilters) -> CalendarFilters {
        replacing(
            filters,
            scope: .all,
            groups: Set<String>(),
            tags: Set<String>(),
            importance: .some(nil),
            text: ""
        )
    }
}

struct CalendarFiltersView: View {
    let filters: CalendarFilters
    let facets: CalendarFacetOptions
    let onChange: (CalendarFilters) -> Void
    let onSearch: (String) -> Void

    @State private var groupsExpanded = false
    @State private var tagsExpanded = false

    private var activeCount: Int { CalendarFilterMapping.activeCount(in: filters) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            CalendarSearchField(text: filters.text, onSearch: onSearch)
            scopes
            importance
            disclosures
            clearButton
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Calendar filters")
    }

    private var scopes: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            DesignGroupHeader(title: "Calendars")
            VStack(alignment: .leading, spacing: 0) {
                ForEach(CalendarFilterMapping.visibleScopes, id: \.self) { scope in
                    CalendarScopeCheckbox(
                        label: CalendarFilterMapping.scopeLabel(scope),
                        selected: CalendarFilterMapping.isScopeSelected(scope, in: filters),
                        identifier: "calendar-filter-scope-\(scope.name.lowercased())"
                    ) {
                        onChange(CalendarFilterMapping.togglingScope(scope, in: filters))
                    }
                }
            }
        }
    }

    private var importance: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            DesignGroupHeader(title: "Importance")
            CenteredFlowLayout(spacing: Space.xs, alignment: .leading) {
                ForEach(CalendarFilterMapping.importances(filters: filters, facets: facets), id: \.self) { value in
                    CalendarFilterChip(
                        label: CalendarFilterMapping.importanceLabel(value),
                        selected: filters.importance == value,
                        identifier: "calendar-filter-importance-\(value.name.lowercased())"
                    ) {
                        onChange(CalendarFilterMapping.togglingImportance(value, in: filters))
                    }
                }
            }
        }
    }

    private var disclosures: some View {
        VStack(alignment: .leading, spacing: 0) {
            facetDisclosure(
                title: "Groups",
                values: CalendarFilterMapping.groups(filters: filters, facets: facets),
                selected: filters.groups,
                isExpanded: groupsExpanded,
                identifier: "calendar-filter-groups"
            ) {
                groupsExpanded.toggle()
            } onSelect: { group in
                onChange(CalendarFilterMapping.replacing(
                    filters,
                    groups: CalendarFilterMapping.toggling(group, in: filters.groups)
                ))
            }

            facetDisclosure(
                title: "Tags",
                values: CalendarFilterMapping.tags(filters: filters, facets: facets),
                selected: filters.tags,
                isExpanded: tagsExpanded,
                identifier: "calendar-filter-tags"
            ) {
                tagsExpanded.toggle()
            } onSelect: { tag in
                onChange(CalendarFilterMapping.replacing(
                    filters,
                    tags: CalendarFilterMapping.toggling(tag, in: filters.tags)
                ))
            }
        }
    }

    private func facetDisclosure(
        title: String,
        values: [String],
        selected: Set<String>,
        isExpanded: Bool,
        identifier: String,
        onToggle: @escaping () -> Void,
        onSelect: @escaping (String) -> Void
    ) -> some View {
        DesignDisclosureGroup(isExpanded: isExpanded) {
            DesignDisclosureButton(
                isExpanded: isExpanded,
                accessibilityLabel: "\(isExpanded ? "Collapse" : "Expand") \(title)",
                accessibilityId: identifier,
                action: onToggle
            ) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(title)
                        .font(Typo.ui(TypeScale.base, .medium))
                        .foregroundStyle(DuskColors.ink2)
                    Text(selected.isEmpty ? "None selected" : "\(selected.count) selected")
                        .font(Typo.ui(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink3)
                }
            }
        } content: {
            CenteredFlowLayout(spacing: Space.xs, alignment: .leading) {
                ForEach(Array(values.enumerated()), id: \.element) { index, value in
                    CalendarFilterChip(
                        label: value,
                        selected: selected.contains(value),
                        identifier: "calendar-filter-\(title == "Groups" ? "group" : "tag")-\(index)"
                    ) {
                        onSelect(value)
                    }
                }
            }
        }
    }

    private var clearButton: some View {
        DesignTextButton(
            title: "Clear filters",
            state: activeCount == 0 ? .disabled : .normal,
            accessibilityId: "calendar-filter-clear"
        ) {
            onChange(CalendarFilterMapping.resetting(filters))
        }
        .frame(maxWidth: .infinity)
    }
}
