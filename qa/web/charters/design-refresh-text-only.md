# Design refresh — text-only WebUI charter

Drive only E2E-001 through E2E-005 from `qa/design-refresh/e2e-matrix.json` through `qa/design-refresh/run-web-text-only.sh`. Use the real loopback stack at `https://localhost/`, disposable fixture users/calendar rows, and the evidence root `qa/web/evidence/design-refresh/`.

## Safety boundary

- Production hosts and data are prohibited.
- Do not request or activate microphone capture, speech services, playback, acoustic features, or audio routes.
- Do not stop/restart the gateway, toggle connectivity, or manipulate Wi-Fi/network adapters.
- Clearly label all entered content synthetic; do not capture authentication material, private content, model input/output logs, speech-derived text, sound files, or live identifiers.
- Cleanup is mandatory even after driver failure. The entrypoint owns fixture teardown.
- Visual review records configurations, focus/target/overflow measurements, and native differences. It does not make pixel-perfect comparisons.
