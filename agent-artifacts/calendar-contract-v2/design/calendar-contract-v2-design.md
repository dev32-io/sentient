# Bounded calendar query and recurring-mutation design

## Design Goal

Place temporal normalization, bounded querying, effective-occurrence projection, and recurring mutation behind shared domain boundaries so tools and authenticated clients cannot disagree about recurrence, authorization, overflow, or identity.

## Chosen Approach

- Introduce shared calendar query normalization that converts model/REST temporal strings into validated CalendarTime windows, applies configured range and input bounds, and produces typed corrective failures.
- Separate bounded query execution from consumer presentation: REST receives deterministic pages and continuation metadata, while model tools reject any query requiring continuation or exceeding their proactive serialized-size budget.
- Treat the effective occurrence as the sole searchable and filterable projection: expand the base recurrence, apply the original-keyed override, then evaluate visibility, search, group, tags, and importance.
- Introduce one atomic recurrence-mutation domain command with operation update/delete, calendar scope, mutation scope, original start where required, optional expected revision, and an explicit allowlisted changes object.
- Model this_and_following as a true series split: atomically truncate or replace the prefix, create a new successor identity when updating, and partition child state by original recurrence key.
- Use the fresh baseline schema directly for revisioned events and rich JSON exception overrides; do not implement existing-data migration or legacy wire compatibility.
- Expose the same domain command through POST /api/v1/calendar/events/{eventId}/mutations, the web calendar API service, and KMP mobile calendar layers. The tool provider invokes the domain boundary directly rather than calling REST.
- Retain existing calendar screen components outside this story. Client convenience methods may translate their whole-series intent into an entire_series mutation command.

## Verification Boundaries

- Tool contract tests prove all six model-oriented schemas, tolerant time normalization, private defaults, all-scope reads, actionable errors, and proactive overflow handling.
- Query service tests prove pre-query range rejection, aggregate early stop, deterministic ordering/paging, effective search/filter semantics, and no partial all-scope result.
- Recurrence/store contract tests prove occurrence identity, canonical cancellation, rich overrides, COUNT and UNTIL split arithmetic, DST behavior, child-state partition, first-slot handling, rollback, and revision conflict.
- Security tests prove household pre-PDP rejection, capability isolation, hidden-target non-disclosure, and post-override role visibility including visibility that differs from the base series.
- REST contract tests prove the mutation command and deterministic read continuation. Web and KMP client tests prove exact mirrored shapes and typed result mapping.
- Privacy guards prove gateway and mobile diagnostics never capture calendar content, query text, or mutation payloads.
- The approved local E2E matrix verifies actor-visible outcomes across model tools, REST, web service, and mobile shared layers on fresh disposable storage.

## Components and Interfaces

- Calendar temporal parser and query normalizer: accepts the approved date/RFC 3339 precisions, applies household-timezone period expansion, validates ordering, and enforces configured limits.
- Bounded calendar query service: queries capability-held private and household stores, merges timed/all-day occurrences, applies effective-occurrence policy, sorts deterministically, and stops at aggregate bounds.
- Occurrence projector: returns concise model projections with separate event and occurrence identity plus original start, recurrence indicator, scope, revision, title, and time.
- Recurrence mutation service/store command: validates target membership, authorization, expected revision, override fields, recurrence invariants, and performs each mutation in one SQLite transaction.
- Recurrence splitter: computes COUNT slot partitions or UNTIL boundaries from generated recurrence slots rather than visible list rows and partitions exceptions/exclusions by canonical original key.
- Calendar product-tool provider: owns model-oriented schemas, private defaults, pre-PDP household-write rejection, actionable tool errors, and proactive output-size enforcement while preserving tool names and tiers.
- Calendar REST handler: derives the principal from bearer authentication, opens capability-bound stores, provides deterministic read pages, and accepts mutation commands on the sole mutation endpoint.
- Web calendar API service and KMP CalendarHttpClient/repository/use-case layers: mirror command/result types and bounded read contracts without introducing UI behavior.
- Gateway calendar configuration: owns operator-tunable maximum range, occurrence count, string/tag cardinality, and proactive serialized-result size. The generic tool-result cap remains independent.
- Fresh baseline calendar schema: persists event revision and exception override JSON sufficient for every allowed event-local field; event and occurrence identifiers remain immutable.

