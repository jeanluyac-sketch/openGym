import { describe, expect, it } from 'vitest'
import { EXIDX, CATALOGUE } from './exercises.js'
import { similarExercises, similarKey } from './similar-exercises.js'

const byName = n => CATALOGUE.find(e => e.n === n)

describe('similarExercises', () => {
  it('offers the same movement on other equipment first', () => {
    const bar = byName('barbell incline bench press')
    const out = similarExercises(bar, CATALOGUE)
    const names = out.slice(0, 12).map(e => e.n)
    expect(names).toContain('dumbbell incline bench press')
    expect(names).toContain('cable incline bench press')
    // the dumbbell variation comes before an unrelated chest exercise
    const plain = out.findIndex(e => e.n === 'dumbbell incline bench press')
    expect(plain).toBeGreaterThanOrEqual(0)
    expect(plain).toBeLessThan(8)
  })

  it('never returns the exercise itself and stays on the target muscle', () => {
    const bar = byName('barbell incline bench press')
    const out = similarExercises(bar, CATALOGUE)
    expect(out.find(e => e.id === bar.id)).toBeUndefined()
    expect(out.length).toBeGreaterThan(20)
    expect(out.every(e => similarKey(e) === 'pectorals')).toBe(true)
  })

  it('falls back to body part for a custom exercise without a target muscle', () => {
    const mine = { id: 'c1', n: 'my press', bp: 'chest', eq: 'body weight' }
    const list = [mine, { id: 'a', n: 'x', bp: 'chest' }, { id: 'b', n: 'y', bp: 'back' }]
    expect(similarExercises(mine, list).map(e => e.id)).toEqual(['a'])
  })

  it('returns nothing for an exercise with no muscle information', () => {
    expect(similarExercises({ id: 'z', n: 'z' }, CATALOGUE)).toEqual([])
    expect(similarExercises(null, CATALOGUE)).toEqual([])
    expect(EXIDX).toBeTruthy()
  })
})
