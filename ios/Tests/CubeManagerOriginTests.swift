import Foundation
import Security
import XCTest
@testable import SentientApp

final class CubeManagerOriginTests: XCTestCase {
    private let id = "11111111-1111-4111-8111-111111111111"
    private let otherId = "22222222-2222-4222-8222-222222222222"
    private let origins = ["https://Cube.invalid", "https://Cube.invalid:443"]
    private let secret = CubeSecret.encode(Data(repeating: 1, count: 32))
    private let replacement = CubeSecret.encode(Data(repeating: 2, count: 32))

    private func attempt(_ generation: Int? = nil) -> CubeSetupAttempt {
        CubeSetupAttempt(deviceId: id, attemptId: otherId, enrollmentSecret: secret,
                         bootstrap: nil, generation: generation)
    }

    private func store(_ memory: SyntheticKeychain, _ origin: String? = nil,
                       account: String = "owner") throws -> CubeManagerStore {
        try CubeManagerStore(gatewayOrigin: URL(string: origin ?? origins[0])!, accountId: account,
                             keychain: memory.operations)
    }

    func testEitherLegacySpellingSurvivesRecreationAndUpdatesInPlace() throws {
        for origin in origins {
            let memory = SyntheticKeychain()
            try memory.seed(origin, device: id, data: Data(secret.utf8))
            try memory.seed(origin, device: id, data: JSONEncoder().encode(attempt()), attempt: true)
            for reopenedOrigin in origins {
                let reopened = try store(memory, reopenedOrigin)
                XCTAssertEqual(try reopened.load(deviceId: id), secret)
                XCTAssertEqual(try reopened.attempts(), [attempt()])
                XCTAssertEqual(try reopened.deviceIds(), [id])
            }
            try store(memory).save(replacement, deviceId: id)
            try store(memory).saveAttempt(attempt(7))
            XCTAssertEqual(try store(memory, origins[1]).load(deviceId: id), replacement)
            XCTAssertEqual(try store(memory, origins[1]).attempts(), [attempt(7)])
            XCTAssertEqual(memory.items.count, 2, "No eager migration or extra alias")
            XCTAssertTrue(memory.items.allSatisfy { $0[kSecAttrLabel] as? String == memory.scope(origin) })
        }
    }

    func testLegacyUppercaseAttemptPreservesPayloadAcrossPortAliases() throws {
        let device = "ABCDEFAB-1234-4ABC-8DEF-ABCDEFABCDEF"
        let legacy = CubeSetupAttempt(deviceId: device, attemptId: otherId,
                                      enrollmentSecret: secret, bootstrap: nil, generation: nil)
        let encoded = try JSONEncoder().encode(legacy)
        for origin in origins {
            let memory = SyntheticKeychain()
            try memory.seed(origin, device: device.lowercased(), data: encoded, attempt: true)
            for reopenedOrigin in origins {
                XCTAssertEqual(try store(memory, reopenedOrigin).attempts(), [legacy])
            }
            XCTAssertEqual(memory.mutations, 0)
            XCTAssertEqual(memory.items[0][kSecValueData] as? Data, encoded)
            var updated = legacy
            updated.generation = 7
            try store(memory, origins[1]).saveAttempt(updated)
            XCTAssertEqual(try store(memory, origins[0]).attempts(), [updated])
            XCTAssertEqual(memory.items.count, 1)
            try store(memory).removeAttempt(deviceId: device)
            XCTAssertTrue(memory.items.isEmpty)
        }

        let duplicates = SyntheticKeychain()
        for origin in origins {
            try duplicates.seed(origin, device: device.lowercased(), data: encoded, attempt: true)
        }
        XCTAssertEqual(try store(duplicates).attempts(), [legacy])
        let lowercase = CubeSetupAttempt(deviceId: device.lowercased(), attemptId: otherId,
                                         enrollmentSecret: secret, bootstrap: nil, generation: nil)
        duplicates.items[1][kSecValueData] = try JSONEncoder().encode(lowercase)
        for origin in origins {
            let subject = try store(duplicates, origin)
            XCTAssertThrowsError(try subject.attempts(), "Same UUID identity, unequal exact payloads")
            XCTAssertThrowsError(try subject.saveAttempt(legacy))
        }
        XCTAssertEqual(duplicates.mutations, 0)
    }

