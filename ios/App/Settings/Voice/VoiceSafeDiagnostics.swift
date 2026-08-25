enum VoiceSafeDiagnostics {
    static func mutation(audioBytes: Int? = nil, name: String, tags: [String], language: String) -> String {
        var fields: [String] = []
        if let audioBytes { fields.append("bytes=\(audioBytes)") }
        fields.append("nameLen=\(name.count)")
        fields.append("tags=\(tags.count)")
        fields.append("hasLanguage=\(!language.isEmpty)")
        return fields.joined(separator: " ")
    }
}
