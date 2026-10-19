// The numbers behind the Activity card's breakdown under the heatmap: how long (or how much
// volume) a workout takes on average, per training day, per weekday and per routine, filtered by
// weekday and routine. Pure, so the averages are tested here rather than read off a chart.
import { workoutDay, workoutDuration, workoutVolume } from './history.js'
import { weekKey, weekDayOffset } from './format.js'

// Same reading as the heatmap: a record with entries is recomputed from its sets, a legacy one
// without falls back to its cached volume.
const volumeOf = w => {
  if (Array.isArray(w?.entries)) return Math.max(0, Number(workoutVolume(w)) || 0)
  const volume = Number(w?.vol)
  return Number.isFinite(volume) ? Math.max(0, volume) : 0
}

const routineIdsOf = w => [].concat(w?.routineIds ?? (w?.routineId ? [w.routineId] : [])).filter(Boolean)

/**
 * One row per finished workout that has the metric at all: minutes for 'time', volume for 'vol'.
 * A workout with no recorded duration (imported history has no clock) is left out of 'time'
 * instead of counting as zero, which would drag every average down.
 *
 * The routine key is the routine id(s) the workout was started from, so a renamed routine keeps
 * its history; a freestyle workout groups by its name. The label is the routine's current name.
 *
 * @returns {{ sessions: Array<{ t: number, d: string, wd: number, key: string, label: string, value: number }>, skipped: number }}
 */
export function activitySessions(workouts, routines, metric = 'time') {
  const nameOf = Object.fromEntries((routines || []).map(r => [r.id, r.name]))
  const sessions = []
  let skipped = 0
  for (const w of workouts || []) {
    const d = workoutDay(w)
    if (!d) continue
    const value = metric === 'vol' ? volumeOf(w) : Math.round(workoutDuration(w) / 60000)
    if (!(value > 0)) { skipped++; continue }
    const ids = routineIdsOf(w)
    const key = ids.length ? 'r:' + ids.join('+') : 'n:' + (w.name || '')
    const label = ids.length && ids.every(id => nameOf[id]) ? ids.map(id => nameOf[id]).join(' + ') : (w.name || '')
    const date = new Date(d + 'T12:00:00')
    sessions.push({ t: date.getTime(), d, wd: date.getDay(), key, label, value })
  }
  sessions.sort((a, b) => a.t - b.t)
  return { sessions, skipped }
}

/** Narrow sessions to a start time (ms, 0 = all), a weekday (0-6, null = any) and a routine key (null = any). */
export function filterSessions(sessions, { from = 0, weekday = null, routine = null } = {}) {
  return sessions.filter(s => s.t >= from && (weekday == null || s.wd === weekday) && (routine == null || s.key === routine))
}

/** Totals and averages: per workout, and per training day (two workouts on one day count as one day). */
export function activitySummary(sessions) {
  const total = sessions.reduce((sum, s) => sum + s.value, 0)
  const days = new Set(sessions.map(s => s.d)).size
  return {
    n: sessions.length,
    days,
    total,
    perWorkout: sessions.length ? total / sessions.length : null,
    perDay: days ? total / days : null,
  }
}

/** One point per training day, the day's workouts summed — what the heatmap shades, as a line. */
export function perDaySeries(sessions) {
  const byDay = new Map()
  for (const s of sessions) {
    const p = byDay.get(s.d) || { t: s.t, d: s.d, y: 0, n: 0 }
    p.y += s.value
    p.n++
    byDay.set(s.d, p)
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t)
}

/** Average per workout for each week that has one, dated by the week's first day. */
export function weeklyAverageSeries(sessions, ws) {
  const byWeek = new Map()
  for (const s of sessions) {
    const k = weekKey(s.d, ws)
    const p = byWeek.get(k) || { d: k, t: new Date(k + 'T12:00:00').getTime(), sum: 0, n: 0 }
    p.sum += s.value
    p.n++
    byWeek.set(k, p)
  }
  return [...byWeek.values()].sort((a, b) => a.t - b.t).map(p => ({ t: p.t, d: p.d, y: p.sum / p.n, n: p.n }))
}

/** Average per workout on each weekday, all seven, in the order the profile's week starts. */
export function byWeekday(sessions, ws) {
  const rows = Array.from({ length: 7 }, (_, i) => ({ wd: (ws + i) % 7, n: 0, sum: 0 }))
  for (const s of sessions) {
    const row = rows[weekDayOffset(s.wd, ws)]
    row.n++
    row.sum += s.value
  }
  return rows.map(r => ({ wd: r.wd, n: r.n, avg: r.n ? r.sum / r.n : null }))
}

/** Average per workout for each routine (A, B, Upper, Lower…), the most trained first. */
export function byRoutine(sessions) {
  const rows = new Map()
  for (const s of sessions) {
    const row = rows.get(s.key) || { key: s.key, label: s.label, n: 0, sum: 0 }
    row.n++
    row.sum += s.value
    row.label = s.label   // the latest name wins, so a renamed freestyle-by-name group reads current
    rows.set(s.key, row)
  }
  return [...rows.values()]
    .map(r => ({ key: r.key, label: r.label, n: r.n, avg: r.sum / r.n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
}
