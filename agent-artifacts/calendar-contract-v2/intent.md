# Intent: Model-friendly bounded calendar contracts and recurring mutations

## Problem

The six model-facing calendar tools expose internal temporal structures, accept unsafe query ranges, return ambiguous validation failures, can overflow or be truncated into malformed output, and cannot apply industry-standard mutations to recurring occurrences.

## Desired Outcome

Calendar tools accept concise human-oriented arguments, produce bounded and actionable results, and support Google-style recurring mutations through one authoritative domain contract also exposed to web and mobile clients.

## Scope — Included

- All six existing calendar tools: calendar_list, calendar_search, calendar_get, calendar_create, calendar_update, and calendar_delete
- Tolerant date and RFC 3339 normalization, safe scope defaults, bounded queries, concise occurrence projections, and actionable errors
- Google-style this_occurrence, this_and_following, and entire_series update and delete semantics
- Atomic recurrence splitting, rich occurrence-local overrides, canonical cancellation, and stale-revision conflict handling
- One REST mutation command shared by the web calendar API service and KMP mobile SDK, repositories, and use cases
- A coordinated clean cutover on the current delivery branch using disposable calendar storage

## Success Signals

- The approved golden, edge, failure, and recovery scenarios are observable on the local stack
- The model can call every calendar tool without constructing internal CalendarTime objects or interpreting ambiguous occurrence identifiers
- Overwide, overlarge, invalid, unauthorized, conflicting, and recurrence-incompatible requests fail without partial results or partial mutation
- Web and mobile shared clients issue the same scoped recurring-mutation command without calendar screen changes
- All data mutations preserve occurrence identity and recurrence invariants under atomic local transactions

## Scope — Excluded

- Web, Android, or iOS calendar UI changes
- Implementation of design-ref assets or the deferred calendar visual refresh
- Scheduler behavior, reminders, notification delivery, and Google Calendar synchronization
- Full RFC 5545 support and cross-household behavior
- Migration or preservation of existing calendar data
- Backward compatibility for prior calendar REST wire contracts

## Constraints

- Preserve tool names, permission tiers, role gates, capability isolation, and scope-bound storage authority
- Read tools may explicitly request all scopes; writes accept only private or household; omitted scope defaults to private
- Calendar tools must reject oversized results before the generic broker truncation backstop and must never represent a partial page as complete
- Occurrence visibility, search, and metadata filters are evaluated on the effective occurrence after its override
- Gateway and clients may log sanitized identifiers, types, sizes, counts, statuses, and revisions but never calendar content, query text, or mutation payloads
- The tool provider and REST handlers share domain boundaries but the tool provider does not call REST through loopback
- Local verification uses fresh disposable calendar databases and never production state
