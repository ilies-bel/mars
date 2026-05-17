#!/usr/bin/env python3
"""Parse .mars/watch.log: per-id pair [implement] <id> dispatching -> <id> -> <outcome>, compute durations."""
import re
import sys
from collections import defaultdict, Counter
from datetime import datetime

LOG = "/Users/ib472e5l/project/perso/mars-framework/.mars/watch.log"

# We treat each (id, dispatch_time) -> next event for SAME id with terminal outcome.
dispatch_re = re.compile(r'^\[(?P<ts>[^\]]+)\] \[implement\] (?P<id>[a-zA-Z0-9-]+) dispatching')
terminal_re = re.compile(r'^\[(?P<ts>[^\]]+)\] \[implement\] (?P<id>[a-zA-Z0-9-]+) -> (?P<outcome>\S+)')

# parse line by line; keep pending dispatch per id (most recent unmatched)
pending = {}  # id -> dispatch_ts
runs = []  # (id, dispatch_ts, terminal_ts, outcome, duration_sec)

def parse_ts(s):
    # ISO with Z
    return datetime.fromisoformat(s.replace('Z', '+00:00'))

with open(LOG) as f:
    for line in f:
        m = dispatch_re.match(line)
        if m:
            tid = m.group('id')
            pending[tid] = parse_ts(m.group('ts'))
            continue
        m = terminal_re.match(line)
        if m:
            tid = m.group('id')
            outcome = m.group('outcome')
            tts = parse_ts(m.group('ts'))
            if tid in pending:
                dts = pending.pop(tid)
                dur = (tts - dts).total_seconds()
                runs.append((tid, dts, tts, outcome, dur))

# Filter to recent runs (last 24h from latest event)
if runs:
    latest = max(r[2] for r in runs)
    recent = [r for r in runs if (latest - r[2]).total_seconds() < 24*3600]
else:
    recent = []

print(f"Total matched implement runs in log: {len(runs)}")
print(f"Recent (<24h): {len(recent)}")
print()

outcomes_recent = Counter(r[3] for r in recent)
print("Outcome distribution (recent):")
for o, c in outcomes_recent.most_common():
    print(f"  {o:20s} {c}")
print()

# Durations by outcome
def stats(values):
    if not values:
        return None
    vs = sorted(values)
    n = len(vs)
    return {
        'n': n,
        'min': vs[0],
        'p25': vs[n//4],
        'median': vs[n//2],
        'p75': vs[3*n//4],
        'p90': vs[min(n-1, int(n*0.9))],
        'max': vs[-1],
        'mean': sum(vs)/n,
    }

print("Duration stats by outcome (recent):")
by_outcome = defaultdict(list)
for r in recent:
    by_outcome[r[3]].append(r[4])
for outcome, durs in by_outcome.items():
    s = stats(durs)
    print(f"  {outcome:20s} n={s['n']:4d} min={s['min']:6.1f}s p25={s['p25']:6.1f}s median={s['median']:6.1f}s p75={s['p75']:6.1f}s p90={s['p90']:6.1f}s max={s['max']:6.1f}s mean={s['mean']:6.1f}s")
print()

# Recent failed tasks for sampling
failed_recent = [r for r in recent if r[3] == 'failed']
print(f"Recent failed: {len(failed_recent)}")
# Print last 40 failed ids with durations
print()
print("Last 40 failed (id, duration_s):")
for r in failed_recent[-40:]:
    print(f"  {r[0]}  {r[4]:6.1f}s  dispatch={r[1].isoformat()}")

# Also bucket all durations regardless of outcome (failed)
print()
print("Failed-only duration buckets:")
buckets = [(0, 5), (5, 10), (10, 30), (30, 60), (60, 120), (120, 300), (300, 600), (600, 99999)]
fdurs = [r[4] for r in failed_recent]
for lo, hi in buckets:
    c = sum(1 for d in fdurs if lo <= d < hi)
    print(f"  [{lo:4d}, {hi:5d}) s: {c}")

# Save failed ids to a file for downstream mars show
with open("/tmp/recent_failed_ids.txt", "w") as f:
    for r in failed_recent:
        f.write(r[0] + "\n")
print()
print(f"Wrote {len(failed_recent)} ids to /tmp/recent_failed_ids.txt")
