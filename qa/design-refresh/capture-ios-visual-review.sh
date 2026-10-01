#!/usr/bin/env bash
set -euo pipefail
# Catalog inventory labels have no production dispatch. Never launch dozens of
# generic specimens or invent accessibility/layout observations for them.
echo "iOS inventory capture unavailable: production row fixtures missing. Use scripts/design/capture-ios-visual-diff.sh for registered real components; export tools/visual-diff/coverage.mjs for gaps. No measurements or motion proof inferred." >&2
exit 2
