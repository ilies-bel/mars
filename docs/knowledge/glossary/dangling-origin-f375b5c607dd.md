# Dangling origin

An Arc whose originId has no backing Task row: member tasks carry it as origin_id but no Task has it as its own id, so any lookup keyed on the originId (task detail, arc title) finds nothing.

_Avoid_: orphan origin, missing origin task, headless arc
