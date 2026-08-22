# Sentient Dusk design system

Sentient uses the dark-only Dusk system: smoked household surfaces, warm ink, a restrained terra action color, and semantic sage, amber, clay, and status roles.

## Canonical source

The implementation contract is synchronized from:

- Web tokens: `gateway/webui/src/styles/tokens/`
- Cross-platform tokens: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt`
- Native projections: `ios/App/Theme/` and `android/src/main/kotlin/io/sentient/android/theme/`

The exact source colors are hex values. The six Open Design aliases below are exact OKLch conversions of their canonical Dusk counterparts, not independently chosen colors.

```css
:root {
  --bg: oklch(0.272364 0.011712 67.302);       /* #2B2621 · color-bg */
  --surface: oklch(0.322552 0.014464 62.899);  /* #39322C · color-paper */
  --fg: oklch(0.934070 0.026255 82.384);       /* #F2E8D6 · color-ink */
  --muted: oklch(0.660636 0.030802 74.137);    /* #9E907E · color-ink-3 */
  --border: oklch(0.339009 0.016490 63.430);   /* #3E362F · color-line-soft */
  --accent: oklch(0.775997 0.120213 53.416);   /* #F2A06A · color-accent */
  --font-display: "Fraunces", "Cormorant Garamond", Georgia, serif;
  --font-body: "DM Sans", "Inter", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

## Complete Dusk palette

| Role | Token | Value |
|---|---|---|
| Base canvas | `--color-bg` | `#2B2621` |
| Elevated canvas | `--color-bg-elev` | `#332D28` |
| Sunken canvas | `--color-bg-sunk` | `#241F1B` |
| Paper / component surface | `--color-paper` | `#39322C` |
| Strong line | `--color-line` | `#4A4138` |
| Quiet line | `--color-line-soft` | `#3E362F` |
| Primary ink | `--color-ink` | `#F2E8D6` |
| Secondary ink | `--color-ink-2` | `#D7C6AB` |
| Muted ink | `--color-ink-3` | `#9E907E` |
| Disabled / quiet ink | `--color-ink-4` | `#706456` |
| Primary terra | `--color-accent` | `#F2A06A` |
| Terra soft | `--color-accent-soft` | `#5A3A28` |
| Terra selected surface | `--color-accent-50` | `#402C22` |
| Amber semantic | `--color-amber` | `#E9B168` |
| Sage semantic | `--color-sage` | `#B9C8A6` |
| Sage surface | `--color-sage-soft` | `#3A4232` |
| Clay semantic | `--color-clay` | `#9A5A3E` |
| Success | `--color-ok` | `#5F8A5B` |
| Warning | `--color-warn` | `#C2892F` |
| Destructive / stop | `--color-stop` | `#B8442E` |

## Foundation scales

- Spacing: `4, 8, 12, 18, 26, 32, 40px`; message padding `18px`, message gap `32px`, message maximum `720px`.
- Radius: `8, 12, 18, 26px`, plus pill `999px`.
- Type: `11, 12.5, 15, 18, 22, 44px`; line heights `1.25, 1.55, 1.6`.
- Motion: `150ms ease` for direct feedback, `250ms ease` for state changes, `3.4s` for waveform cycles, and `1s steps(2)` for cursors.

## Visual rules

- Dusk is dark-only. Use `bg → bg-elev → paper` for depth; fixed surfaces stay tonal and floating layers alone receive strong elevation.
- Fraunces is reserved for brand, page, and section hierarchy; DM Sans carries UI and body content; JetBrains Mono carries metadata, dates, numerics, and tool output.
- Terra is the decisive-action and active-control color. Sage, amber, and clay are semantic or persona roles, never competing decoration.
- Use `line-soft` for routine dividers and `line` only when a boundary needs additional clarity.
- Motion communicates state—thinking, speaking, listening, sending, opening, or interruption—and stops under reduced motion. Canonical avatar SVGs own all assistant artwork and internal animation.
