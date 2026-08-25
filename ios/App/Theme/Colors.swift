import SwiftUI
import MobileData

/// Compatibility namespace for existing iOS call sites. Every locked role now
/// projects the additive KMP v2 palette; aliases retain the old Swift API only.
enum DuskColors {
    static let bg = DesignV2.ColorToken.bg.color
    static let bgElev = DesignV2.ColorToken.elevated.color
    static let bgSunk = DesignV2.ColorToken.sunk.color
    static let paper = DesignV2.ColorToken.paper.color
    static let line = DesignV2.ColorToken.line.color
    static let lineSoft = DesignV2.ColorToken.lineSoft.color
    static let ink = DesignV2.ColorToken.ink.color
    static let ink2 = DesignV2.ColorToken.inkSecondary.color
    static let ink3 = DesignV2.ColorToken.inkTertiary.color
    static let ink4 = DesignV2.ColorToken.inkMuted.color
    static let accent = DesignV2.ColorToken.ember.color
    static let accentSoft = DesignV2.ColorToken.emberSoft.color
    static let accent50 = DesignV2.ColorToken.emberDeep.color
    static let amber = DesignV2.ColorToken.amber.color
    static let sage = DesignV2.ColorToken.sage.color
    static let sageSoft = DesignV2.ColorToken.sageSoft.color
    static let clay = DesignV2.ColorToken.clay.color
    static let ok = DesignV2.ColorToken.ok.color
    static let warn = DesignV2.ColorToken.warn.color
    static let stop = DesignV2.ColorToken.stop.color

    static let userBubble = lerpColor(MobileData.Colors_.shared.paper, MobileData.Colors_.shared.sage, 0.16)
    static let micLiveBorder = lerpColor(MobileData.Colors_.shared.line, MobileData.Colors_.shared.ember, 0.45)
    static let micLockedHi = lerpColor(MobileData.Colors_.shared.sunk, MobileData.Colors_.shared.ember, 0.45)
    static let micLockedLo = lerpColor(MobileData.Colors_.shared.sunk, MobileData.Colors_.shared.ember, 0.20)
    static let waveBar = lerpColor(MobileData.Colors_.shared.ink, MobileData.Colors_.shared.ember, 0.70)
}

private func lerpColor(_ from: Int64, _ to: Int64, _ fraction: Double) -> Color {
    let mask: Int64 = 0xFF
    let maximum = 255.0
    func channel(_ value: Int64, _ shift: Int64) -> Double {
        Double((value >> shift) & mask) / maximum
    }
    func mix(_ shift: Int64) -> Double {
        channel(from, shift) + (channel(to, shift) - channel(from, shift)) * fraction
    }
    return Color(.sRGB, red: mix(16), green: mix(8), blue: mix(0), opacity: mix(24))
}
