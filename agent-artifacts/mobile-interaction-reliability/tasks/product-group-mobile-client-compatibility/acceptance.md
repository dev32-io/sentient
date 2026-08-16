# Task Acceptance: Restore mobile settings compatibility with the product-group catalog

## Deliverables

- Restore Android and iOS compilation and existing Tools settings behavior after the inherited McpCatalogView wire contract changed from server/native buckets to stable product groups.

## Acceptance

- Android no longer references McpCatalogEntry, servers, or nativeTools and compiles against the current SDK
- iOS no longer references the retired catalog shape and compiles against generated current SDK types
- Group and per-tool edits remain keyed by stable product group id with correct precedence and reset semantics
- Existing Tools settings design and read-only behavior are preserved

## Boundary Proof

- Android and iOS logic tests pin group rendering and permission patch behavior
- Shared SDK and native test suites compile and pass
