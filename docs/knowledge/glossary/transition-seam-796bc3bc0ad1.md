# Transition seam

The single TaskStore entry point through which every task.status write must pass, validating the from-to edge against the legal transition map.

_Avoid_: status setter, updateTask, transition function
