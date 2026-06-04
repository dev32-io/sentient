// ---------------------------------------------------------------------------
// MarkdownDuskTheme — the MarkdownUI `Theme` that maps GFM elements onto the
// Dusk palette, so assistant/user bubbles render markdown in the same ink /
// accent / paper language as the rest of the app. Mirrors the webui `marked`
// path (gateway/webui/src/lib/render-markdown.ts) themed by components.css.
//
// Body text = ink at base size; links = accent; inline code + fenced code blocks
// sit on the elevated surface (bgElev) in a monospaced face. Headings inherit
// MarkdownUI's default scale relative to the base text size.
// ---------------------------------------------------------------------------
import MarkdownUI
import SwiftUI

extension MarkdownUI.Theme {
    static let dusk = MarkdownUI.Theme()
        .text {
            ForegroundColor(DuskColors.ink)
            FontSize(TypeScale.base)
        }
        .link {
            ForegroundColor(DuskColors.accent)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(MarkdownDuskLayout.codeScale))
            ForegroundColor(DuskColors.ink)
            BackgroundColor(DuskColors.bgElev)
        }
        .codeBlock { configuration in
            configuration.label
                .markdownTextStyle {
                    FontFamilyVariant(.monospaced)
                    FontSize(.em(MarkdownDuskLayout.codeScale))
                    ForegroundColor(DuskColors.ink)
                }
                .padding(Space.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(DuskColors.bgElev)
                .clipShape(RoundedRectangle(cornerRadius: Radii.sm))
                .markdownMargin(top: Space.sm, bottom: Space.sm)
        }
        .blockquote { configuration in
            configuration.label
                .padding(.leading, Space.md)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(DuskColors.line)
                        .frame(width: MarkdownDuskLayout.quoteRule)
                }
                .foregroundStyle(DuskColors.ink2)
        }
}

private enum MarkdownDuskLayout {
    /// Inline + fenced code sized relative to body text (matches webui code scale).
    static let codeScale: CGFloat = 0.92
    static let quoteRule: CGFloat = 2
}
