import Foundation
import Testing
@testable import SentientApp

// Pins the DisplayNameStore round-trip: save → load returns the name, clear
// drops it, and blank values are treated as absent so callers fall back cleanly.
struct DisplayNameStoreTests {
    private func makeStore() -> (DisplayNameStore, UserDefaults) {
        let suite = "DisplayNameStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        return (DisplayNameStore(defaults: defaults), defaults)
    }

    @Test func loadIsNilWhenUnset() {
        let (store, _) = makeStore()
        #expect(store.load() == nil)
    }

    @Test func savesAndLoadsBack() {
        let (store, _) = makeStore()
        store.save("Kevin")
        #expect(store.load() == "Kevin")
    }

    @Test func clearRemovesIt() {
        let (store, _) = makeStore()
        store.save("Kevin")
        store.clear()
        #expect(store.load() == nil)
    }

    @Test func blankIsTreatedAsAbsent() {
        let (store, _) = makeStore()
        store.save("   ")
        #expect(store.load() == nil)
    }
}
