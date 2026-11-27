import { expect, test } from 'claude-code/testing'
import { outdatedLatest } from '../hooks/toasts'

test('outdatedLatest compares numeric semver and ignores suffixes', () => {
  expect(outdatedLatest('0.5.3', '0.6.47')).toBe('0.6.47')
  expect(outdatedLatest('0.9.0', '0.10.0')).toBe('0.10.0')
  expect(outdatedLatest('0.6.47', '0.6.47')).toBeNull()
  expect(outdatedLatest('0.10.0', '0.9.0')).toBeNull()
  expect(outdatedLatest('0.6.0-rc.1', '0.6.1+b2')).toBe('0.6.1+b2')
})

test('outdatedLatest is null for malformed or missing versions', () => {
  for (const bad of ['banana', '1.2', '', null, undefined, 7]) {
    expect(outdatedLatest('0.5.3', bad)).toBeNull()
    expect(outdatedLatest(bad, '0.6.47')).toBeNull()
  }
})
