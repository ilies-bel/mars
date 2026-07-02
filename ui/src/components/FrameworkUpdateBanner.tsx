import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useFrameworkUpdate } from '@/entities/frameworkUpdate/useFrameworkUpdate'
import { triggerSelfUpdate } from '@/shared/api'

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
  selfUpdatable: boolean
  onUpdate: () => void
  isUpdating: boolean
  updateError: string | null
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
  selfUpdatable,
  onUpdate,
  isUpdating,
  updateError,
  onDismiss,
}: BannerInnerProps) => (
  <div
    role="region"
    aria-label="Framework update notification"
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
      {updateError ? (
        <span className="text-xs text-error">
          Couldn&apos;t start the update — try again, or update manually.
          {import.meta.env.DEV && (
            <span className="ml-1 opacity-60">({updateError})</span>
          )}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onUpdate}
        disabled={!selfUpdatable || isUpdating}
        title={
          !selfUpdatable
            ? 'dev install — git pull & rebuild'
            : isUpdating
              ? 'Update in progress…'
              : undefined
        }
        className={
          !selfUpdatable || isUpdating
            ? 'cursor-not-allowed rounded px-2 py-0.5 opacity-40 ring-1 ring-iron/40'
            : 'rounded px-2 py-0.5 ring-1 ring-iron/40 hover:bg-iron/10'
        }
      >
        {isUpdating ? 'Updating…' : 'Update now'}
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
 * - The "Update now" button triggers `POST /actions/self-update` on the daemon
 *   (proxied via `/api/actions`). It is disabled with a hint on dev installs
 *   where `selfUpdatable` is false.
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

  const mutation = useMutation({ mutationFn: triggerSelfUpdate })

  if (!update || !shouldShowBanner(update.available, update.latest, dismissedVersion)) {
    return null
  }

  return (
    <FrameworkUpdateBannerInner
      installed={update.installed}
      latest={update.latest}
      releaseUrl={update.releaseUrl}
      selfUpdatable={update.selfUpdatable}
      onUpdate={() => mutation.mutate()}
      isUpdating={mutation.isPending}
      updateError={mutation.error ? (mutation.error as Error).message : null}
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
