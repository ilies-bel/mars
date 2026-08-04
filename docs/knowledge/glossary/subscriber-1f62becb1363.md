# Subscriber

A code-declared, named consumer of the Outbox with a durable cursor, a handler, and a bootstrap mode (replay or tail). One Subscriber's cursor is independent of every other's.

_Avoid_: listener, consumer, handler, bus listener
