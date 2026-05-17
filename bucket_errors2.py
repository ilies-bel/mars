#!/usr/bin/env python3
"""Better failure bucketing: read whole `mars show <id>` output, classify by error text."""
import subprocess
import re
import json
from collections import Counter, defaultdict

REPO = "/Users/ib472e5l/project/perso/mars-framework"

def classify(text):
    if not text:
        return "empty"
    if "no-action-after-reads" in text:
        return "too_hard:no-action-after-reads"
    if "install-frozen-lockfile" in text or "pnpm install" in text:
        return "setup:install/install-frozen-lockfile"
    if "merge:preflight/uncommitted-changes" in text or "uncommitted-changes" in text:
        return "merge:preflight/uncommitted-changes"
    if "verify:typecheck" in text or "typecheck" in text:
        return "verify:typecheck"
    if "verify:has-diff/no-commits-ahead" in text:
        return "verify:has-diff/no-commits-ahead"
    if "verify:" in text:
        return "verify:other"
    if "MARS_CLAUDE_MAX_MESSAGES" in text or "message cap" in text:
        return "claude:max-messages"
    if "ENOENT" in text or "spawn" in text.lower():
        return "spawn-error"
    if "Mastra" in text or "workflow failed" in text:
        return "mastra-runner"
    if "exited 137" in text:
        return "claude:exit-137"
    if "exited 124" in text or "timed out" in text:
        return "claude:timeout"
    if "retry_budget_exhausted_at_unblock" in text:
        return "retry_budget_exhausted_at_unblock"
    return "other"

records = []
with open("/tmp/recent_failed_ids.txt") as f:
    ids = [l.strip() for l in f if l.strip()]

for tid in ids:
    r = subprocess.run(["mars", "--repo", REPO, "show", tid],
                       capture_output=True, text=True, timeout=20)
    out = r.stdout
    # Extract error block: lines after "error:" until next top-level field (^[a-zA-Z]+:)
    err = ""
    in_err = False
    for line in out.splitlines():
        if line.startswith("error:"):
            in_err = True
            err = line[6:].strip()
            continue
        if in_err:
            # stop on top-level field
            if re.match(r'^[a-zA-Z][a-zA-Z0-9_]*:\s', line):
                break
            err += " " + line.strip()
    err = err.strip()
    # failureReason field
    fr_m = re.search(r'^failureReason:\s*(\S+)', out, re.M)
    fr = fr_m.group(1) if fr_m else ""
    sig = classify(err) if err else (fr if fr else "no-error-and-no-reason")
    records.append({"id": tid, "failureReason": fr, "err_head": err[:200], "sig": sig})

# bucket
buckets = Counter(r["sig"] for r in records)
print(f"Total: {len(records)}")
print()
print("Signature buckets:")
for sig, c in buckets.most_common():
    pct = c / len(records) * 100
    print(f"  {sig:45s} {c:4d}  {pct:5.1f}%")

# show 2 examples per bucket
print()
print("Examples per bucket:")
by_sig = defaultdict(list)
for r in records:
    by_sig[r["sig"]].append(r)
for sig, rs in by_sig.items():
    print(f"\n[{sig}] ({len(rs)} tasks)")
    for r in rs[:3]:
        print(f"  {r['id']}  fr={r['failureReason']!r}  err={r['err_head']!r}")

# save JSON
with open("/tmp/failure_breakdown.json", "w") as f:
    json.dump({"buckets": dict(buckets), "records": records}, f, indent=2)
print("\nSaved /tmp/failure_breakdown.json")
