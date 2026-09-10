// ---------------------------------------------------------------------------
// Absolute date/time — one unambiguous format used everywhere in the UI.
//
// Numeric date formats like `01/08/2026` are ambiguous (1 Aug vs 8 Jan
// depending on the reader's locale). Every absolute-date rendering in the
// app routes through these helpers so there is exactly one format, spelled
// out with a month name so it can't be misread.
// ---------------------------------------------------------------------------

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Formats a valid `input` with `render`; falls back to '—' (empty) or the raw input (invalid). */
const withValidDate = (input: string | number, render: (d: Date) => string): string => {
  if (input === '') return '—'
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) return String(input)
  return render(d)
}

/** Absolute date + time, unambiguous: "17 Aug 2026, 15:50". */
export const formatAbsoluteDateTime = (input: string | number): string =>
  withValidDate(input, (d) =>
    `${d.getDate()} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  )

/** Absolute date only, unambiguous: "17 Aug 2026". */
export const formatAbsoluteDate = (input: string | number): string =>
  withValidDate(input, (d) => `${d.getDate()} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`)

/** Clock time only, 24h, for a transcript where the day is stated elsewhere: "15:50". */
export const formatClockTime = (input: string | number): string =>
  withValidDate(input, (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`)

/**
 * Calendar-day key in LOCAL time, for grouping a transcript into days.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that is UTC, so a message sent
 * at 01:30 local in UTC+2 would land under the previous day's separator while
 * its own clock time read 01:30.
 */
export const localDayKey = (input: string | number): string =>
  withValidDate(input, (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)

/** Compact date, no year, for space-constrained UI (e.g. chart axis labels): "17 Aug". */
export const formatShortDate = (input: string | number): string =>
  withValidDate(input, (d) => `${d.getDate()} ${MONTH_ABBR[d.getMonth()]}`)

export const relativeTime = (timestamp: string | number, now = Date.now()): string => {
  const t = new Date(timestamp).getTime()
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${formatRelativeAge(now - t)} ago`
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

export const formatDuration = (ms: number): string => {
  if (ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}