    func testNewWritesUseOmittedPortAndIdenticalDuplicatesUpdateTogether() throws {
        let memory = SyntheticKeychain()
        let explicit = try store(memory, origins[1])
        try explicit.save(secret, deviceId: id)
        try explicit.saveAttempt(attempt())
        XCTAssertTrue(memory.items.allSatisfy { $0[kSecAttrLabel] as? String == memory.scope(origins[0]) })
        try memory.seed(origins[1], device: id, data: Data(secret.utf8))
        let reordered = JSONEncoder()
        reordered.outputFormatting = [.prettyPrinted, .sortedKeys]
        try memory.seed(origins[1], device: id, data: reordered.encode(attempt()), attempt: true)
        XCTAssertEqual(try explicit.load(deviceId: id), secret)
        XCTAssertEqual(try explicit.attempts(), [attempt()])
        XCTAssertEqual(try explicit.deviceIds(), [id])
        try explicit.save(replacement, deviceId: id)
        try explicit.saveAttempt(attempt(9))
        XCTAssertEqual(try explicit.load(deviceId: id), replacement)
        XCTAssertEqual(try explicit.attempts(), [attempt(9)])
        XCTAssertEqual(memory.items.count, 4)
    }

    func testConflictingDuplicatesRejectReadsAndWritesBeforeMutation() throws {
        let memory = SyntheticKeychain()
        try memory.seed(origins[0], device: id, data: Data(secret.utf8))
        try memory.seed(origins[1], device: id, data: Data(replacement.utf8))
        try memory.seed(origins[0], device: id, data: JSONEncoder().encode(attempt()), attempt: true)
        try memory.seed(origins[1], device: id, data: JSONEncoder().encode(attempt(2)), attempt: true)
        let subject = try store(memory)
        XCTAssertThrowsError(try subject.load(deviceId: id))
        XCTAssertThrowsError(try subject.save(secret, deviceId: id))
        XCTAssertThrowsError(try subject.attempts())
        XCTAssertThrowsError(try subject.saveAttempt(attempt(3)))
        XCTAssertEqual(memory.mutations, 0)
    }

    func testMalformedValuesAndAttemptAccountPayloadMismatchFailClosed() throws {
        for badAttempt in [Data("bad".utf8), try JSONEncoder().encode(attempt())] {
            let memory = SyntheticKeychain()
            // Valid payload deliberately filed under another device.
            try memory.seed(origins[1], device: otherId, data: badAttempt, attempt: true)
            XCTAssertThrowsError(try store(memory).attempts())
        }
        let memory = SyntheticKeychain()
        try memory.seed(origins[0], device: id, data: Data(secret.utf8))
        try memory.seed(origins[1], device: id, data: Data("bad".utf8))
        XCTAssertThrowsError(try store(memory).load(deviceId: id))
        XCTAssertThrowsError(try store(memory).save(secret, deviceId: id))
        XCTAssertEqual(memory.mutations, 0)
        // Label cannot confer authority on an item whose encoded account names another scope.
        let wrongScope = SyntheticKeychain()
        try wrongScope.seed("https://foreign.invalid", device: id,
                            data: JSONEncoder().encode(attempt()), attempt: true)
        wrongScope.items[0][kSecAttrLabel] = wrongScope.scope(origins[0])
        XCTAssertThrowsError(try store(wrongScope).attempts())
    }

    func testAttemptUnionAndMalformedAliasWritePreflight() throws {
        let memory = SyntheticKeychain()
        let other = CubeSetupAttempt(deviceId: otherId, attemptId: id, enrollmentSecret: secret,
                                     bootstrap: nil, generation: 2)
        try memory.seed(origins[0], device: id, data: JSONEncoder().encode(attempt()), attempt: true)
        try memory.seed(origins[1], device: otherId, data: JSONEncoder().encode(other), attempt: true)
        XCTAssertEqual(try store(memory).attempts(), [attempt(), other])
        try memory.seed(origins[1], device: id, data: Data("bad".utf8), attempt: true)
        XCTAssertThrowsError(try store(memory).saveAttempt(attempt(4)))
        XCTAssertThrowsError(try store(memory).attempts())
        XCTAssertEqual(memory.mutations, 0)
    }

