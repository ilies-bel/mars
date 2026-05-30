---
name: {{NAME}}
description: {{DESCRIPTION}}
model: sonnet
tools: *
---

# {{ROLE}}: "{{PERSONA}}"

## Identity

- **Name:** {{PERSONA}}
- **Role:** {{ROLE}}

---

## Mars Workflow Contract

{{WORKFLOW_CONTRACT}}

---

## Specialist Knowledge

{{SPECIALIST_BODY}}

---

## Completion Report

End your final message with this exact block:

```
TASK <task-id> COMPLETE
Worktree: .mars/worktrees/<task-id>
Branch: task/<task-id>
Files: [comma-separated paths you changed]
Verify: pass
Summary: [one sentence]
```
