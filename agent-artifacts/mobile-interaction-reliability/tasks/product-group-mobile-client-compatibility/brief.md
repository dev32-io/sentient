# Task Brief: Restore mobile settings compatibility with the product-group catalog

## Contribution Goal

Restore Android and iOS compilation and existing Tools settings behavior after the inherited McpCatalogView wire contract changed from server/native buckets to stable product groups.

## Boundary — Included

- Android ToolsScreen, ToolsViewModel, and focused tests
- iOS ToolsScreen, ToolsViewModel, and focused tests
- Product-group rendering and permission patch compatibility

## Required Work

- 1. Replace Android and iOS consumption of removed McpCatalogEntry, servers, and nativeTools fields with McpCatalogView.groups keyed by stable group id and ProductToolGroupView values.
- 2. Render each product group using its tools, wildcardPermission, description, and defaultExposure while preserving the existing mobile Tools settings visual language.
- 3. Keep permissions keyed by product group id regardless of each tool's MCP/native dispatch metadata. Do not reconstruct authorization identity from transport or tool names.
- 4. Preserve explicit per-tool-over-group precedence, null-clear/reset semantics, settable read-only behavior, save/error flows, and active counts.
- 5. Ensure mixed MCP/native tools and general third-party MCP groups render from the same projection without restoring the retired server/native split.
- 6. Update Android and iOS focused logic tests for group masters, tool overrides, active counts, reset/save patches, and mixed dispatch kinds.
- 7. Run shared SDK, Android, iOS, and diff checks under scripts/env.sh/JDK 21.

## Integration Expectation

Deliver this contribution for integration in stage foundation.

## Context

- The active branch inherited McpCatalogView.groups: Map<String, ProductToolGroupView> from develop, while Android and iOS Tools settings still reference removed McpCatalogEntry, servers, and nativeTools APIs.
- This is a prerequisite regression repair for the current workflow only. Do not reopen, resume, complete, or otherwise mutate the previous first-class-family-tools workflow.
- The authoritative SDK model and permission helpers already define stable product-group identity and explicit tool-over-group precedence.

## Boundary — Excluded

- Changing the product-group wire contract
- Changing gateway permission resolution, migration, or tool dispatch
- Changing the mobile-interaction product scope
- Resuming or changing the previous family-tools workflow

## Interfaces and Dependencies

- Consumes McpCatalogView.groups and ProductToolGroupView from shared/mobile-sdk.
- Produces compiling Android/iOS Tools settings clients with unchanged permission semantics.
