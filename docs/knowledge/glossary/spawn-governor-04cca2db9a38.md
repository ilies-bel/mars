# Spawn governor

The admission-control gate the daemon consults before acquiring a Worker semaphore slot; samples host load and memory at each watchdog tick and refuses new spawns when either signal is in High or Critical pressure, leaving the task in queued for the next drain cycle.

_Avoid_: admission control, pressure gate, load gate, governor
