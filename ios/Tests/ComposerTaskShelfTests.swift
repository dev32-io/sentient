import Testing
@testable import SentientApp

struct ComposerTaskShelfTests {
    @Test func disclosureOpensOnlyTheTappedTask() {
        #expect(taskShelfSelection(current: nil, tapped: "one") == "one")
        #expect(taskShelfSelection(current: "one", tapped: "two") == "two")
    }

    @Test func tappingOpenTaskCollapsesIt() {
        #expect(taskShelfSelection(current: "one", tapped: "one") == nil)
    }
}
