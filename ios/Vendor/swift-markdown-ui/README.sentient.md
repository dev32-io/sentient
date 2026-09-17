# Sentient MarkdownUI patch

Vendored runtime from [MarkdownUI 2.4.1](https://github.com/gonzalezreal/swift-markdown-ui/tree/5f613358148239d0292c0cef674a3c2314737f9e), commit `5f613358148239d0292c0cef674a3c2314737f9e`. Original MIT license retained. This source copy pins MarkdownUI; normal XcodeGen builds use this local package, not a cache edit or temporary workspace.

`sentient.patch` is already applied to the upstream runtime:
- `BlockSequence.swift`: positional block identity and corresponding margin-cache keys avoid replacing the whole block subtree for every streamed substring. Applies to all block variants, not only lists.
- `ListItemView.swift`: measure unconstrained intrinsic marker width before column-width feedback, preserving numbering alignment when digit count changes.

No renderer replacement, parsing cache, stream throttling, or chat geometry changes. Positional identity is not semantic identity across arbitrary reordering. Large tables still require potentially expensive grid layout; this patch does not promise efficient rendering of every large document.

Only runtime sources and license are vendored. Upstream DocC, examples and tests are omitted. Package.swift omits upstream test target and its snapshot-testing dependency; runtime dependency requirements are unchanged.

Consumer regressions live in `ios/Tests/MarkdownIdentityTests.swift`: subtree lifetime through append/partial-item updates and warm-vs-fresh height/render equivalence through numbering, nesting, edits and block-type changes. Existing chat geometry tests remain authoritative for exact history extent. Phone improvement was user-observed; tests are not FPS evidence.

To upgrade: explicitly choose a new upstream revision, replace runtime sources, review/reapply the small patch (unless upstream fixes it), update provenance here, then run native regression suite. Never silently refresh the vendored version. No patch application runs during builds.
