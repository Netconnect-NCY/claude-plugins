import { expect, test } from 'claude-code/testing'
import { CAPTURE_REMINDER } from '../hooks/capture'

test('classic.Stop is advisory and preserves downstream context', async ($, on) => {
  const notices: string[] = []
  on('session.messages', () => ({ value: [{ role: 'assistant', text: "I'll fix it later.", toolUses: [] }] }))
  on('ui.log', (_, e) => { notices.push(e.text); return { value: undefined } })
  on('classic.Stop', () => ({ additionalContext: ['existing context'] }))
  const answer = await $.classic.Stop({ stop_hook_active: false })
  await Promise.resolve()
  expect(answer).toEqual({ additionalContext: ['existing context', CAPTURE_REMINDER] })
  expect(notices).toEqual([CAPTURE_REMINDER])
})

test('classic.Stop never promotes user or tool text into a promise', async ($, on) => {
  const notices: string[] = []
  on('session.messages', () => ({ value: [{ role: 'user', text: "I'll fix it later.", toolUses: [] }] }))
  on('ui.log', (_, e) => { notices.push(e.text); return { value: undefined } })
  on('classic.Stop', () => ({}))
  expect(await $.classic.Stop({ stop_hook_active: false })).toEqual({})
  await Promise.resolve()
  expect(notices).toEqual([])
})

test('classic.Stop keeps an existing downstream approval block', async ($, on) => {
  on('session.messages', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('classic.Stop', () => ({ block: 'Existing approval boundary' }))
  expect(await $.classic.Stop({ stop_hook_active: true, last_assistant_message: "I'll fix it later." }))
    .toEqual({ block: 'Existing approval boundary', additionalContext: [CAPTURE_REMINDER] })
})
