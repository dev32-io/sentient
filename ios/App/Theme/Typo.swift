import SwiftUI

/// Dynamic-Type-aware compatibility font helpers.
enum Typo {
    static func display(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
        .custom("Fraunces", size: size, relativeTo: semanticStyle(for: size)).weight(weight)
    }

    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("DM Sans", size: size, relativeTo: semanticStyle(for: size)).weight(weight)
    }

    static func mono(_ size: CGFloat) -> Font {
        .custom("JetBrains Mono", size: size, relativeTo: semanticStyle(for: size))
    }

    private static func semanticStyle(for size: CGFloat) -> Font.TextStyle {
        if size >= TypeScale.display { return .largeTitle }
        if size >= TypeScale.xl { return .title2 }
        if size >= TypeScale.lg { return .headline }
        if size >= TypeScale.base { return .body }
        if size >= TypeScale.sm { return .footnote }
        return .caption2
    }
}
