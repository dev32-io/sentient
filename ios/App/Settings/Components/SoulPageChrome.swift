// ---------------------------------------------------------------------------
// SoulPageChrome — shared chrome for the Soul-group editing pages (Memory,
// Personalities, Model, Tools, System Prompt, Advanced, Audio): the initial-load
// spinner, inline error / notice / applying banners, and the leading back +
// trailing Save toolbar buttons.
//
// Cross-cutting chrome, shared across the Soul-page group — lives in
// `Settings/Components/` alongside the other shared settings leaves. The `Soul`
// prefix keeps it collision-free with the User/Admin/Support page files.
//
// All members are stateless leaves: value inputs + closures, no VM, no I/O.
// ---------------------------------------------------------------------------
import SwiftUI

/// Copy for the 429 apply-in-progress product state (another apply is running).
let soulAlreadyApplyingText = "Another change is applying — try again in a moment."

/// Centered progress spinner for a page's initial load.
struct SoulLoadingRow: View {
    var body: some View {
        HStack {
            Spacer()
            ProgressView().tint(DuskColors.accent)
            Spacer()
        }
        .padding(.vertical, Space.xl)
        .accessibilityIdentifier("settings-loading")
    }
}

/// Red inline error line — a load failure, or a save failure (draft is kept).
struct SoulInlineError: View {
    let message: String

    var body: some View {
        Text(message)
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.stop)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.md)
            .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
            .accessibilityIdentifier("settings-error")
    }
}

/// Amber inline notice (e.g. apply-in-progress elsewhere; non-fatal).
struct SoulNoticeBanner: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.amber)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.md)
            .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
            .accessibilityIdentifier("settings-notice")
    }
}

/// Blocking progress banner shown while a slow save applies (assistant restart).
struct SoulApplyingBanner: View {
    let text: String

    var body: some View {
        HStack(spacing: Space.sm) {
            ProgressView().tint(DuskColors.accent)
            Text(text)
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
            Spacer()
        }
        .padding(Space.md)
        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
        .accessibilityIdentifier("settings-applying")
    }
}

/// Leading chevron back button; `action` decides discard-confirm vs pop.
struct SoulBackButton: View {
    let accessibilityId: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.left")
                .font(.system(size: TypeScale.base, weight: .semibold))
                .foregroundStyle(DuskColors.ink2)
        }
        .accessibilityIdentifier(accessibilityId)
    }
}

/// Trailing Save button, dimmed + disabled while a save is applying.
struct SoulSaveButton: View {
    let disabled: Bool
    let accessibilityId: String
    let action: () -> Void

    var body: some View {
        Button("Save", action: action)
            .font(.system(size: TypeScale.base, weight: .semibold))
            .foregroundStyle(disabled ? DuskColors.ink4 : DuskColors.accent)
            .disabled(disabled)
            .accessibilityIdentifier(accessibilityId)
    }
}

#Preview {
    VStack(spacing: Space.lg) {
        SoulLoadingRow()
        SoulApplyingBanner(text: "Applying — assistant restarting…")
        SoulNoticeBanner(text: soulAlreadyApplyingText)
        SoulInlineError(message: "Couldn't save your changes.")
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
