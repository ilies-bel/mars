# Notifier is a best-effort Outbox Subscriber that never stalls its cursor

The Notifier delivers native OS desktop notifications when an Alert lands. Unlike every other Subscriber (ADR-0032), it swallows all delivery errors and always advances its cursor — it never stalls and never raises a subscriber.stalled action-queue item. Rationale: a missed banner is routine (screen locked, headless host, DND) and must not wedge the notification pipeline or, worse, raise an alert that the Notifier would itself try to deliver (feedback loop). Delivery is a ping, not a guarantee.
