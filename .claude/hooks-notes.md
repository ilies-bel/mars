# Claude Code user-level hooks

The PreToolUse Bash hooks live at `~/.claude/hooks/` (outside this repo,
per-user). Two of them are transparent rewriters that swap legacy tools for
their faster modern equivalents instead of denying the call:

| Wrapper | Rewriter | Effect |
| --- | --- | --- |
| `~/.claude/hooks/block-grep.sh` | `grep-to-rg.py` | `grep`/`egrep`/`fgrep` → `rg` |
| `~/.claude/hooks/block-find.sh` | `find-to-fd.py`  | `find` → `fd` |

Each `block-*.sh` is a one-line `exec python3` to its sibling rewriter.
The previous deny-only versions are kept as `*.bak` next to them.

## find → fd rewriter (2026-05-14)

`block-find.sh` used to deny any `find` invocation. It now rewrites to
`fd` when the translation is unambiguous and passes through unchanged
otherwise — never mistranslates, never denies. The user-level allowlist
in `settings.json` (`Bash[command=find *]`) governs whether the original
`find` runs when a rewrite is skipped.

### Translation table

| find                       | fd                                          |
| --- | --- |
| `-name 'pat'`              | `-g 'pat'`                                  |
| `-iname 'pat'`             | `-i -g 'pat'`                               |
| `-type f`/`d`/`l`          | `-t f`/`d`/`l`                              |
| `-maxdepth N`              | `--max-depth N`                             |
| `-mindepth N`              | `--min-depth N`                             |
| `-path 'pat'`              | `--path-separator / -p 'pat'`               |
| `-print`                   | dropped (fd default)                        |
| `-print0`                  | `--print0`                                  |
| `-exec`/`-execdir`/`-delete`/`-perm`/`-user`/`-group`/`-size`/`-mtime`/`-ctime`/`-newer*`/`-regex`/`-iregex`/`-prune`/`-not`/`!`/`-o`/`-and`/etc. | left alone — no clean fd mapping |

Other types (`b`, `c`, `p`, `s`), unknown flags, multiple `-name`s, or
`-name` combined with `-path` all fall through unchanged.

### Detection rules

`find` is rewritten only at command-start positions: top-level, after `|`,
`&&`, `||`, `;`, `$(`, or backtick. Env-var assignments before the command
are skipped (`FOO=bar find ...` is rewritten). Substrings inside argv to
other commands (`grep find file.txt`, `echo find me`) are not touched.
Segments containing unquoted redirection (`<`, `>`) fall through unchanged
since `shlex.join` would round-trip them incorrectly.

### Verification matrix

The script `python3 ~/.claude/hooks/find-to-fd.py` reads PreToolUse JSON
on stdin and emits a `hookSpecificOutput.updatedInput.command` when it
rewrites. The matrix below was run after install and all 10 cases passed:

| input | result |
| --- | --- |
| `find . -name '*.ts'` | `fd -g '*.ts' .` |
| `find src -type f -name '*.tsx'` | `fd -t f -g '*.tsx' src` |
| `find . -maxdepth 2 -type d` | `fd --max-depth 2 -t d .` |
| `find . -iname 'README*'` | `fd -i -g 'README*' .` |
| `find . -name '*.ts' -exec rm {} \;` | unchanged (has `-exec`) |
| `find . -regex '.*\.tsx?$'` | unchanged (has `-regex`) |
| `echo find me` | unchanged (`find` not at command-start) |
| `FOO=bar find . -type f` | `FOO=bar fd -t f .` |
| `ls \| find -name x` | `ls \| fd -g x` |
| `grep find file.txt` | unchanged (`find` is an argument to `grep`) |

Note on `-name`: the rewriter emits `-g` because fd's default match mode
is regex/substring, not glob. `fd '*.ts'` would treat the pattern as a
regex and error; `fd -g '*.ts'` matches the find semantics faithfully.
