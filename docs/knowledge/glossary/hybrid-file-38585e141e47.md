# Hybrid file

A path the framework would write to but the consumer may also edit (e.g. .claude/settings.json, .gitignore). The manifest's hybrid[] list. 'mars install' writes it only if absent; if present, it refuses and tells the user to back up and remove the file.

_Avoid_: shared file, merged file, conflicted file
