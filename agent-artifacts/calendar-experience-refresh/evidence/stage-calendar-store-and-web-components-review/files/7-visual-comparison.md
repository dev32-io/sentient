# Calendar web visual and responsive evidence

Captured with the production component harness at `gateway/webui/calendar-evidence.html` and the served reference at `sentient-design/design/web/calendar.html`.

## Exact capture matrix

- Reference URL: `http://127.0.0.1:8799/design/web/calendar.html`; the reference view state is selected through its persisted `sentient-calendar-view` control state.
- Production URL: `http://127.0.0.1:5173/calendar-evidence.html?view=<day|week|month|year>`.
- Capture method: Chrome DevTools Protocol `Emulation.setDeviceMetricsOverride` followed by `Page.captureScreenshot`; measurements use `gateway/webui/src/components/calendar/calendar-responsive-evidence.ts`.
- Viewports: `1440x1000`, `1024x900`, `768x900`, and `390x844`.
- Every `comparison-<view>-<width>x<height>.png` is a labeled side-by-side artifact: **EXACT REFERENCE** is the left pane and **IMPLEMENTATION** is the right pane. The captured viewport pixels are preserved below the labels.

| Labeled state | 1440x1000 | 1024x900 | 768x900 | 390x844 |
| --- | --- | --- | --- | --- |
| Day | `comparison-day-1440x1000.png` | `comparison-day-1024x900.png` | `comparison-day-768x900.png` | `comparison-day-390x844.png` |
| Week | `comparison-week-1440x1000.png` | `comparison-week-1024x900.png` | `comparison-week-768x900.png` | `comparison-week-390x844.png` |
| Month | `comparison-month-1440x1000.png` | `comparison-month-1024x900.png` | `comparison-month-768x900.png` | `comparison-month-390x844.png` |
| Year | `comparison-year-1440x1000.png` | `comparison-year-1024x900.png` | `comparison-year-768x900.png` | `comparison-year-390x844.png` |

The individual exact-reference captures are `reference-<view>-<width>x<height>.png`; implementation captures are `production-<view>-<width>x<height>.png`. All 16 states are represented on both sides of the matrix.

The reference runtime retains its prototype fixture date/data; the production harness uses supported Calendar V2-shaped synthetic occurrences anchored to `2024-02-29`. The comparison therefore evaluates the approved hierarchy, controls, canvas rhythm, responsive behavior, and supported semantics rather than copying prototype content.

## Responsive observations

`scroll-width-evidence.json` records `documentScrollWidth`, `bodyScrollWidth`, `documentClientWidth`, `canvasScrollWidth`, and `canvasClientWidth` for every production state.

- All 16 states report `documentScrollWidth == bodyScrollWidth == documentClientWidth == viewport width` and `noHorizontalOverflow: true`.
- At `768x900` and `390x844`, Week and Month report seven equal columns, `gridScrollWidth == gridClientWidth`, and no page or calendar-canvas horizontal overflow.
- At `768x900` and `390x844`, the roomy sidebar is not rendered and compact controls are rendered.
- At `1024x900` and `1440x1000`, the sidebar is rendered and compact controls are not rendered, proving the pinned 900px collapse boundary.
- At `768x900` and `390x844`, the minimum measured rendered canvas target is `44x44` for date, event, overflow, and Year date controls.
