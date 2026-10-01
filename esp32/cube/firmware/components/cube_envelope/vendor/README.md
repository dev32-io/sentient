# Pinned Boost headers (unmodified)

Boost 1.91.0. `sources.json` records each module's upstream URL, exact commit,
archive SHA-256 and archive size. Archives use:

```
https://codeload.github.com/boostorg/<module>/tar.gz/<commit>
```

Complete `include/` trees of these 11 modules are retained, plus license files
present in those modules: assert, config, container, core, endian, intrusive,
json, move, mp11, system, throw_exception. Shared `LICENSE_1_0.txt` supplies full
Boost Software License 1.0 for modules whose archives only reference it.
Per-file copyright/attribution is unchanged. `SHA256SUMS` covers all upstream
files under module directories. No upstream source changes, generated stubs,
Boost build framework, or installed package required.

JSON commit: `70efd4b032b7f3e718bb4ca4ae144c3171b21568`.

Only the five implementation units selected by `../boost_json_core.cc` compile.
Do not use `boost/json/src.hpp`: its parse/serialize stream initializers retain
unneeded iostream machinery. The internal `.ipp` source selection is deliberately
coupled to this pin; repeat host/sanitizer/cross-build tests on any upgrade.
These private headers are not a supported general-purpose Boost installation;
unrelated optional APIs may require other Boost modules.

Vendored upstream trees: 664 files, 6,693,775 bytes (~6.38 MiB), excluding shared
license/provenance files. Not a tiny library. Runtime/flash costs need actual
firmware-map and stack/heap verification, not inference from source size.

To update, fetch each reviewed commit archive into scratch, verify archive
checksums, replace whole include/license trees without modifying source, update
pins and per-file checksums, and run component tests with actual ESP-IDF cJSON.
No network fetch occurs at firmware build or test time.
