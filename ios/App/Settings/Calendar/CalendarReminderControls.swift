import SwiftUI

/// Personal reminder controls embedded by the legacy calendar editor. The
/// reminder is actor-scoped even when the event belongs to the household.
struct CalendarReminderControls: View {
    let allDay: Bool
    @Binding var enabled: Bool
    @Binding var usesLead: Bool
    @Binding var leadMinutes: String
    @Binding var reminderTime: Date
    @Binding var timeZoneId: String
    let timeZone: TimeZone
    let onChange: () -> Void

    var body: some View {
        DesignCard(
            title: "Personal reminder",
            detail: "Only you receive this reminder, including for household events.",
            bodyStyle: .settingsGroup
        ) {
            DesignToggleRow(
                title: "Remind me",
                detail: "Off by default.",
                isOn: $enabled,
                accessibilityId: "calendar-editor-reminder"
            )
            .onChange(of: enabled) { _, _ in onChange() }

            if enabled && allDay {
                DesignSettingsRow(title: "Reminder time", detail: "Required for all-day events") {
                    DesignDatePicker(
                        title: "Reminder time",
                        selection: $reminderTime,
                        displayedComponents: [.hourAndMinute],
                        timeZone: timeZone,
                        labelsHidden: true,
                        accessibilityId: "calendar-editor-reminder-time"
                    )
                    .onChange(of: reminderTime) { _, _ in onChange() }
                }
                DesignField(
                    title: "Reminder time zone",
                    text: $timeZoneId,
                    error: TimeZone(identifier: timeZoneId) == nil ? "Choose a valid time zone." : nil,
                    accessibilityId: "calendar-editor-reminder-time-zone",
                    autocapitalization: .never,
                    autocorrectionDisabled: true,
                    onChange: { _ in onChange() }
                )
            } else if enabled {
                DesignToggleRow(
                    title: "Before the event",
                    detail: usesLead ? "Choose how many minutes before." : "At the event start.",
                    isOn: $usesLead,
                    accessibilityId: "calendar-editor-reminder-lead"
                )
                .onChange(of: usesLead) { _, _ in onChange() }
                if usesLead {
                    DesignField(
                        title: "Minutes before",
                        text: $leadMinutes,
                        error: leadError,
                        accessibilityId: "calendar-editor-reminder-lead-minutes",
                        autocapitalization: .never,
                        autocorrectionDisabled: true,
                        onChange: { _ in onChange() }
                    )
                }
            }
        }
    }

    private var leadError: String? {
        guard let value = Int(leadMinutes), (1...43_200).contains(value) else {
            return "Choose from one minute to 30 days."
        }
        return nil
    }
}
