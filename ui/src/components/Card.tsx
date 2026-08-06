/**
 * Card component — the surface through which a Subject opens or closes.
 *
 * Renders the Card's body text, its autonomy level badge, and an inline
 * Silence button. Clicking Silence POSTs to /api/levers/:producer_key with
 * level='off', which suppresses future Cards from the same source until the
 * operator re-enables the lever.
 */

import { useState } from 'react'
import { silenceLever } from '@/shared/api'

export interface CardData {
  id: string
  autonomy_level: 'off' | 'ask' | 'tell'
  producer_key: string
  body: string
  created_at: number
}

interface Props {
  card: CardData
  /** Called after the lever is successfully silenced so the parent can hide / re-query. */
  onSilenced?: (producerKey: string) => void
}

export function Card({ card, onSilenced }: Props) {
  const [silencing, setSilencing] = useState(false)
  const [silenced, setSilenced] = useState(false)

  const handleSilence = async () => {
    if (silencing || silenced) return
    setSilencing(true)
    try {
      await silenceLever(card.producer_key)
      setSilenced(true)
      onSilenced?.(card.producer_key)
    } finally {
      setSilencing(false)
    }
  }

  return (
    <article
      aria-label="Card"
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{card.producer_key}</span>
        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
          {card.autonomy_level}
        </span>
      </div>
      <p className="text-[14px] leading-snug text-foreground">{card.body}</p>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={silencing || silenced}
          onClick={handleSilence}
          className="rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Silence ${card.producer_key}`}
        >
          {silenced ? 'Silenced' : silencing ? 'Silencing…' : 'Silence'}
        </button>
      </div>
    </article>
  )
}
