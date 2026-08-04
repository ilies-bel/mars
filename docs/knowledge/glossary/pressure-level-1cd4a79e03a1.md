# Pressure level

The Spawn governor's per-tick verdict on host resource state — Normal, Elevated, High, or Critical — computed as the worst band across load-ratio (loadavg-1 / cpu-count) and memory-used (1 - freemem / totalmem); High and Critical both refuse spawns, Elevated and Normal allow them.

_Avoid_: pressure band, governor band, load level
