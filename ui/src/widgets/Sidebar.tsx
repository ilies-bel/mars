interface Props {
  tasksCount: number
  triageCount: number
  connected: boolean
}

export const Sidebar = ({ tasksCount, triageCount, connected }: Props) => (
  <aside className="flex h-full w-[200px] flex-col gap-1.5 border-r border-border bg-bg px-3 py-4">
    <div className="flex items-center gap-2 px-1 pb-3">
      <div className="h-3.5 w-3.5 rotate-45 bg-flame" />
      <span className="text-[14px] font-bold text-fg">mars</span>
    </div>

    <div className="px-2 text-[10px] font-semibold tracking-wider text-muted">
      WORKSPACE
    </div>

    <NavItem
      label="Triage Queue"
      icon="⚑"
      badge={triageCount}
      badgeKind="iron"
      active
    />
    <NavItem label="Tasks" icon="◉" badge={tasksCount} badgeKind="muted" />

    <div className="flex-1" />

    <div className="flex items-center gap-1.5 px-1 py-1.5">
      <span
        className={`h-1.5 w-1.5 rounded-full bg-flame ${connected ? 'animate-mars-pulse' : 'opacity-30'}`}
      />
      <span className="font-mono text-[11px] font-medium text-fg">
        {connected ? 'live' : 'offline'}
      </span>
      <span className="ml-auto font-mono text-[10px] text-muted">v0.1.0</span>
    </div>
  </aside>
)

interface NavItemProps {
  label: string
  icon: string
  badge: number
  badgeKind: 'iron' | 'muted'
  active?: boolean
}

const NavItem = ({ label, icon, badge, badgeKind, active }: NavItemProps) => {
  const base =
    'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px]'
  const activeCls = active
    ? 'bg-flame/10 font-semibold text-fg'
    : 'font-medium text-fg'
  const badgeCls =
    badgeKind === 'iron'
      ? 'bg-iron text-white'
      : 'text-muted'
  return (
    <div className={`${base} ${activeCls}`}>
      <span className={`text-[12px] ${active ? 'text-flame' : 'text-muted'}`}>
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {badgeKind === 'iron' ? (
        <span className={`rounded-full px-1.5 py-px font-mono text-[10px] font-bold ${badgeCls}`}>
          {badge}
        </span>
      ) : (
        <span className="font-mono text-[11px] text-muted">{badge}</span>
      )}
    </div>
  )
}
