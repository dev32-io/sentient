# Task Acceptance: Cut the web calendar service over to REST V2

## Deliverables

- Web consumers can page calendar reads and issue every recurring mutation scope through the V2 command while current calendar components remain unchanged.

## Acceptance

- Web list understands events plus nextCursor and emits raw temporal query strings.
- All updates/deletes use POST mutation commands; no PATCH/DELETE fetch remains.
- Every mutation scope and typed conflict/error can be represented.
- Existing calendar components compile and their whole-series calls map to entire_series without component edits.
- Logs and retained evidence contain no token or calendar payload content.

## Boundary Proof

- Web service unit tests assert exact methods, paths, query parameters, bodies, responses, and errors.
- Handler-backed service integration covers the web portion of E2E-014/E2E-015.
- Existing calendar-view tests and typecheck remain green unchanged.
