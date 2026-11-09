import { expect, test } from 'claude-code/testing'

import { parseRouting, routingLine } from '../hooks/routing'

const good = {
  difficulty: 5, classification_source: 'heuristic', provider: 'claude', model: 'claude-opus-5-5', effort: 'high',
  why: 'lowest expected cost; policy hard frontier high', reasons: ['Whole-repository scope'],
}

test('a well-formed decision keeps only the bounded known fields', () => {
  expect(parseRouting(good)).toEqual(good)
  expect(parseRouting({ ...good, candidates: [{ credentialRef: 'x' }] })).toEqual(good)
})

test('an older server, null or malformed input gives no routing and never throws', () => {
  for (const value of [undefined, null, 3, 'x', [], {}, { difficulty: 0 }, { difficulty: 6 }, { difficulty: '3' }]) {
    expect(parseRouting(value)).toBeNull()
  }
})

test('the line says requested, not applied, and copes with a missing model', () => {
  expect(routingLine(parseRouting(good)!)).toBe('d5 (heuristic) → claude / claude-opus-5-5 / high requested · lowest expected cost; policy hard frontier high')
  expect(routingLine({ difficulty: 2, classification_source: null, provider: null, model: null, effort: null, why: '', reasons: [] }))
    .toBe('d2 → provider default requested')
})
