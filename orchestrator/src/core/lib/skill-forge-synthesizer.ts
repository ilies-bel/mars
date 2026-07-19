import type { CrossArcLesson } from './skill-forge-detector'

/**
 * Turns a CrossArcLesson into a draft SKILL.md string that satisfies
 * the frontmatter contract enforced by skill-workflow-author.test.ts:
 * non-empty `name:` and `description:`, plus a body that names concrete
 * trigger phrases.
 */
export function synthesizeSkillMarkdown(lesson: CrossArcLesson): {
  name: string
  markdown: string
} {
  const name = slugify(lesson.title)

  const triggerList =
    lesson.triggerPhrases && lesson.triggerPhrases.length > 0
      ? lesson.triggerPhrases.join(', ')
      : lesson.title

  const description = `${lesson.summary} Use when the user mentions: ${triggerList}.`

  const body = lesson.body ?? lesson.summary

  const markdown = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${lesson.title}`,
    '',
    body,
  ].join('\n')

  return { name, markdown }
}

/** Convert an arbitrary title to a lowercase-kebab slug. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
