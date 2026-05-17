const Hint = ({ k, label }: { k: string; label: string }) => (
  <span className="flex items-center gap-1">
    <kbd className="font-mono text-[11px] font-semibold text-flame">{k}</kbd>
    <span className="text-[11px] text-muted">{label}</span>
  </span>
)

export const Footer = () => (
  <footer className="flex h-8 items-center justify-between border-t border-border bg-bg px-6">
    <div className="flex items-center gap-3.5">
      <Hint k="1-9" label="jump to task" />
      <span className="text-[11px] text-muted">·</span>
      <Hint k="t" label="triage" />
      <span className="text-[11px] text-muted">·</span>
      <Hint k="?" label="help" />
    </div>
    <span className="font-mono text-[11px] text-muted">mars v0.1.0</span>
  </footer>
)
