# Calendar web visual and responsive evidence

Captured with the production component harness at `gateway/webui/calendar-evidence.html` and the served reference at `sentient-design/design/web/calendar.html`.

## Exact capture matrix

- Reference URL: `http://127.0.0.1:8799/design/web/calendar.html`
- Production URL: `http://127.0.0.1:5173/calendar-evidence.html?view=<day|week|month|year>`
- Capture method: Chrome DevTools Protocol `Emulation.setDeviceMetricsOverride` followed by `Page.captureScreenshot`; measurements use `gateway/webui/src/components/calendar/calendar-responsive-evidence.ts`.
- Viewports: `1440x1000`, `1024x900`, `768x900`, and `390x844`.
- Production captures include Day, Week, Month, and Year at every viewport.
- `comparison-month-<width>x<height>.png` places the served reference on the left and the production Month canvas on the right at the same exact viewport.

The reference runtime retains its prototype fixture date/data; the production harness uses supported Calendar V2-shaped synthetic occurrences anchored to `2024-02-29`. The comparison therefore evaluates hierarchy, controls, canvas rhythm, responsive behavior, and supported semantics rather than copying prototype content.

## Responsive observations

`scroll-width-evidence.json` records the DOM measurements for every production view. In particular:

- At `768x900` and `390x844`, Week and Month report seven columns, `documentScrollWidth == viewport width`, `bodyScrollWidth == viewport width`, and `noHorizontalOverflow: true`.
- At `768x900` and `390x844`, the roomy sidebar is not rendered and compact controls are rendered.
- At `1024x900` and `1440x1000`, the sidebar is rendered and compact controls are not rendered, proving the pinned 900px collapse boundary.
- At `768x900` and `390x844`, the minimum measured rendered canvas target is `44x44` for date, event, overflow, and Year date controls.
- All four views report no page-level horizontal overflow at all four exact viewports.
