import {
  addProposalUserStory,
  createProposal,
  promoteProposal,
  type Proposal,
} from '../proposals'
import { appendMessage, getThread, setThreadPosture } from '../lib/chat-store'

/** Promote a settled grill transcript to a PRD-ready proposal. */
export const promoteProposalFromThread = async (threadId: string): Promise<Proposal> => {
  const threadData = await getThread(threadId)
  if (!threadData) throw new Error(`chat thread ${threadId} not found`)
  if (threadData.thread.posture !== 'grill') {
    throw new Error(`chat thread ${threadId} is not in grill posture`)
  }

  const operatorMessages = threadData.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim())
    .filter((message) => message.length > 0)
  const assistantMessages = threadData.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.trim())
    .filter((message) => message.length > 0)
  const transcript = threadData.messages
    .map((message) => `${message.role === 'user' ? 'Operator' : 'Mars'}: ${message.content.trim()}`)
    .filter((message) => !message.endsWith(': '))
    .join('\n\n')
  const glossaryRefs: string[] = []
  const adrRefs: string[] = []
  for (const message of threadData.messages) {
    if (!Array.isArray(message.segments)) continue
    for (const segment of message.segments) {
      if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) continue
      const ref = segment as Record<string, unknown>
      if (ref.type === 'glossary_ref' && typeof ref.ref === 'string' && !glossaryRefs.includes(ref.ref)) {
        glossaryRefs.push(ref.ref)
      }
      if (ref.type === 'adr_ref' && typeof ref.ref === 'string' && !adrRefs.includes(ref.ref)) {
        adrRefs.push(ref.ref)
      }
    }
  }

  const title = threadData.thread.title.trim() || operatorMessages[0] || 'Promoted grill conversation'
  const proposal = await createProposal(title, {
    problem: `Problem\n\n${operatorMessages.join('\n\n') || transcript || 'The settled grill did not retain an explicit problem statement.'}`,
    solution: `Solution\n\n${assistantMessages.join('\n\n') || transcript || 'The settled grill did not retain an explicit solution statement.'}`,
    outOfScope: 'Out of scope\n\nNo additional scope was recorded in this settled grill.',
    notes: [
      'Notes',
      transcript || 'No transcript messages were recorded.',
      `Glossary mutations: ${glossaryRefs.length > 0 ? glossaryRefs.join(', ') : 'none recorded'}.`,
      `ADR mutations: ${adrRefs.length > 0 ? adrRefs.join(', ') : 'none recorded'}.`,
    ].join('\n\n'),
  })
  await addProposalUserStory(
    proposal.id,
    `As an operator, I want ${title.toLowerCase()} so that the settled grill becomes an actionable PRD.`,
  )
  const promoted = await promoteProposal(proposal.id)
  await setThreadPosture(threadId, 'triage')
  await appendMessage(
    threadId,
    'assistant',
    `System: I promoted this grill as proposal ${promoted.id}.`,
    [{ type: 'system', message: `Promoted proposal ${promoted.id}.` }],
  )
  return promoted
}
