import Foundation
import MobileData

enum VoiceLibraryFiltering {
    static func apply(
        _ voices: [VoiceSummary], query: String, source: String,
        selectedTags: [String], language: String
    ) -> [VoiceSummary] {
        voices.filter { voice in
            if source != "all" && voice.source != source { return false }
            if !language.isEmpty && voice.language != language { return false }
            if !selectedTags.isEmpty && !selectedTags.allSatisfy({ voice.tags.contains($0) }) { return false }
            let term = query.trimmingCharacters(in: .whitespaces).lowercased()
            return term.isEmpty || ([voice.name, voice.description_] + voice.tags)
                .joined(separator: " ").lowercased().contains(term)
        }
    }
}

enum VoiceFishFiltering {
    static func apply(
        _ entries: [FishVoiceEntry], query: String = "", language: String,
        genders: [String], ages: [String], vibes: [String], sort: VoiceFishViewModel.Sort
    ) -> [FishVoiceEntry] {
        let language = language.lowercased()
        let term = query.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = entries.filter { entry in
            let tags = Set(entry.tags.map { $0.trimmingCharacters(in: .whitespaces).lowercased() })
            return (term.isEmpty || ([entry.title, entry.description_] + entry.tags).joined(separator: " ").lowercased().contains(term)) &&
                (language.isEmpty || entry.languages.contains { $0.lowercased() == language }) &&
                (genders.isEmpty || genders.contains { tags.contains($0.lowercased()) }) &&
                (ages.isEmpty || ages.contains { tags.contains($0.lowercased()) }) &&
                (vibes.isEmpty || vibes.contains { tags.contains($0.lowercased()) })
        }
        switch sort {
        case .popular: return filtered
        case .recent: return filtered.sorted { $0.createdAt > $1.createdAt }
        case .az: return filtered.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        }
    }

    static func appendingUnique(_ page: [FishVoiceEntry], to entries: [FishVoiceEntry]) -> [FishVoiceEntry] {
        let existing = Set(entries.map(\.id))
        return entries + page.filter { !existing.contains($0.id) }
    }
}
