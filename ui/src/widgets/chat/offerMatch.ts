import type { ChatConversationEntry, PreloadedResponse } from '@/shared/schemas'

/**
 * Matching free text against the Offer set.
 *
 * Chips are an affordance over the Offer set, not the only way in — an
 * operator who types "stop doing that" means the same thing as one who taps
 * the chip, and Mars answering a new Subject instead would be obtuse.
 *
 * The bar for a match is deliberately high. Guessing wrong here silences a
 * behaviour the operator never asked to silence, and the failure is silent:
 * they would only notice weeks later when Mars stopped speaking up. So an
 * ambiguous phrase resolves to nothing and falls through to the composer's
 * normal behaviour, which is always recoverable.
 */

export interface OpenOffer {
  messageId: string
  response: PreloadedResponse
}

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Phrases that stand for a target type regardless of how the chip was worded.
 * Only phrases whose whole meaning *is* the action — nothing that could also
 * open a topic. "install codegraph" is a request; "install it" is an answer.
 */
const ALIASES: Partial<Record<PreloadedResponse['target']['type'], readonly string[]>> = {
  ack: ['noted', 'ok', 'okay', 'k', 'got it', 'sure', 'fine', 'thanks', 'ack', 'acknowledged'],
  lever: [
    'stop',
    'stop it',
    'stop that',
    'stop doing that',
    'stop doing this',
    'dont do that',
    'dont do that again',
    'dont ask again',
    'dont ask me again',
    'never ask again',
    'never again',
  ],
}

/**
 * The Offer sets standing open in the feed.
 *
 * Only the most recent Notice that still carries an unresolved Offer set
 * counts. Older ones have scrolled out of the conversation's attention, and
 * matching against them would let a phrase typed today answer a question from
 * last week.
 */
export const collectOpenOffers = (entries: readonly ChatConversationEntry[]): OpenOffer[] => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.resolution === 'resolved') continue
    const offers: OpenOffer[] = []
    for (const segment of entry.segments) {
      if (
        typeof segment !== 'object' || segment === null ||
        (segment as { type?: unknown }).type !== 'preloaded_responses' ||
        !Array.isArray((segment as { responses?: unknown }).responses)
      ) continue
      for (const response of (segment as { responses: PreloadedResponse[] }).responses) {
        offers.push({ messageId: entry.id, response })
      }
    }
    if (offers.length > 0) return offers
  }
  return []
}

/**
 * Resolve free text to exactly one open offer, or to nothing.
 *
 * Returns `null` whenever two offers fit — an operator typing "no" against a
 * card offering both "Don't ask again" and "Later" has not said which.
 */
export const matchOffer = (text: string, offers: readonly OpenOffer[]): OpenOffer | null => {
  const typed = normalize(text)
  if (typed === '') return null

  const byLabel = offers.filter((offer) => normalize(offer.response.label) === typed)
  if (byLabel.length === 1) return byLabel[0] ?? null
  if (byLabel.length > 1) return null

  const byAlias = offers.filter((offer) =>
    (ALIASES[offer.response.target.type] ?? []).includes(typed),
  )
  return byAlias.length === 1 ? byAlias[0] ?? null : null
}
