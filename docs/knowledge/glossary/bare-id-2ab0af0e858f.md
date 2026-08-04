# Bare id

The hex-only core of a Mars id. It is NOT the stored identity: every entity table stores the full '<tag>-<hex>' string as its primary key, and foreign keys, worktree directory names, and git branch names all carry the tag. The bare hex is used only for equality/partial-match lookups.

_Avoid_: short id, raw id, hex id
