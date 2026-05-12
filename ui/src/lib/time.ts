export const relativeTime = (iso: string, now = Date.now()): string => {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

const MS_PER_MIN = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
const MS_PER_WEEK = 7 * MS_PER_DAY
const MS_PER_MONTH = 30 * MS_PER_DAY
const MS_PER_YEAR = 365 * MS_PER_DAY

export const formatRelativeAge = (ms: number): string => {
  const v = Math.max(0, ms)
  if (v < MS_PER_MIN) return 'just now'
  if (v < MS_PER_HOUR) return `${Math.floor(v / MS_PER_MIN)}m`
  if (v < MS_PER_DAY) return `${Math.floor(v / MS_PER_HOUR)}h`
  if (v < 7 * MS_PER_DAY) return `${Math.floor(v / MS_PER_DAY)}d`
  if (v < 5 * MS_PER_WEEK) return `${Math.floor(v / MS_PER_WEEK)}w`
  if (v < MS_PER_YEAR) return `${Math.floor(v / MS_PER_MONTH)}mo`
  return `${Math.floor(v / MS_PER_YEAR)}y`
}

export const formatRelativeAgeFromHours = (hours: number): string =>
  formatRelativeAge(hours * MS_PER_HOUR)
