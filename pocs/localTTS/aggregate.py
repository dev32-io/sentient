#!/usr/bin/env python3
"""Collect every localTTS PoC result into one comparison table + write RESULTS.md.

Scans <option>/out/<variant>/metrics.json. Run from anywhere:
    python aggregate.py
"""
import glob
import json
from pathlib import Path

root = Path(__file__).parent
rows = []
for mf in sorted(glob.glob(str(root / "*/out/*/metrics.json"))):
    p = Path(mf)
    variant = p.parent.name          # out/<variant>/metrics.json
    option = p.parents[2].name        # <option>/out/<variant>/...
    d = json.load(open(mf))
    ttfa = d.get("ttfa_ms_median")
    rows.append({
        "option": option,
        "variant": variant,
        "ttfa_ms": ttfa,
        "rtf": d.get("rtf_median"),
        "xrt": d.get("xrt_median"),
        "rss_mb": d.get("rss_mb_peak"),
        "mini_ttfa_ms": round((ttfa or 0) * 1.3),
    })

rows.sort(key=lambda r: (r["option"], r["variant"]))
hdr = ["option", "variant", "ttfa_ms", "rtf", "xrt", "rss_mb", "mini_ttfa_ms"]
lines = ["| " + " | ".join(hdr) + " |", "|" + "|".join(["---"] * len(hdr)) + "|"]
for r in rows:
    lines.append("| " + " | ".join(str(r[h]) for h in hdr) + " |")
table = "\n".join(lines)

print(table)
out = root / "RESULTS.md"
out.write_text(
    "# localTTS results\n\n"
    "M3 Pro (dev box). `mini_ttfa_ms` = base-M4 estimate (×1.3). "
    "`rtf` < 1 = faster than real time; `xrt` = audio-sec per compute-sec.\n\n"
    + table + "\n"
)
print(f"\nwrote {out}")
