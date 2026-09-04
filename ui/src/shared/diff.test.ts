/**
 * Tests for the diff.ts hunk splitter.
 *
 * Exercises parseDiff and diffFileCounts against representative unified-diff
 * payloads: single-file, multi-file, deletions, and binary files.
 */
import { describe, expect, it } from 'vitest'
import { parseDiff, diffFileCounts } from './diff'

const SIMPLE_PATCH = `\
diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,5 @@
 const x = 1
+const y = 2
+const z = 3
 const w = 4
 const v = 5
`

const MULTI_FILE_PATCH = `\
diff --git a/src/a.ts b/src/a.ts
index aaa..bbb 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 keep
+added
 keep2
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 000..ccc
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+line1
+line2
`

const DELETE_PATCH = `\
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index abc..000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-removed1
-removed2
`

const BINARY_PATCH = `\
diff --git a/assets/image.png b/assets/image.png
index abc..def 100644
Binary files a/assets/image.png and b/assets/image.png differ
`

describe('parseDiff', () => {
  it('parses a single-file patch into one DiffFile with one hunk', () => {
    const files = parseDiff(SIMPLE_PATCH)
    expect(files).toHaveLength(1)
    const f = files[0]!
    expect(f.path).toBe('src/foo.ts')
    expect(f.isBinary).toBe(false)
    expect(f.hunks).toHaveLength(1)

    const hunk = f.hunks[0]!
    expect(hunk.header).toContain('@@ -1,3 +1,5 @@')

    const added = hunk.lines.filter((l) => l.kind === 'added')
    const removed = hunk.lines.filter((l) => l.kind === 'removed')
    const context = hunk.lines.filter((l) => l.kind === 'context')
    expect(added).toHaveLength(2)
    expect(removed).toHaveLength(0)
    expect(context.length).toBeGreaterThan(0)
    expect(added[0]!.text).toBe('const y = 2')
    expect(added[1]!.text).toBe('const z = 3')
  })

  it('parses a multi-file patch into two DiffFiles', () => {
    const files = parseDiff(MULTI_FILE_PATCH)
    expect(files).toHaveLength(2)

    const a = files[0]!
    expect(a.path).toBe('src/a.ts')
    expect(a.hunks).toHaveLength(1)
    expect(a.hunks[0]!.lines.filter((l) => l.kind === 'added')).toHaveLength(1)

    const b = files[1]!
    expect(b.path).toBe('src/b.ts')
    expect(b.hunks).toHaveLength(1)
    expect(b.hunks[0]!.lines.filter((l) => l.kind === 'added')).toHaveLength(2)
  })

  it('parses a deletion patch — path comes from --- a/ line', () => {
    const files = parseDiff(DELETE_PATCH)
    expect(files).toHaveLength(1)
    const f = files[0]!
    expect(f.path).toBe('src/gone.ts')
    const hunk = f.hunks[0]!
    const removed = hunk.lines.filter((l) => l.kind === 'removed')
    expect(removed).toHaveLength(2)
    expect(removed[0]!.text).toBe('removed1')
  })

  it('marks binary files with isBinary=true and no hunks', () => {
    const files = parseDiff(BINARY_PATCH)
    expect(files).toHaveLength(1)
    expect(files[0]!.isBinary).toBe(true)
    expect(files[0]!.hunks).toHaveLength(0)
  })

  it('returns an empty array for an empty string', () => {
    expect(parseDiff('')).toHaveLength(0)
  })
})

describe('diffFileCounts', () => {
  it('counts additions and deletions across hunks', () => {
    const [file] = parseDiff(SIMPLE_PATCH)
    const { additions, deletions } = diffFileCounts(file!)
    expect(additions).toBe(2)
    expect(deletions).toBe(0)
  })

  it('returns zeros for a binary file', () => {
    const [file] = parseDiff(BINARY_PATCH)
    expect(diffFileCounts(file!)).toEqual({ additions: 0, deletions: 0 })
  })

  it('sums across multiple hunks in one file', () => {
    const twoHunkPatch = `\
diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,3 @@
 keep
+added1
 keep2
@@ -10,2 +11,1 @@
 other
-removed1
`
    const [file] = parseDiff(twoHunkPatch)
    const { additions, deletions } = diffFileCounts(file!)
    expect(additions).toBe(1)
    expect(deletions).toBe(1)
  })
})