## Data and Control Flow

- For list/search, parse and normalize from/to, default or validate scope, enforce pre-query bounds, query only authorized stores, expand within the window, apply overrides, evaluate effective visibility and filters, merge and sort, then return a REST page or a complete model result.
- For get, resolve the requested event or occurrence only inside authorized scope, apply its effective projection and visibility policy, and return not found for hidden or unauthorized targets.
- For create, normalize event times, validate structured bounded recurrence, canonicalize its stored representation, write to the selected capability-bound store, and return identity plus revision.
- For this_occurrence update, validate that originalStart identifies a generated slot, merge only allowlisted fields into one sparse override, validate effective timing, increment revision, and return the unchanged event/occurrence identity.
- For this_occurrence delete, validate the generated slot, write one cancelled exception, remove any conflicting exclusion representation, increment revision, and return the affected identity.
- For this_and_following update, locate the generated slot by original key, compute prefix/successor recurrence bounds, partition compatible future exceptions and exclusions, apply successor changes, create its new event ID, and commit all writes and revisions atomically.
- For this_and_following delete, truncate the prefix before the selected slot, remove selected/future child state through the same transaction, create no successor, and delete an empty prefix if the selected slot is first.
- For entire_series, update or delete only the selected persisted segment; previously split segments are independent and are not followed through lineage.
- For REST mutation, validate the command envelope and principal, invoke the same mutation service, and return a typed result identifying applied scope, event ID, optional successor event ID, and new revision.
- For model output, serialize the complete projected result and compare against the calendar-specific budget before returning it to the broker; overflow becomes result_too_large rather than generic truncation.

## Failure and Recovery

- Invalid temporal precision, missing search bounds, impossible dates, incompatible time kinds, inverted ranges, and configured range overflow fail before a store query and tell the caller how to correct the request.
- Aggregate occurrence and serialized-result overflow halt bounded work. REST returns a continuation-capable page; tools return result_too_large with range/filter guidance and no partial result.
- Unauthorized or hidden scope/event/occurrence resolution returns a typed denial or not-found result appropriate to the boundary without revealing hidden identifiers or counts.
- A supplied stale expected revision returns conflict without mutation. Callers can reread the event/occurrence and retry intentionally with the current revision.
- A target original start that is not a generated slot, is unavailable, or is incompatible with the requested mutation returns an actionable occurrence error.
- A recurrence rule change that cannot preserve future exceptions/exclusions returns recurrence_conflict. No child state is silently dropped or remapped.
- SQLite failure at any point in a split or exception mutation rolls back prefix, successor, child rows, and revision changes as one unit.
- Partial all-scope reads do not return a misleading subset; tools direct the caller to retry private or household when every requested scope cannot be read.
- Fresh deployment/setup clears disposable calendar storage before using the changed baseline. Runtime does not contain a general automatic destructive-reset policy.

## Alternatives Considered

- Continuing to expose nested CalendarTime objects was rejected because it couples model generation to storage/wire internals and caused the observed validation failure.
- Permitting unbounded search and relying only on the generic broker cap was rejected because it wastes work and can produce malformed partial JSON.
- Returning the first tool page with continuation was rejected because a model could treat an incomplete page as the full calendar answer.
- Representing this_and_following as many individual exceptions was rejected because it grows without bound and obscures series identity; an atomic successor split matches established calendar behavior.
- Using a moved occurrence start as identity was rejected because overrides would make later mutation ambiguous; original recurrence start remains stable.
- Silently deleting future exceptions when recurrence changes was rejected as hidden data loss; incompatible requests fail atomically.
- Overloading legacy PATCH and DELETE while preserving previous wire contracts was rejected because this branch is a coordinated clean cutover with disposable data; one command endpoint is clearer.
- Adding UI changes was rejected because a broader visual refresh is planned; this story prepares shared backend and client capability only.
