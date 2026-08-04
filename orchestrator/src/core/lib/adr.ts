import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ADR_DIR = 'docs/knowledge/decisions'

export const slugify = (title: string): string => {
  const ascii = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii.length > 0 ? ascii.slice(0, 60) : 'adr'
}

const padNumber = (n: number): string => String(n).padStart(4, '0')

export const adrDirIn = (root: string): string => resolve(root, ADR_DIR)

const ADR_FILENAME_RE = /^(\d{4})-[a-z0-9-]+\.md$/

export const nextAdrNumber = async (dir: string): Promise<number> => {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 1
    throw err
  }
  let max = 0
  for (const name of entries) {
    const match = ADR_FILENAME_RE.exec(name)
    if (!match) continue
    const n = Number.parseInt(match[1], 10)
    if (Number.isInteger(n) && n > max) max = n
  }
  return max + 1
}

export interface AdrWriteArgs {
  /** Worktree root the ADR is being written into. */
  worktreePath: string
  title: string
  body: string
}

export interface AdrWriteResult {
  filePath: string
  number: number
  slug: string
}

export const writeAdrInWorktree = async (
  args: AdrWriteArgs,
): Promise<AdrWriteResult> => {
  const dir = adrDirIn(args.worktreePath)
  await mkdir(dir, { recursive: true })
  const number = await nextAdrNumber(dir)
  const slug = slugify(args.title)
  const filename = `${padNumber(number)}-${slug}.md`
  const filePath = resolve(dir, filename)
  const body = args.body.trim()
  const content = body.length > 0
    ? `# ${args.title}\n\n${body}\n`
    : `# ${args.title}\n`
  await writeFile(filePath, content, 'utf8')
  return { filePath, number, slug }
}
