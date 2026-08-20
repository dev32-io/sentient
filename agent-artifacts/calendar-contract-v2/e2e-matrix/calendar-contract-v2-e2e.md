# Calendar contract V2 E2E matrix

## Cases

### E2E-001 — Adult asks for a calendar range without specifying scope.

**Classification:** golden-path

#### Setup

- Create disposable private timed and all-day events plus a household event.
- Fix the household timezone for deterministic normalization.

#### Actions

- Call calendar_list with month-level dates.
- Call calendar_list with RFC 3339 values that omit seconds.

#### Expected Outcomes

- Inputs normalize correctly.
- Timed and all-day occurrences merge and sort deterministically.
- Only private events return because omitted scope defaults to private.

#### Evidence

- Model-visible tool result.
- Disposable private and household store contents.

#### Safety

- Use local temporary stores and synthetic event content.
- Do not access production calendar data.

### E2E-002 — Adult and child query all visible calendars.

**Classification:** golden-path

#### Setup

- Create private, household-everyone, and household-adults events for disposable adult and child principals.

#### Actions

- Invoke calendar_list and calendar_search with scope all under the adult principal.
- Repeat the reads under the child principal.

#### Expected Outcomes

- Adult sees authorized private and household occurrences.
- Child sees private and household-everyone occurrences only.
- Hidden occurrence counts and identifiers are not exposed.

#### Evidence

- Adult and child tool results.
- Capability and store-call trace containing no calendar content.

#### Safety

- Use disposable principals and synthetic events.
- Do not retain private response payloads in diagnostics.

### E2E-003 — Model supplies impossible, inverted, incompatible, and over-limit boundaries.

**Classification:** failure

#### Setup

- Configure a small disposable maximum query range.

#### Actions

- Invoke list or search with an impossible date.
- Invoke with an inverted range.
- Invoke with incompatible time kinds.
- Invoke with a range wider than the configured ceiling.

#### Expected Outcomes

- No store query occurs for any invalid request.
- Each call returns a specific stable code and a corrective model-visible message.

#### Evidence

- Tool results.
- Zero store-call assertion.

#### Safety

- Do not persist any calendar mutation.

### E2E-004 — A valid range matches too many or too-large events.

**Classification:** recovery

#### Setup

- Configure low aggregate-occurrence and serialized-result ceilings.
- Create bounded synthetic fixtures exceeding each ceiling.

#### Actions

- Query the fixture through a model tool.
- Query the same range through REST.

#### Expected Outcomes

- The tool returns result_too_large with narrowing guidance and no partial events.
- REST returns a valid deterministic page with continuation metadata.
- The generic broker cap does not corrupt or truncate calendar JSON.

#### Evidence

- Tool result.
- REST response.
- Broker cap observation.

#### Safety

- Use bounded synthetic data and delete its temporary stores.

### E2E-005 — Model searches without a range, then corrects the request.

**Classification:** failure

#### Setup

- Create matching and nonmatching effective occurrences.

#### Actions

- Call calendar_search without from/to.
- Retry with a valid bounded range.

#### Expected Outcomes

- The first call explains that from and to are required.
- The corrected search matches effective occurrence title or description and respects filters.

#### Evidence

- Consecutive model-visible tool results.

#### Safety

- Use no external services or real calendar content.

### E2E-006 — Model creates a private weekly event using simplified arguments.

**Classification:** golden-path

#### Setup

- Open an empty disposable private calendar.

#### Actions

- Call calendar_create with omitted scope, a timestamp without seconds, and structured weekly recurrence.
- List a covering range.

#### Expected Outcomes

- Scope defaults to private.
- The timestamp normalizes.
- Canonical recurrence is stored.
- The expected occurrences list with unambiguous identities.

#### Evidence

- Create result.
- Persisted base event.
- Covering list result.

#### Safety

- Remove the disposable calendar after verification.

### E2E-007 — Child attempts household create, update, and delete.

**Classification:** failure

#### Setup

- Create a disposable child principal and household fixture event.

#### Actions

- Invoke all three write tools explicitly against household scope.

#### Expected Outcomes

- Every call fails before permission prompting.
- No store mutation occurs.
- An adult-equivalent principal remains eligible through normal permission mediation.

#### Evidence

- Tool results.
- Permission-event trace.
- Store call counts.

#### Safety

- Perform no unauthorized write and remove disposable state.

### E2E-008 — Adult changes every supported local field on one recurring occurrence.

**Classification:** golden-path

#### Setup

- Create a household recurring event visible to everyone.

#### Actions

- Update one occurrence’s title, description, time, visibility, importance, group, and tags.
- Read and search the range as an adult and a child.

#### Expected Outcomes

- Only the selected occurrence changes.
- Original occurrence identity remains stable after its time moves.
- Search and filters use effective values.
- Child visibility reflects the occurrence override without exposing other hidden data.

#### Evidence

- Adult and child list/search results.
- The selected exception row.

#### Safety

- Use synthetic content and never log the mutation payload.

### E2E-009 — Adult cancels one recurring occurrence.

**Classification:** golden-path

#### Setup

- Create a recurring series with multiple visible occurrences.

#### Actions