    func testExactNondefaultHostAccountAndSlashIsolation() throws {
        let memory = SyntheticKeychain()
        let foreign: [(String, String)] = [
            ("https://Cube.invalid:8443", "owner"), ("https://cube.invalid", "owner"),
            ("https://192.0.2.136", "owner"), ("https://Cube.invalid/", "owner"),
            (origins[0], "Owner"), (origins[0], "owner ")
        ]
        for (origin, account) in foreign {
            try memory.seed(origin, account: account, device: id, data: Data(secret.utf8))
        }
        let subject = try store(memory)
        XCTAssertNil(try subject.load(deviceId: id))
        XCTAssertEqual(try subject.deviceIds(), [])
        try subject.removeAccount()
        XCTAssertEqual(memory.items.count, foreign.count)
        for (origin, account) in foreign {
            XCTAssertEqual(try store(memory, origin, account: account).load(deviceId: id), secret)
        }
        memory.copies.removeAll()
        _ = try store(memory, "https://Cube.invalid:8443").load(deviceId: id)
        XCTAssertEqual(memory.copies.count, 1)
    }

    func testMetadataUnionNeverRequestsSecretData() throws {
        let memory = SyntheticKeychain()
        for origin in origins {
            try memory.seed(origin, device: id, data: Data("malformed-secret".utf8))
            try memory.seed(origin, device: id, data: Data("malformed-attempt".utf8), attempt: true)
        }
        try memory.seed(origins[1], device: otherId, data: Data())
        XCTAssertEqual(try store(memory).deviceIds(), [id, otherId])
        XCTAssertEqual(memory.copies.count, 2)
        XCTAssertTrue(memory.copies.allSatisfy { $0[kSecReturnData] == nil })
    }

    func testReadErrorsInEitherAliasFailClosedIncludingWritePreflight() throws {
        for failedOrigin in origins {
            let memory = SyntheticKeychain()
            try memory.seed(origins[0], device: id, data: Data(secret.utf8))
            memory.failCopyScope = memory.scope(failedOrigin)
            let subject = try store(memory)
            XCTAssertThrowsError(try subject.load(deviceId: id))
            XCTAssertThrowsError(try subject.deviceIds())
            XCTAssertThrowsError(try subject.attempts())
            XCTAssertThrowsError(try subject.save(replacement, deviceId: id))
            XCTAssertThrowsError(try subject.saveAttempt(attempt()))
            XCTAssertEqual(memory.mutations, 0)
        }
    }

    func testFailedAndPartialWritesRetainAuthorityAndExposeConflict() throws {
        for isAttempt in [false, true] {
            let memory = SyntheticKeychain()
            let old = isAttempt ? try JSONEncoder().encode(attempt()) : Data(secret.utf8)
            for origin in origins { try memory.seed(origin, device: id, data: old, attempt: isAttempt) }
            let subject = try store(memory)
            memory.failUpdateScope = memory.scope(origins[0])
            if isAttempt { XCTAssertThrowsError(try subject.saveAttempt(attempt(4))) }
            else { XCTAssertThrowsError(try subject.save(replacement, deviceId: id)) }
            XCTAssertTrue(memory.items.allSatisfy { $0[kSecValueData] as? Data == old })
            memory.failUpdateScope = memory.scope(origins[1])
            if isAttempt {
                XCTAssertThrowsError(try subject.saveAttempt(attempt(4)))
                XCTAssertThrowsError(try subject.attempts())
            } else {
                XCTAssertThrowsError(try subject.save(replacement, deviceId: id))
                XCTAssertThrowsError(try subject.load(deviceId: id))
            }
            XCTAssertEqual(memory.items.count, 2, "Failed updates never delete authority")
            XCTAssertEqual(memory.items[1][kSecValueData] as? Data, old)
        }
        let empty = SyntheticKeychain()
        empty.failAdd = true
        XCTAssertThrowsError(try store(empty).save(secret, deviceId: id))
        XCTAssertThrowsError(try store(empty).saveAttempt(attempt()))
        XCTAssertTrue(empty.items.isEmpty)
    }

