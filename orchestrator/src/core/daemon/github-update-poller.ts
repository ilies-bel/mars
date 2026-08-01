import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { MARS_VERSION } from '../../version'
import { classifyInstallRoute, type InstallRoute } from './install-route'

/**
 * How often the daemon polls for a new GitHub release. Six hours balances
 * freshness with API rate-limit headroom (unauthenticated: 60 req/h per IP).
 */
export const UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Shape written to .mars/update.json by a successful poll. */
export interface FrameworkUpdateCache {
  installed: string
  latest: string
  available: boolean
  /** ISO-8601 timestamp of the successful check. */
  checkedAt: string
  releaseUrl: string
  /**
   * Whether the running daemon can self-update by replacing its own binary.
   * `true` only when `available` is true AND the install is a prod binary
   * (not a dev tsx wrapper). Written by the poller so the UI can disable the
   * "Update" button without a separate RPC round-trip.
   */
  selfUpdatable: boolean
}

/**
 * Compare two semver-ish version strings and return `true` when `latest` is
 * strictly newer than `installed`.
 *
 * Rules:
 *   - Numeric major.minor.patch comparison; first differing segment decides.
 *   - Any pre-release suffix (anything after the first `-`) makes a version
 *     *lower* than its release counterpart, so `1.0.0-alpha` < `1.0.0`.
 *   - Returns `false` for equal versions or when either string is unparseable.
 */
export const isNewerVersion = (latest: string, installed: string): boolean => {
  const parse = (
    v: string,
  ): { major: number; minor: number; patch: number; prerelease: string | null } | null => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/)
    if (!m) return null
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      prerelease: m[4] ?? null,
    }
  }

  const l = parse(latest)
  const i = parse(installed)
  if (!l || !i) return false

  if (l.major !== i.major) return l.major > i.major
  if (l.minor !== i.minor) return l.minor > i.minor
  if (l.patch !== i.patch) return l.patch > i.patch

  // Same numeric version: the release is newer than any of its pre-releases.
  // latest has no prerelease, installed does → latest is the "proper" release
  if (l.prerelease === null && i.prerelease !== null) return true
  return false
}

/**
 * Fetch the latest GitHub release for `ilies-bel/mars`, compare it to the
 * running `MARS_VERSION`, and write the result to `<marsDir>/update.json`.
 *
 * On **any** failure (network error, non-200 response, JSON parse error):
 *   - Calls `options.debug` with a descriptive message if provided.
 *   - Leaves any existing `<marsDir>/update.json` file untouched.
 *   - Never throws — the poll loop stays alive regardless.
 */
export const pollGithubRelease = async (
  marsDir: string,
  options?: {
    debug?: (msg: string) => void
    fetchFn?: typeof fetch
    installedVersion?: string
    installRoute?: InstallRoute
  },
): Promise<void> => {
  const debug = options?.debug ?? (() => {})
  const fetchFn = options?.fetchFn ?? fetch
  const installedVersion = options?.installedVersion ?? MARS_VERSION
  const installRoute = options?.installRoute ?? classifyInstallRoute()
  const cacheFile = resolve(marsDir, 'update.json')

  try {
    const res = await fetchFn(
      'https://api.github.com/repos/ilies-bel/mars/releases/latest',
      {
        headers: {
          'User-Agent': `mars-framework/${installedVersion}`,
          Accept: 'application/vnd.github+json',
        },
      },
    )

    if (!res.ok) {
      debug(
        `[github-update-poller] non-200 response: ${res.status} ${res.statusText}`,
      )
      return
    }

    const data = (await res.json()) as Record<string, unknown>
    const tagName = data.tag_name
    const htmlUrl = data.html_url

    if (typeof tagName !== 'string' || typeof htmlUrl !== 'string') {
      debug(
        `[github-update-poller] unexpected response shape: missing tag_name or html_url`,
      )
      return
    }

    const latest = tagName.startsWith('v') ? tagName.slice(1) : tagName
    const available = installRoute === 'prod' && isNewerVersion(latest, installedVersion)
    const selfUpdatable = available && installRoute === 'prod'

    const cache: FrameworkUpdateCache = {
      installed: installedVersion,
      latest,
      available,
      checkedAt: new Date().toISOString(),
      releaseUrl: htmlUrl,
      selfUpdatable,
    }

    await writeFile(cacheFile, JSON.stringify(cache, null, 2) + '\n', 'utf8')
    debug(
      `[github-update-poller] updated: installed=${installedVersion} latest=${latest} available=${available}`,
    )
  } catch (err) {
    debug(`[github-update-poller] poll failed: ${(err as Error).message}`)
  }
}
