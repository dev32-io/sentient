# Web settings editor Wave 4 evidence

Production fixture: `gateway/webui/src/components/common/composites.tsx#SettingsEditor`

Comparator profile:

- ODiff threshold: `0.56`
- anti-aliasing: ignored
- background: Dusk `#2B2621`
- percentage basis: visible alpha union
- maximum visible diff: `0.2%`

Results:

- saved: `0.05%` (`441 / 835980` visible pixels), pass
- unsaved: `0.05%` (`441 / 835980` visible pixels), pass

The remaining counted pixels are confined to the Reset label bounds. Both authority-backed state captures were visually inspected. The fixture uses production `SettingsEditor`, `Field`, `TextArea`, and `ActionButton` components. Product settings panes retain their existing global Apply owner; the direct fixture supplies the handoff's generic footer actions without persistence behavior.
