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
        LazyVStack(spacing: Space.sm) {
            if sections.isEmpty {
                CalendarEmptyState(message: emptyMessage)
            } else {
                ForEach(sections) { section in
                    VStack(spacing: Space.sm) {
                        let heading = CalendarSurfaceText.agendaHeading(section.date, locale: locale)
                        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                            Text(heading.date)
                                .font(CalendarFont.display(TypeScale.xl, .medium))
                                .foregroundStyle(DuskColors.ink)
                            Text(heading.weekday.uppercased())
                                .font(CalendarFont.mono(TypeScale.xs))
                                .foregroundStyle(DuskColors.ink3)
                            Spacer()
                        }
                        .padding(.horizontal, 2)
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

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.md) {
                Text(CalendarSurfaceText.eventTime(event))
                    .font(CalendarFont.mono(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
                    .frame(width: 54, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    Text(event.title)
                        .font(CalendarFont.ui(TypeScale.base, .medium))
                        .foregroundStyle(DuskColors.ink)
                        .lineLimit(2)
                    Text(metadata)
                        .font(CalendarFont.ui(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink3)
                        .lineLimit(1)
                }
                Spacer(minLength: Space.xs)
                Text(scopeInitial)
                    .font(CalendarFont.display(TypeScale.sm, .medium))
                    .foregroundStyle(DuskColors.ink2)
                    .frame(width: 28, height: 28)
                    .overlay(Circle().stroke(DuskColors.lineSoft))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, Space.md)
            .frame(maxWidth: .infinity, minHeight: CalendarSurfaceLayout.agendaRowHeight, alignment: .leading)
            .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: Radii.md))
            .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft))
            .contentShape(Rectangle())
        }
        .buttonStyle(CalendarPressButtonStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(event.accessibilityLabel)
        .accessibilityHint("Opens event preview")
        .accessibilityFocused(openerFocus, equals: .event(event.actionIdentity.stableKey))
        .accessibilityIdentifier(calendarEventIdentifier(event.actionIdentity.stableKey))
    }

    private var metadata: String {
        let values = ([event.group].compactMap { $0 } + event.tags)
        return values.isEmpty ? CalendarFilterMapping.scopeLabel(event.scope) : values.joined(separator: " · ")
    }

    private var scopeInitial: String {
        String(CalendarFilterMapping.scopeLabel(event.scope).prefix(1))
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
                .font(CalendarFont.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 96)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("calendar-empty")
    }
}
