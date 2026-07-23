# Chat glossary highlighting matches stored per-term surface forms, not runtime stemming

Each glossary term stores an explicit list of surface forms (canonical plus plural and case variants), auto-generated at 'mars glossary set' and overridable via --hits, surfaced through /view/glossary. The chat highlighter matches these forms exactly rather than stemming or doing NLP at render time. Chosen for deterministic, dependency-free, version-controlled matching in CONTEXT.md; the accepted cost is manual upkeep of --hits for irregular or multi-word terms.
