import Foundation
import MobileData
import Testing
@testable import SentientApp

struct SchedulingSpecializedParityTests {
    @Test func nativeOnceSelectionSerializesExactInstantAcrossDSTTransitions() throws {
        let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        for wire in ["2026-03-08T01:30:00-08:00", "2026-03-08T03:30:00-07:00",
                     "2026-11-01T01:30:00-07:00", "2026-11-01T01:30:00-08:00"] {
            let date = try Date(wire, strategy: .iso8601)
            let draft = ScheduleDraft(message: "Synthetic", mode: .once, date: date, timeZone: zone.identifier)
            let timing = try #require(draft.timing)
            guard case .onceAt(let once) = onEnum(of: timing) else {
                Issue.record("Expected absolute instant")
                return
            }
            #expect(try Date(once.at, strategy: .iso8601) == date)
            #expect(once.at.hasSuffix("Z"))
            var edited = draft
            let fields = ScheduleEditorFields(absolute: once.at, delay: "30", recurringTime: "09:00",
                                              dayOfMonth: "1", timeZone: zone.identifier)
            #expect(fields.apply(to: &edited).isEmpty)
            #expect(edited.date == date)
        }
    }

    @Test func recurringClockSurvivesZoneChangeWithoutClientDSTExpansion() throws {
        var draft = ScheduleDraft(message: "Synthetic", mode: .recurring, frequency: .weekly)
        for zone in ["America/Los_Angeles", "Europe/Paris", "Asia/Kathmandu"] {
            let fields = ScheduleEditorFields(absolute: "", delay: "30", recurringTime: "02:30",
                                              dayOfMonth: "1", timeZone: zone)
            #expect(fields.apply(to: &draft).isEmpty)
            let timing = try #require(draft.timing)
            guard case .recurring(let recurrence) = onEnum(of: timing) else {
                Issue.record("Expected local recurrence")
                return
            }
            #expect(recurrence.localTime == "02:30")
            #expect(recurrence.timeZone == zone)
            #expect(recurrence.weekdays == [.monday])
            #expect(ScheduleDisplay.localTime(draft.localTime, zone: try #require(TimeZone(identifier: zone))) == "02:30")
        }
    }

    @Test(arguments: ["2026-08-03T09:00:00.000Z", "2026-08-03T09:00:00.123Z", "2026-08-03T02:00:00-07:00"])
    func summaryAcceptsGatewayWireInRecurrenceZone(wire: String) {
        let summary = ScheduleDisplay.summary(paritySchedule(next: wire), locale: Locale(identifier: "en_US"), timeZone: .gmt)
        #expect(summary.contains("Next: Aug 3, 2026 at 2:00") || summary.contains("Next: Aug 3, 2026, 2:00"))
        #expect(!summary.contains("unavailable"))
        #expect(!summary.contains(wire))
    }

    @Test func summaryFormatsNativeDateInScheduleZoneAndKeepsUnavailableValuesExplicit() {
        let schedule = paritySchedule(next: "2026-08-01T15:30:00-07:00")
        let english = ScheduleDisplay.summary(schedule, locale: Locale(identifier: "en_US"), timeZone: .gmt)
        #expect(english.contains("Weekly"))
        #expect(english.contains("America/Los_Angeles"))
        #expect(english.contains("Aug 1, 2026"))
        #expect(english.contains("3:30"))
        #expect(!english.contains("T15:30"))
        let french = ScheduleDisplay.summary(schedule, locale: Locale(identifier: "fr_FR"), timeZone: .gmt)
        #expect(french != english)
        #expect(french.contains("15:30"))
        #expect(ScheduleDisplay.summary(paritySchedule(next: nil)).contains("No next run"))
        #expect(ScheduleDisplay.summary(paritySchedule(next: "invalid")).contains("Next time unavailable: invalid"))
    }
}

private func paritySchedule(next: String?) -> Schedule {
    Schedule(scheduleId: "synthetic-schedule", revision: 1, message: "Synthetic",
             timing: ScheduleTiming.Recurring(frequency: .weekly, localTime: "09:00",
                                              timeZone: "America/Los_Angeles", weekdays: [.monday], dayOfMonth: nil),
             enabled: true, source: ScheduleSource.User.shared, nextRunAt: next,
             createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
}
