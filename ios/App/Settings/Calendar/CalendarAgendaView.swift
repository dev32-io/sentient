import CryptoKit
import Foundation
import MobileData
import SwiftUI

struct CalendarAgendaView: View {
    let sections: [CalendarAgendaSlice]
    let locale: CalendarLocale
    let emptyMessage: String
    let openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding
    let onEvent: (CalendarProjectedEvent) -> Void

    var body: some View {
        LazyVStack(spacing: Space.lg) {
            if sections.isEmpty {
                CalendarEmptyState(message: emptyMessage)
            } else {
                ForEach(sections) { section in
                    VStack(spacing: Space.sm) {
                        let heading = CalendarSurfaceText.agendaHeading(section.date, locale: locale)
                        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                            Text(heading.date)
                                .font(Typo.display(TypeScale.xl, .medium))
                                .foregroundStyle(DuskColors.ink)
                            Text(heading.weekday)
                                .font(Typo.ui(TypeScale.sm))
                                .foregroundStyle(DuskColors.ink2)
                            Spacer()
                        }
                        .padding(.horizontal, CalendarSurfaceLayout.agendaDateInset)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(section.accessibilityLabel)
                        .accessibilityAddTraits(.isHeader)

                        ForEach(section.events, id: \.actionIdentity.stableKey) { event in
                            CalendarAgendaRow(event: event, openerFocus: openerFocus) { onEvent(event) }
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agenda")
    }
}

struct CalendarAgendaRow: View {
    let event: CalendarProjectedEvent
    let openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: action) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    accessibilityLayout
                } else {
                    standardLayout
                }
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .frame(maxWidth: .infinity, minHeight: CalendarSurfaceLayout.agendaRowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(CalendarPressButtonStyle())
        .designPlate()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(event.accessibilityLabel)
        .accessibilityHint("Opens event preview")
        .accessibilityFocused(openerFocus, equals: .event(event.actionIdentity.stableKey))
        .accessibilityIdentifier(calendarEventIdentifier(event.actionIdentity.stableKey))
    }

    private var standardLayout: some View {
        HStack(spacing: Space.md) {
            eventTime
                .frame(minWidth: CalendarSurfaceLayout.agendaTimeWidth, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
            importanceMarker
            eventCopy
            Spacer(minLength: Space.xs)
            scopeBadge
        }
    }

    private var accessibilityLayout: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(alignment: .center, spacing: Space.sm) {
                eventTime
                Spacer(minLength: Space.sm)
                scopeBadge
            }
            HStack(alignment: .top, spacing: Space.sm) {
                importanceMarker
                eventCopy
            }
        }
    }

    private var eventTime: some View {
        Text(CalendarSurfaceText.eventTime(event))
            .font(Typo.mono(TypeScale.sm))
            .foregroundStyle(DuskColors.ink2)
            .multilineTextAlignment(.leading)
    }

    private var eventCopy: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(event.title)
                .font(Typo.ui(TypeScale.base, .semibold))
                .foregroundStyle(DuskColors.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(metadata)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var importanceMarker: some View {
        Capsule()
            .fill(importanceColor)
            .frame(width: 4, height: dynamicTypeSize.isAccessibilitySize ? 48 : 34)
            .accessibilityHidden(true)
    }

    private var scopeBadge: some View {
        Image(systemName: event.scope == .private ? "lock" : "house")
            .font(Typo.ui(TypeScale.base, .medium))
            .foregroundStyle(DuskColors.ink2)
            .frame(width: CalendarSurfaceLayout.scopeBadgeSize, height: CalendarSurfaceLayout.scopeBadgeSize)
            .designPlate()
            .accessibilityHidden(true)
    }

    private var importanceColor: Color {
        switch event.importance {
        case .normal: DuskColors.sage
        case .important: DuskColors.amber
        case .pinned: DuskColors.accent
        }
    }

    private var metadata: String {
        let values = ([event.group].compactMap { $0 } + event.tags)
        return values.isEmpty ? CalendarFilterMapping.scopeLabel(event.scope) : values.joined(separator: " · ")
    }
}

func calendarEventIdentifier(_ stableKey: String) -> String {
    "calendar-event-\(calendarTagToken(stableKey))"
}

/** One-way digest keeps dynamic IDs content-free and aligned with Android/fixture semantics. */
func calendarTagToken(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8))
        .prefix(12)
        .map { String(format: "%02x", $0) }
        .joined()
}

struct CalendarEmptyState: View {
    let message: String

    var body: some View {
        VStack(spacing: Space.sm) {
            Image(systemName: "calendar.badge.checkmark")
                .font(.title2)
                .foregroundStyle(DuskColors.sage)
                .accessibilityHidden(true)
            Text(message)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
                .multilineTextAlignment(.center)
        }
        .padding(Space.lg)
        .frame(maxWidth: .infinity, minHeight: CalendarSurfaceLayout.emptyStateHeight)
        .designPlate()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("calendar-empty")
    }
}
