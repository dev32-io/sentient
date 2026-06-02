// ---------------------------------------------------------------------------
// AvatarTile — one avatar in the login grid: a 56pt tinted circle with the
// displayName's initial centered in ink, plus the name below. Stateless leaf:
// takes the user + an onTap closure; references no model (state-hoisting rule).
//
// accessibilityIdentifier `login-avatar-<userId>` mirrors the Android testTag
// so Maestro/XCUITest target it directly. Tint resolves from the SDK's
// Tints.map (persona slug → ARGB); an unknown/blank tint falls back to bgElev.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct AvatarTile: View {
    let user: AuthUserLite
    let onTap: () -> Void

    private static let avatarSize: CGFloat = 56
    private static let labelWidth: CGFloat = 72

    var body: some View {
        VStack(spacing: Space.sm) {
            Button(action: onTap) {
                ZStack {
                    Circle().fill(tintColor)
                    Text(initial)
                        .font(.system(size: TypeScale.lg, weight: .semibold))
                        .foregroundStyle(DuskColors.ink)
                }
                .frame(width: Self.avatarSize, height: Self.avatarSize)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("login-avatar-\(user.userId)")

            Text(user.displayName)
                .font(.system(size: TypeScale.base))
                .foregroundStyle(DuskColors.ink3)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(width: Self.labelWidth)
    }

    /// First letter of displayName, uppercased; '?' when blank.
    private var initial: String {
        let trimmed = user.displayName.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first else { return "?" }
        return String(first).uppercased()
    }

    /// Resolve the avatar tint slug → Color, falling back to the elevated surface.
    private var tintColor: Color {
        AvatarTints.color(for: user.avatarTint)
    }
}

/// Maps the SDK's `Tints.map` (persona slug → ARGB Long) to SwiftUI `Color`,
/// mirroring the Android `tintColor` resolver. Falls back to `bgElev` for an
/// unknown or blank slug. The map is read once from the SDK token object.
enum AvatarTints {
    private static let map: [String: Int64] = {
        var result: [String: Int64] = [:]
        for (key, value) in MobileSdk.Tints.shared.map {
            if let slug = key as? String, let argb = value as? Int64 {
                result[slug] = argb
            }
        }
        return result
    }()

    static func color(for slug: String) -> Color {
        guard let argb = map[slug] else { return DuskColors.bgElev }
        return color(fromArgb: argb)
    }

    private static func color(fromArgb argb: Int64) -> Color {
        let alpha = Double((argb >> 24) & 0xFF) / 255.0
        let red = Double((argb >> 16) & 0xFF) / 255.0
        let green = Double((argb >> 8) & 0xFF) / 255.0
        let blue = Double(argb & 0xFF) / 255.0
        return Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }
}
