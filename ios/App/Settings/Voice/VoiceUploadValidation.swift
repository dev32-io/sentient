import Foundation

enum VoiceUploadValidation {
    static let supportedExtensions: Set<String> = ["wav", "flac", "ogg", "mp3"]
    static let unsupportedMessage = "Choose a WAV, FLAC, OGG, or MP3 file."
    static let emptyMessage = "That audio file is empty."

    static func accepts(fileName: String) -> Bool {
        supportedExtensions.contains(URL(fileURLWithPath: fileName).pathExtension.lowercased())
    }
}