    func testDeletesTryBothAliasesDespiteFailureAndPreserveForeignScopes() throws {
        for failedOrigin in origins {
            for attemptsOnly in [false, true] {
                let memory = SyntheticKeychain()
                for origin in origins {
                    try memory.seed(origin, device: id, data: Data("bad".utf8))
                    try memory.seed(origin, device: id, data: Data("bad".utf8), attempt: true)
                }
                try memory.seed(origins[0], account: "foreign", device: id, data: Data(secret.utf8))
                let subject = try store(memory, origins[1])
                memory.failDeleteScope = memory.scope(failedOrigin)
                if attemptsOnly { XCTAssertThrowsError(try subject.removeAttempt(deviceId: id)) }
                else { XCTAssertThrowsError(try subject.removeAccount()) }
                XCTAssertEqual(memory.deletes.count, 2)
                XCTAssertTrue(memory.copies.isEmpty, "Logout must not decode or read values")
                let surviving = memory.items.filter { $0[kSecAttrLabel] as? String != memory.scope(origins[0], "foreign") }
                XCTAssertEqual(surviving.count, attemptsOnly ? 3 : 2)
                memory.failDeleteScope = nil
                if attemptsOnly {
                    try subject.removeAttempt(deviceId: id)
                    XCTAssertEqual(try subject.deviceIds(), [id], "Manager remains")
                }
                try subject.removeAccount()
                try subject.removeAccount() // Missing entries tolerated.
                XCTAssertEqual(memory.items.count, 1)
                XCTAssertEqual(try store(memory, account: "foreign").load(deviceId: id), secret)
            }
        }
    }
}

/// Implements only Security operations used by production store, matching actual query attributes.
private final class SyntheticKeychain {
    var items: [[CFString: Any]] = []
    var copies: [[CFString: Any]] = []
    var deletes: [[CFString: Any]] = []
    var mutations = 0
    var failCopyScope: String?
    var failUpdateScope: String?
    var failDeleteScope: String?
    var failAdd = false

    func scope(_ origin: String, _ account: String = "owner") -> String {
        String(decoding: try! JSONEncoder().encode([origin, account]), as: UTF8.self)
    }

    func seed(_ origin: String, account: String = "owner", device: String, data: Data,
              attempt: Bool = false) throws {
        let label = scope(origin, account)
        let key = String(decoding: try JSONEncoder().encode([label, device]), as: UTF8.self)
        items.append([kSecClass: kSecClassGenericPassword,
                      kSecAttrService: "io.dev32.sentient.cube.manager.v1", kSecAttrLabel: label,
                      kSecAttrAccount: key + (attempt ? ":attempt" : ""), kSecAttrSynchronizable: false,
                      kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecValueData: data])
    }

    private func matches(_ item: [CFString: Any], _ query: [CFString: Any]) -> Bool {
        [kSecClass, kSecAttrService, kSecAttrLabel, kSecAttrAccount, kSecAttrSynchronizable].allSatisfy { key in
            guard let expected = query[key] as? NSObject else { return true }
            return (item[key] as? NSObject) == expected
        }
    }

    var operations: CubeManagerStore.Keychain {
        CubeManagerStore.Keychain(copy: { query in
            self.copies.append(query)
            if query[kSecAttrLabel] as? String == self.failCopyScope { return (errSecInteractionNotAllowed, nil) }
            let found = self.items.filter { self.matches($0, query) }
            guard !found.isEmpty else { return (errSecItemNotFound, nil) }
            if query[kSecReturnAttributes] as? Bool == true {
                let projected = found.map { item -> [CFString: Any] in
                    var result = item
                    if query[kSecReturnData] as? Bool != true { result.removeValue(forKey: kSecValueData) }
                    return result
                }
                return (errSecSuccess, projected as CFArray)
            }
            return (errSecSuccess, (found[0][kSecValueData] as! Data) as CFData)
        }, update: { query, data in
            self.mutations += 1
            if query[kSecAttrLabel] as? String == self.failUpdateScope { return errSecInteractionNotAllowed }
            let indices = self.items.indices.filter { self.matches(self.items[$0], query) }
            guard !indices.isEmpty else { return errSecItemNotFound }
            for index in indices { self.items[index][kSecValueData] = data }
            return errSecSuccess
        }, add: { item in
            self.mutations += 1
            if self.failAdd { return errSecInteractionNotAllowed }
            if self.items.contains(where: { self.matches($0, item) }) { return errSecDuplicateItem }
            self.items.append(item)
            return errSecSuccess
        }, delete: { query in
            self.deletes.append(query)
            if query[kSecAttrLabel] as? String == self.failDeleteScope { return errSecInteractionNotAllowed }
            let count = self.items.count
            self.items.removeAll { self.matches($0, query) }
            return self.items.count == count ? errSecItemNotFound : errSecSuccess
        })
    }
}
