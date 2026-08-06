import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { highlightGlossary } from '@/shared/highlightGlossary'
import type { GlossaryTerm } from '@/shared/schemas'

interface GlossaryHighlighterProps {
  text: string
  terms: GlossaryTerm[]
}

export function GlossaryHighlighter({ text, terms }: GlossaryHighlighterProps) {
  const segments = highlightGlossary(text, terms)

  if (segments.length === 1 && segments[0].kind === 'text') return segments[0].value

  return (
    <span>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return segment.value

        return (
          <Tooltip key={`${segment.term.term}-${index}`}>
            <TooltipTrigger asChild>
              <span
                className="glossary-term-highlight rounded-sm bg-primary/10 px-0.5 text-foreground underline decoration-primary/30 decoration-dotted underline-offset-2 transition-colors hover:bg-primary/20"
                data-term={segment.term.term}
              >
                {segment.value}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              <p className="font-mono text-[10px] font-medium">{segment.term.term}</p>
              <p className="mt-0.5 max-w-64 text-[11px] leading-snug">{segment.term.definition}</p>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </span>
  )
}
