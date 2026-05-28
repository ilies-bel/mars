/**
 * Recovery-recipe catalog: markdown prompt templates with strict YAML
 * frontmatter (`name`, `description`, `tools`). A recipe is the prompt
 * body a `claude -p` recovery worker is dispatched with; the frontmatter
 * gates which Claude Code tools that worker is allowed to call.
 *
 * The catalog is loaded once per daemon process. Resolution rules mirror
 * the failure-reason catalog from slice D:
 *
 *  1. Built-in seed recipes live under `src/mastra/recipes/built-in/*.md`
 *     in this repo. They are resolved off `import.meta.url` so the
 *     loader keeps working when run from a worktree with an unusual cwd.
 *  2. `.mars/recipes/*.md` files override per-name. A file whose `name`
 *     matches a built-in replaces that built-in wholesale (no merge);
 *     a file with a new `name` adds to the catalog.
 *  3. Malformed frontmatter / Zod-rejected files / unknown tool names
 *     are logged once and skipped; other files keep loading.
 *  4. No hot-reload: edits land on `mars daemon reload`/restart.
 *
 * Tools are a flat closed-allowlist of Claude Code tool names. We do NOT
 * support per-tool subcommand scoping (e.g. `Bash: [git status]`) — the
 * `--allowed-tools` flag enforces name-level access only, and pretending
 * otherwise would be theatre. Subcommand constraints belong in the
 * prompt body.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'
import { z } from 'zod'

/**
 * Closed allowlist of Claude Code tool names. Recipes may only reference
 * tools listed here; unknown names are a load-time error. Extend this
 * const in code when Claude Code ships a new tool — out of scope for the
 * recipe author.
 */
export const VALID_RECIPE_TOOL_NAMES = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
] as const

export type RecipeToolName = (typeof VALID_RECIPE_TOOL_NAMES)[number]

/** Where a resolved recipe came from. */
export type RecipeSource = 'built-in' | 'override'

/**
 * A resolved recipe. `prompt` is the markdown body verbatim with the
 * frontmatter block stripped; it is fed straight to `claude -p`.
 */
export interface Recipe {
  /** Stable identifier — must match the filename (without `.md`). */
  name: string
  /** One-liner description; surfaces in inbox/UI listings. */
  description: string
  /** Claude Code tool allowlist enforced via `--allowed-tools`. */
  tools: readonly RecipeToolName[]
  /** Markdown body with frontmatter stripped — the literal prompt. */
  prompt: string
  /** `'built-in'` from the shipped seed, `'override'` from `.mars/recipes/`. */
  source: RecipeSource
}

/** Resolved catalog. */
export interface RecipeCatalog {
  /** Resolve a recipe by name, or `null` when unknown. */
  get: (name: string) => Recipe | null
  /** Every entry as a flat list (built-in + overrides merged). */
  list: () => readonly Recipe[]
}

/**
 * Zod schema for the frontmatter block. Required fields fail loud so a
 * malformed override is obvious in the daemon log. The tool-name allowlist
 * is enforced at the per-string level so the error message names the bad
 * tool, not just "invalid array".
 */
export const recipeFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: z
    .array(
      z.enum(VALID_RECIPE_TOOL_NAMES as unknown as [string, ...string[]]),
    )
    .min(1),
})

const RECIPES_DIRNAME = 'recipes'

/**
 * Resolve the consumer-owned override directory under a `.mars/` state
 * dir. Exported for tests and for `mars init` to write seed files into.
 */
export const recipesDir = (stateDir: string): string =>
  resolve(stateDir, RECIPES_DIRNAME)

/**
 * Resolve the built-in seed directory. Resolved off this module's own URL
 * so the path is correct whether the orchestrator is invoked from source
 * (`src/mastra/lib/recipes.ts`) or from a worktree where the process cwd
 * has shifted. The seed `.md` files sit alongside this file's `mastra/`
 * subtree as `mastra/recipes/built-in/*.md`.
 */
const BUILT_IN_RECIPES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'recipes',
  'built-in',
)

/** Split a markdown file into its frontmatter block and the body. */
const splitFrontmatter = (
  raw: string,
): { frontmatter: string; body: string } | null => {
  if (!raw.startsWith('---')) return null
  // Find the SECOND `---` line. The opening line is index 0 in the lines
  // array; we want the next line that is exactly `---`.
  const lines = raw.split('\n')
  if (lines[0]?.trim() !== '---') return null
  let closeIdx = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) return null
  const frontmatter = lines.slice(1, closeIdx).join('\n')
  const body = lines.slice(closeIdx + 1).join('\n')
  return { frontmatter, body }
}

