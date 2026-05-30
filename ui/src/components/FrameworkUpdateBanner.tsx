import { useState } from 'react'
import { useFrameworkUpdate } from '@/entities/frameworkUpdate/useFrameworkUpdate'

const STORAGE_KEY = 'mars-update-dismissed'

/**
 * Pure decision function — testable without browser APIs.
 *
 * Returns true when the banner should be shown: an update is available AND the
 * user has not yet dismissed this specific `latest` version.
 */
export const shouldShowBanner = (
  available: boolean,
  latest: string,
  dismissedVersion: string | null,
): boolean => available && dismissedVersion !== latest

interface BannerInnerProps {
  installed: string
  latest: string
  releaseUrl: string | null
  onDismiss: () => void
}

/**
 * Pure display component — testable with renderToStaticMarkup.
 * Rendered by FrameworkUpdateBanner when an update is available and not dismissed.
 */
export const FrameworkUpdateBannerInner = ({
  installed,
  latest,
  releaseUrl,
  onDismiss,
}: BannerInnerProps) => (
  <div
    role="banner"
    className="flex items-center justify-between gap-3 bg-flame/10 px-4 py-2 text-sm text-fg"
  >
    <span>
      Mars v{latest} available (you&apos;re on v{installed})
    </span>
    <div className="flex shrink-0 items-center gap-2">
      {releaseUrl ? (
        <a
          href={releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-flame"
        >
          Release notes
        </a>
      ) : null}
      {/*
       * TODO: Wire up the self-update action once the self-update task lands.
       * The daemon endpoint (POST /view/framework-update/apply) and the
       * ui/server/index.ts proxy route need to be added by that task.
       */}
      <button
        type="button"
        disabled
        className="cursor-not-allowed rounded px-2 py-0.5 opacity-40 ring-1 ring-iron/40"
        title="Self-update not yet implemented — see self-update task"
      >
        Update now
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss update banner"
        className="flex h-5 w-5 items-center justify-center rounded hover:bg-iron/20"
      >
        ×
      </button>
    </div>
  </div>
)

/**
 * Dismissable top banner that appears when a Mars framework update is available.
 *
 * - Renders only when `available === true` from the daemon's
 *   `/view/framework-update` endpoint.
 * - Dismissal is keyed to the `latest` version string: dismissing v1.2.0 will
 *   not suppress a future v1.3.0 banner.
 * - The "Update now" button is present but inert — its action is wired by the
 *   self-update task (see TODO in FrameworkUpdateBannerInner).
 */
export const FrameworkUpdateBanner = () => {
  const { update } = useFrameworkUpdate()
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    } catch {
      return null
    }
  })

  if (!update || !shouldShowBanner(update.available, update.latest, dismissedVersion)) {
    return null
  }

  return (
    <FrameworkUpdateBannerInner
      installed={update.installed}
      latest={update.latest}
      releaseUrl={update.releaseUrl}
      onDismiss={() => {
        try {
          localStorage.setItem(STORAGE_KEY, update.latest)
        } catch {
          // ignore — SSR or private-browsing storage failure
        }
        setDismissedVersion(update.latest)
      }}
    />
  )
}
