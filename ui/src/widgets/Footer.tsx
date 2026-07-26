import { useFrameworkUpdate } from '@/entities/frameworkUpdate/useFrameworkUpdate'

const Hint = ({ k, label }: { k: string; label: string }) => (
  <span className="flex items-center gap-1">
    <kbd className="font-mono text-[11px] font-semibold text-highlight">{k}</kbd>
    <span className="text-[11px] text-muted-foreground">{label}</span>
  </span>
)

export const Footer = () => {
  // Read the INSTALLED framework version from the same source the update banner
  // uses. This was hardcoded to "v0.1.0" — the ui package's own version — while
  // the banner reported the orchestrator's (v0.1.1), so one screen showed two
  // different "mars versions" and the footer could never stay correct.
  const { update } = useFrameworkUpdate()

  return (
    <footer className="flex h-8 items-center justify-between border-t border-border bg-background px-6">
      <div className="flex items-center gap-3.5">
        <Hint k="1-9" label="jump to task" />
        <span className="text-[11px] text-muted-foreground">·</span>
        <Hint k="t" label="triage" />
        <span className="text-[11px] text-muted-foreground">·</span>
        <Hint k="?" label="help" />
      </div>
      <span className="font-mono text-[11px] text-muted-foreground">
        {update === null ? '' : `mars v${update.installed}`}
      </span>
    </footer>
  )
}
