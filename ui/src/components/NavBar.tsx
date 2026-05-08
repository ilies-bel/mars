interface NavBarProps {
  hash: string
}

const linkClass = (active: boolean): string =>
  [
    'rounded px-2 py-1 font-mono text-[11px] uppercase tracking-wide',
    active ? 'bg-iron/30 text-fg' : 'text-iron hover:text-fg',
  ].join(' ')

export const NavBar = ({ hash }: NavBarProps) => {
  const onTodo = hash.startsWith('#/todo')
  return (
    <nav className="flex items-center gap-2 border-b border-iron/30 bg-bg px-4 py-1.5">
      <a className={linkClass(!onTodo)} href="#/">
        Kanban
      </a>
      <a className={linkClass(onTodo)} href="#/todo">
        Todo
      </a>
    </nav>
  )
}
