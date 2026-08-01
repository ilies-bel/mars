import type { DbClient } from '../../core/lib/db.js'
import { postConversationNotice } from '../../core/lib/conversation-delivery.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { registerSubscriberName } from '../registry.js'

/** Durable consumer for recipe autoruns in the continuous conversation. */
export const RECIPE_CONVERSATION_NOTICE_SUBSCRIBER = 'recipe-conversation-notice'
registerSubscriberName(RECIPE_CONVERSATION_NOTICE_SUBSCRIBER)

export async function ensureRecipeConversationNoticeSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, RECIPE_CONVERSATION_NOTICE_SUBSCRIBER, { replay: false })
}

/** Post every newly auto-applied recipe as a zero-token, Main-scope Notice. */
export async function drainRecipeConversationNotices(
  client: DbClient,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: RECIPE_CONVERSATION_NOTICE_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'recipe-autorun') return false
      const payload = event.payload as {
        recipeId: string
        failureKind: string
        targetTaskId: string
      }
      await postConversationNotice({
        kind: 'recipe.auto-applied',
        payload,
        priority: 'routine',
      })
      return true
    },
  })
}