- Call calendar_delete with applyTo this_occurrence and the target original start.

#### Expected Outcomes

- The selected occurrence disappears.
- Adjacent occurrences remain.
- Exactly one canonical cancelled exception is stored without a duplicate EXDATE.

#### Evidence

- Before and after list results.
- Exception and exclusion storage.

#### Safety

- Use a disposable calendar.

### E2E-010 — Adult updates one occurrence and all following occurrences in a COUNT-bounded series.

**Classification:** edge

#### Setup

- Create a COUNT-bounded series with past and future exceptions and exclusions.

#### Actions

- Apply this_and_following at a middle generated slot.

#### Expected Outcomes

- Prefix and successor have correct counts and nonoverlapping event IDs.
- Past child state stays with the prefix and compatible future child state moves to the successor.
- No generated occurrence is duplicated or lost.

#### Evidence

- Both persisted series segments.
- A covering occurrence list.

#### Safety

- Assert transaction rollback on an induced failure and delete the temporary database.

### E2E-011 — Adult changes the future portion of an UNTIL-bounded series.

**Classification:** edge

#### Setup

- Create a timed UNTIL-bounded recurrence crossing a daylight-saving boundary.

#### Actions

- Split at a middle original occurrence.

#### Expected Outcomes

- The prefix ends at the preceding generated occurrence.
- The successor retains the terminal bound and event timezone.
- Wall-clock recurrence remains daylight-saving correct.

#### Evidence

- Persisted recurrence rules.
- A covering occurrence list.

#### Safety

- Use a fixed test timezone and deterministic clock.

### E2E-012 — A following-series rule change would orphan future exceptions.

**Classification:** failure

#### Setup

- Create a future exception incompatible with the requested successor rule.

#### Actions

- Apply this_and_following with the incompatible recurrence change.

#### Expected Outcomes

- The command returns recurrence_conflict.
- Prefix, successor, revisions, exceptions, and exclusions remain unchanged.

#### Evidence

- Typed error response.
- Before and after database equivalence.

#### Safety

- Verify atomic rollback in a temporary database.

### E2E-013 — Adult removes the selected and all future occurrences.

**Classification:** golden-path

#### Setup

- Create a recurring series with past and future occurrences.

#### Actions

- Call calendar_delete with applyTo this_and_following.

#### Expected Outcomes

- The prefix is truncated before the target.
- Past occurrences remain.
- No successor is created.

#### Evidence

- Mutation result.
- Persisted base recurrence.
- Covering occurrence list.

#### Safety

- Use a disposable event and database.

### E2E-014 — Tool, web service, and mobile SDK mutate the same disposable recurring event after the coordinated contract cutover.

**Classification:** golden-path

#### Setup

- Start a local authenticated gateway with a fresh calendar database and disposable event.

#### Actions

- Exercise this_occurrence, this_and_following, and entire_series through the mutation command contract.
- Exercise whole-series update and delete through the same command boundary.

#### Expected Outcomes

- All consumers use the same wire shape and domain boundary.
- Old PATCH and DELETE routes are unused.
- No UI component changes are required.

#### Evidence

- Captured local requests with content removed.
- Typed client results.
- Final disposable store state.

#### Safety

- Use a fresh local calendar database and make no existing-data assumptions.
- Exclude tokens and payload content from evidence.

### E2E-015 — Future web and mobile consumers issue recurrence mutations without UI changes.

**Classification:** golden-path

#### Setup

- Start a local authenticated gateway and create a disposable event.

#### Actions

- Execute a mutation through the web calendar API service.
- Execute a mutation through the KMP CalendarHttpClient, repository, and use case.

#### Expected Outcomes

- Both clients produce the same mutation-command wire shape and typed result.
- No platform UI state changes are required.

#### Evidence

- Captured local requests with private fields removed.
- Decoded web and KMP results.

#### Safety

- Use the local stack only.
- Exclude tokens and payloads from retained evidence.

### E2E-016 — Two clients mutate from the same event revision.

**Classification:** recovery

#### Setup

- Read one revision into two independent local clients.

#### Actions

- Submit a successful mutation from the first client.
- Submit a mutation carrying the stale revision from the second client.
- Reread the event.

#### Expected Outcomes

- The second client receives conflict.
- The first mutation remains intact.
- The reread supplies the new revision for an informed retry.

#### Evidence

- Both mutation responses.
- Final store state.

#### Safety

- Use deterministic local concurrency and disposable data.

## Scope

- All six model-facing calendar tools and their temporal, scope, query-bound, result-bound, and error contracts
- Effective occurrence projection, Google-style recurring mutations, atomic store behavior, and revision conflicts
- The replacement REST mutation command plus web and KMP shared-client integration
- Role, capability, visibility, and diagnostic-privacy boundaries
- Fresh disposable calendar storage only; no UI visual changes, existing-data migration, or legacy REST compatibility

## Safety

- Run only against the local stack and fresh disposable calendar databases.
- Use disposable users and synthetic event content.
- Never mutate or clear production calendar state.
- Do not log or retain calendar titles, descriptions, dates, search text, tool arguments, mutation payloads, credentials, or tokens.
- Clean up temporary stores and principals after each case.