/**
 * Parse a single recipe file. Returns the resolved recipe or `null` on any
 * load-time error, logging the reason via `onWarn`. `expectedName` is the
 * filename-derived name; the parsed frontmatter must match it.
 */
const parseRecipe = (
  abs: string,
  expectedName: string,
  source: RecipeSource,
  onWarn: (msg: string) => void,
): Recipe | null => {
  let raw: string
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (err) {
    onWarn(
      `[recipes] failed to read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
  const split = splitFrontmatter(raw)
  if (!split) {
    onWarn(
      `[recipes] ${abs}: missing frontmatter block (file must start with --- and contain a closing ---); skipping`,
    )
    return null
  }
  let parsed: unknown
  try {
    parsed = parseYaml(split.frontmatter)
  } catch (err) {
    onWarn(
      `[recipes] ${abs}: YAML frontmatter parse failed (${err instanceof Error ? err.message : String(err)}); skipping`,
    )
    return null
  }
  const result = recipeFrontmatterSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    onWarn(
      `[recipes] ${abs}: schema rejected (${issues}); valid tools are [${VALID_RECIPE_TOOL_NAMES.join(', ')}]; skipping`,
    )
    return null
  }
  if (result.data.name !== expectedName) {
    onWarn(
      `[recipes] ${abs}: frontmatter name '${result.data.name}' does not match filename '${expectedName}.md'; skipping`,
    )
    return null
  }
  // Trim a single leading newline left by the split — the body is
  // everything AFTER the closing `---` line, which typically starts with
  // an empty line authors don't think of as content.
  const prompt = split.body.replace(/^\n/, '')
  return {
    name: result.data.name,
    description: result.data.description,
    tools: result.data.tools as readonly RecipeToolName[],
    prompt,
    source,
  }
}

/** Build a catalog instance over a (name → recipe) map. */
const buildCatalog = (byName: ReadonlyMap<string, Recipe>): RecipeCatalog => ({
  get: (name) => byName.get(name) ?? null,
  list: () => Array.from(byName.values()),
})

/** Scan a directory for `*.md` files and return their absolute paths. */
const listMarkdownFiles = (
  dir: string,
  onWarn: (msg: string) => void,
): string[] => {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => /\.md$/i.test(f))
      .sort()
      .map((f) => resolve(dir, f))
  } catch (err) {
    onWarn(
      `[recipes] failed to read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }
}

/** Recover the filename-derived name (without `.md`) from an absolute path. */
const nameFromPath = (abs: string): string => {
  const base = abs.split('/').pop() ?? abs
  return base.replace(/\.md$/i, '')
}

/**
 * Load the catalog. Built-ins are merged first; per-file overrides from
 * `<stateDir>/recipes/` take precedence wholesale (no field-level merge).
 * Malformed files are logged via `onWarn` (defaults to `console.warn`)
 * and skipped — one bad file never strands the rest.
 */
export const loadRecipeCatalog = async (
  stateDir: string,
  opts: { onWarn?: (msg: string) => void } = {},
): Promise<RecipeCatalog> => {
  const onWarn = opts.onWarn ?? ((msg) => console.warn(msg))

  const merged = new Map<string, Recipe>()

  for (const abs of listMarkdownFiles(BUILT_IN_RECIPES_DIR, onWarn)) {
    const expected = nameFromPath(abs)
    const recipe = parseRecipe(abs, expected, 'built-in', onWarn)
    if (recipe) merged.set(recipe.name, recipe)
  }

  for (const abs of listMarkdownFiles(recipesDir(stateDir), onWarn)) {
    const expected = nameFromPath(abs)
    const recipe = parseRecipe(abs, expected, 'override', onWarn)
    if (recipe) merged.set(recipe.name, recipe)
  }

  return buildCatalog(merged)
}

/**
 * Read the raw body of every shipped built-in recipe. Used by the `mars
 * init` seed writer — it copies the .md verbatim into `.mars/recipes/`
 * with no-overwrite semantics so a consumer can edit freely afterwards.
 * Returns one entry per shipped file regardless of whether the file
 * parses cleanly; the seed writer trusts the binary's own bundled files.
 */
export interface BuiltInRecipeFile {
  /** Recipe name (filename without `.md`). */
  name: string
  /** Raw file contents — frontmatter + body, exact bytes. */
  contents: string
}

export const listBuiltInRecipeFiles = (): readonly BuiltInRecipeFile[] => {
  if (!existsSync(BUILT_IN_RECIPES_DIR)) return []
  const files = readdirSync(BUILT_IN_RECIPES_DIR)
    .filter((f) => /\.md$/i.test(f))
    .sort()
  return files.map((f) => ({
    name: f.replace(/\.md$/i, ''),
    contents: readFileSync(resolve(BUILT_IN_RECIPES_DIR, f), 'utf8'),
  }))
}
