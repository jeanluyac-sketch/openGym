// fork(claude-chat-swap): exercises that train the same muscle as another one, best match first.
// Used by the Swap exercise picker so "barbell incline bench press" offers "dumbbell incline
// bench press" before anything else. Pure: takes the exercise and the list to search.

// Words that name the equipment, not the movement. Dropped before comparing names so
// "barbell incline bench press" and "dumbbell incline bench press" read as the same movement.
const EQUIPMENT_WORDS = new Set([
  'barbell', 'dumbbell', 'cable', 'lever', 'leverage', 'machine', 'smith', 'band', 'resistance',
  'kettlebell', 'ez', 'bar', 'body', 'weight', 'bodyweight', 'assisted', 'weighted', 'sled',
  'olympic', 'trap', 'hex', 'medicine', 'ball', 'stability', 'bosu', 'suspended', 'rope',
  'one', 'arm', 'single', 'alternate', 'seated', 'standing', 'on', 'with', 'the', 'a', 'of', 'to',
])

const words = name => String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !EQUIPMENT_WORDS.has(w))

const secondaries = ex => (Array.isArray(ex?.sm) ? ex.sm : ex?.sm ? [ex.sm] : [])

/** The muscle an exercise is "about": its target muscle, or its body part when it has none. */
export const similarKey = ex => ex?.tg || ex?.bp || ''

/**
 * Exercises in `list` that hit the same target muscle as `ex`, the same movement first.
 * Ranking: shared movement words in the name (incline, press, row…) outweigh everything, then
 * shared secondary muscles, then a different piece of equipment (the execution is what should
 * vary), then the name. `ex` itself is never in the result.
 */
export function similarExercises(ex, list) {
  const key = similarKey(ex)
  if (!ex || !key) return []
  const mine = new Set(words(ex.n))
  const mySec = new Set(secondaries(ex))
  const scored = []
  for (const e of list) {
    if (!e || e.id === ex.id || similarKey(e) !== key) continue
    let score = 0
    for (const w of new Set(words(e.n))) if (mine.has(w)) score += 10
    for (const m of secondaries(e)) if (mySec.has(m)) score += 2
    if (e.mg && e.mg === ex.mg) score += 1
    if (e.eq && e.eq !== ex.eq) score += 3
    scored.push({ e, score })
  }
  scored.sort((a, b) => (b.score - a.score) || String(a.e.n).localeCompare(String(b.e.n)))
  return scored.map(x => x.e)
}
