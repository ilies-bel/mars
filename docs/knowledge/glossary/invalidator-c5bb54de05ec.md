# Invalidator

A declaration attached to an inbox item at raise-time stating which bus events close it and how to match them against the event payload. The inbox engine evaluates invalidators centrally; raisers commit up front to what closes their item.

_Avoid_: auto-resolver, inbox-closer, close-rule
