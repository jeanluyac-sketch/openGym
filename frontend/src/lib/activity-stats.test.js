import { describe, expect, it } from 'vitest'
import { activitySessions, filterSessions, activitySummary, perDaySeries, weeklyAverageSeries, byWeekday, byRoutine } from './activity-stats.js'

const MIN = 60000
// 2026-10-12 is a Monday.
const at = (d, h = 18) => new Date(d + 'T' + String(h).padStart(2, '0') + ':00:00').getTime()
const workout = (d, minutes, extra = {}) => ({ id: d + minutes, d, start: at(d), end: at(d) + minutes * MIN, entries: [], ...extra })

const routines = [{ id: 'a', name: 'Treino A' }, { id: 'b', name: 'Inferior' }]
const workouts = [
  workout('2026-10-12', 60, { routineIds: ['a'], name: 'Old A name' }),   // Monday
  workout('2026-10-14', 40, { routineIds: ['b'], name: 'Inferior' }),     // Wednesday
  workout('2026-10-19', 80, { routineIds: ['a'], name: 'Treino A' }),     // Monday
  workout('2026-10-19', 20, { name: 'Cardio' }),                          // Monday, freestyle, same day
  { id: 'imported', d: '2026-10-15', entries: [], routineIds: ['b'] },     // no clock
]

describe('activitySessions', () => {
  it('reads minutes, weekday and routine per workout, leaving out ones with no duration', () => {
    const { sessions, skipped } = activitySessions(workouts, routines, 'time')
    expect(skipped).toBe(1)
    expect(sessions.map(s => s.value)).toEqual([60, 40, 80, 20])
    expect(sessions.map(s => s.wd)).toEqual([1, 3, 1, 1])
    expect(sessions.map(s => s.key)).toEqual(['r:a', 'r:b', 'r:a', 'n:Cardio'])
    // the routine's current name, not the one stored on the old workout
    expect(sessions[0].label).toBe('Treino A')
  })

  it('keys a combined session by all its routines', () => {
    const { sessions } = activitySessions([workout('2026-10-12', 30, { routineIds: ['a', 'b'] })], routines)
    expect(sessions[0]).toMatchObject({ key: 'r:a+b', label: 'Treino A + Inferior' })
  })

  it('falls back to the workout name for a routine that no longer exists', () => {
    const { sessions } = activitySessions([workout('2026-10-12', 30, { routineIds: ['gone'], name: 'Push' })], routines)
    expect(sessions[0]).toMatchObject({ key: 'r:gone', label: 'Push' })
  })
})

describe('summary and series', () => {
  const { sessions } = activitySessions(workouts, routines, 'time')

  it('averages per workout and per training day', () => {
    expect(activitySummary(sessions)).toEqual({ n: 4, days: 3, total: 200, perWorkout: 50, perDay: 200 / 3 })
    expect(activitySummary([])).toMatchObject({ n: 0, perWorkout: null, perDay: null })
  })

  it('sums a day with two workouts into one point', () => {
    expect(perDaySeries(sessions).map(p => [p.d, p.y, p.n])).toEqual([
      ['2026-10-12', 60, 1], ['2026-10-14', 40, 1], ['2026-10-19', 100, 2],
    ])
  })

  it('averages per workout week by week', () => {
    expect(weeklyAverageSeries(sessions, 1).map(p => [p.d, p.y])).toEqual([['2026-10-12', 50], ['2026-10-19', 50]])
  })

  it('lists all seven weekdays from the week start, empty ones with no average', () => {
    const rows = byWeekday(sessions, 1)
    expect(rows.map(r => r.wd)).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(rows[0]).toEqual({ wd: 1, n: 3, avg: 160 / 3 })
    expect(rows[2]).toEqual({ wd: 3, n: 1, avg: 40 })
    expect(rows[1].avg).toBeNull()
    expect(byWeekday(sessions, 0).map(r => r.wd)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('averages per routine, most trained first', () => {
    expect(byRoutine(sessions)).toEqual([
      { key: 'r:a', label: 'Treino A', n: 2, avg: 70 },
      { key: 'n:Cardio', label: 'Cardio', n: 1, avg: 20 },
      { key: 'r:b', label: 'Inferior', n: 1, avg: 40 },
    ])
  })

  it('filters by weekday, routine and start time together', () => {
    expect(filterSessions(sessions, { weekday: 1 }).map(s => s.value)).toEqual([60, 80, 20])
    expect(filterSessions(sessions, { weekday: 1, routine: 'r:a' }).map(s => s.value)).toEqual([60, 80])
    expect(filterSessions(sessions, { from: at('2026-10-13', 0) }).map(s => s.value)).toEqual([40, 80, 20])
  })
})

describe('volume', () => {
  it('uses the cached volume of a legacy record and skips zero-volume workouts', () => {
    const { sessions, skipped } = activitySessions([
      { d: '2026-10-12', vol: 5000, routineIds: ['a'] },
      { d: '2026-10-13', vol: 0 },
    ], routines, 'vol')
    expect(sessions.map(s => s.value)).toEqual([5000])
    expect(skipped).toBe(1)
  })
})
