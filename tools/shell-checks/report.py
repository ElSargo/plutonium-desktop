#!/usr/bin/env python3
"""Prints run.sh's checks, one line each, and exits 1 if any failed.

report.py <javascript-url result> <checks JSON>...: each argument as
`plutonium cdp eval` printed it (a JSON string holding JSON, or null).
"""
import json
import sys


def decode(raw):
    value = json.loads(raw) if raw not in ("null", "") else None
    return json.loads(value) if isinstance(value, str) else value


javascript_url = decode(sys.argv[1]) or {}
results = [r for raw in sys.argv[2:] for r in (decode(raw) or [])]
# A javascript: URL's result replaces the document without a navigation the
# browser sees as a new document: same frame, origin, URL and document user
# data. It is the shell's own code (no other origin can run a javascript: URL
# in the shell's frame), so it keeps the shell's API and grants, as with
# document.open(). Reported, not asserted.
results.append({
    "name": "javascript: URL document (not asserted): API / old document's grant / new grant",
    "got": " / ".join(javascript_url.get(k, "(no result)") for k in ("exposure", "oldGrant", "newGrant")),
    "want": "(any)",
    "ok": True,
})
failed = 0
for r in results:
    failed += not r["ok"]
    line = f"{'ok  ' if r['ok'] else 'FAIL'} {r['name']}: {r['got']}"
    if not r["ok"]:
        line += f"   (want {r['want']})"
    print(line)
print(f"{len(results) - failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
