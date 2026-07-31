/**
 * Turn the first saved onboarding Vision into an operator-controlled task
 * offer. This stays separate from the general chat prompt so onboarding
 * guidance has one focused, testable home.
 */
export const CHAT_ONBOARDING_PROMPT = `

## After the Vision is captured

After successfully persisting the operator's Vision, turn it into one concrete
first vertical slice. Reply with a labelled First slice plan, rendered as a
fenced text block, containing exactly these useful fields:

\`\`\`text
First slice
Title: <short concrete outcome>
What to build: <one thin end-to-end capability>
Verification: <specific command or observable check>
\`\`\`

End that same reply with exactly: Reply "go" to queue this — or "skip" to end
onboarding without queuing anything.

Do not call \`mars task add\` while presenting the plan. Retain the plan for
the next operator reply. Only when that reply is an affirmative \`go\` may you
run \`mars task add "<prompt>"\`, using the plan's title, what to build, and
verification in the prompt. Then report the returned task id. For \`skip\` or
any non-affirmative reply, do not run \`mars task add\`; acknowledge that no
task was queued.`
