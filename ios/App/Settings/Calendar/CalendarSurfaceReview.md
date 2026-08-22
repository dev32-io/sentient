# iOS calendar surface reference review

Compared against the served canonical reference at
`http://127.0.0.1:8799/design/mobile/calendar.html` for 390×844 and 430×932.
The SwiftUI previews in `CalendarSurfacePreviews.swift` cover Day, Week, Month,
and Year at both sizes plus dense, empty, offline, error, safe-area, and
accessibility Dynamic Type conditions.

## Geometry proof

- Fixed top bar: 58 pt, with a Terra Add action.
- Main content: 16 pt inset; both filter rails extend through that inset.
- Scope controls: at least 44 pt high. Tag controls retain the reference 34 pt
  visual while providing a 44 pt effective target.
- Month: seven columns by six rows (42 shared-projection cells), 53 pt minimum
  cell height, up to three semantic indicators, and accessible `+N` overflow.
- Week: seven equal-width date controls; selecting a date dispatches only the
  shared date action so shared navigation keeps Week active.
- Agenda: approximately 64 pt event rows in shared projection order.
- Floating selector: 46 pt controls in a material/elevated capsule. A bottom
  safe-area inset and 78 pt content reserve keep rows clear of it and the home
  indicator.
- One vertical scroll region owns heading, filters, compact canvas, and agenda;
  the 58 pt top bar and floating view selector remain fixed.

## Approved corrections from the prototype

Only the corrections named in the reviewed task contract are applied:

1. Year renders every real date supplied by all twelve complete summaries,
   rather than the prototype's fixed 28 decorative dots.
2. Compact tags retain 34 pt visuals but have 44 pt effective hit areas.
3. The floating view bar clears the device safe area/home indicator.
4. Prototype member, place, reminder, and color semantics are omitted. The
   surface displays only supported scope, group, tag, importance, and search
   facets from real controlled state.
5. Shared full-date, today, selected, outside-month, event, and overflow
   semantics are exposed to VoiceOver; reduced motion removes nonessential
   transitions.
