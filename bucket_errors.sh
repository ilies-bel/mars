#!/usr/bin/env bash
# For each id in /tmp/recent_failed_ids.txt, fetch the failureReason / error and bucket.
set -u
REPO=/Users/ib472e5l/project/perso/mars-framework
OUT=/tmp/error_signatures.tsv
: > "$OUT"
while read -r id; do
  [ -z "$id" ] && continue
  out=$(mars --repo "$REPO" show "$id" 2>/dev/null)
  reason=$(printf "%s\n" "$out" | rg '^failureReason:' | head -1 | sed 's/^failureReason: *//')
  errline=$(printf "%s\n" "$out" | rg '^error:' -A 1 | tail -1 | head -c 240)
  if [ -z "$reason" ]; then reason="<none>"; fi
  printf "%s\t%s\t%s\n" "$id" "$reason" "$errline" >> "$OUT"
done < /tmp/recent_failed_ids.txt
echo "Wrote $OUT"
wc -l "$OUT"
echo "--- top failureReason buckets ---"
cut -f2 "$OUT" | sort | uniq -c | sort -rn
