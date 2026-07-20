#!/usr/bin/env bash
# PreToolUse Bash hook: warn when a command writes to the Mars Postgres
# database with raw SQL instead of using the `mars` CLI. Non-blocking (exit 0).

set -u

input="$(cat)"

cmd="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')"
[ -z "$cmd" ] && exit 0

# Only react if the command targets the Mars database — the published DSN
# file (.mars/pg.dsn) is the one documented handle for reaching it, so any
# psql/SQL traffic that reads it is aimed at the Mars store.
case "$cmd" in
  *pg.dsn*) ;;
  *) exit 0 ;;
esac

# Only warn when a SQL write verb appears in the command
shopt -s nocasematch
if [[ ! "$cmd" =~ (insert[[:space:]]+into|update[[:space:]]+[a-z_\"\`]+[[:space:]]+set|delete[[:space:]]+from|drop[[:space:]]+(table|index|database)|alter[[:space:]]+table|create[[:space:]]+(table|index|trigger)|replace[[:space:]]+into|truncate[[:space:]]+) ]]; then
  shopt -u nocasematch
  exit 0
fi
shopt -u nocasematch

cat >&2 <<'WARN'
[mars] WARNING: raw SQL write against the Mars database detected.
       Use the `mars` CLI instead (e.g. `mars add`, `mars run`, `mars task ...`)
       so queue invariants and orchestrator state stay consistent.
       If you really need raw SQL, ack this warning and proceed.
WARN

exit 0
