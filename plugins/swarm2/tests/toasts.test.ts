import { describe, expect, test } from 'claude-code/testing'

import type { Account, Deployment, Message, Run } from '../types'
import {
  accountKey, accountToastFor, attentionToasts, deploymentKey, deploymentToastFor, MAX_MESSAGE_TOASTS, messageToasts, oneLine, runKey,
  toastFor,
} from '../hooks/toasts'

const pending: Run = {
  run_id: '12345678-1234-1234-1234-123456789abc', repo: 'acme/app', requester: null, mine: true, goal: null, status: 'succeeded',
  status_reason: null, provider: 'codex', attempt: 1, phase: 'merging', started_at: null, updated_at: '2026-11-01T00:00:00Z',
  pr_url: 'https://github.com/acme/app/pull/1', merge_status: 'pending', merge_reason: null, merge_sha: null, validation_tier: null,
  workers: [], tokens: null, cost_usd: null,
}

describe('run toasts', () => {
  test('first-seen runs do not replay historical toasts', () => {
    for (const merge_status of [null, 'pending', 'merged', 'merge_blocked', 'checks_pending_timeout', 'failed', 'skipped']) {
      expect(toastFor(undefined, { ...pending, merge_status })).toBeNull()
    }
  })

  test('pending → a failed merge outcome reports it and its reason without saying merged', () => {
    for (const status of ['merge_blocked', 'checks_pending_timeout', 'skipped', 'failed']) {
      const run: Run = { ...pending, phase: 'done', merge_status: status, merge_reason: 'checks require attention' }
      const toast = toastFor(runKey(pending), run)
      expect(toast).toBe(`Swarm2 12345678 merge ${status}: checks require attention`)
      expect(toast).not.toContain('merged')
      expect(toastFor(runKey(run), run)).toBeNull()
    }
  })

  test('pending → merged toasts exactly once, with its short SHA', () => {
    const merged: Run = { ...pending, phase: 'done', merge_status: 'merged', merge_sha: 'a'.repeat(40) }
    let key = runKey(pending)
    const toasts: string[] = []
    for (const run of [merged, merged, { ...merged, updated_at: '2026-11-01T00:00:05Z', merge_reason: 'audit complete' }]) {
      const toast = toastFor(key, run)
      if (toast) toasts.push(toast)
      key = runKey(run)
    }
    expect(toasts).toEqual(['Swarm2 12345678 merged (acme/app) · aaaaaaaa'])
    expect(toastFor(runKey(pending), { ...pending, merge_status: 'merged' })).toBe('Swarm2 12345678 merged (acme/app)')
  })

  test('entering or leaving phase merging alone never announces a merge', () => {
    expect(toastFor(runKey({ ...pending, phase: 'publishing', merge_status: null }), pending)).toBeNull()
    expect(toastFor(runKey(pending), { ...pending, phase: 'done', merge_status: null })).toBeNull()
  })

  test('PR and terminal status transitions toast; PR identity is a field, not a substring', () => {
    expect(toastFor(runKey({ ...pending, pr_url: null }), pending)).toBe(`Swarm2 12345678 opened a PR: ${pending.pr_url}`)
    expect(toastFor(runKey({ ...pending, pr_url: `${pending.pr_url}0` }), pending)).toBe(`Swarm2 12345678 opened a PR: ${pending.pr_url}`)
    for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked']) {
      expect(toastFor(runKey({ ...pending, status: 'running' }), { ...pending, status, status_reason: 'example' }))
        .toBe(`Swarm2 12345678 ${status}: example`)
    }
  })
})

const deploying: Deployment = {
  deployment_id: 'd-1', repo: 'acme/app', target: 'dev', status: 'deploying', phase: 'deploying',
  pipeline_url: 'https://bunnyshell.example/pipelines/1', reason: null, updated_at: '2026-11-03T00:00:00Z',
}

describe('deployment toasts', () => {
  test('the first load never toasts, whatever the phase', () => {
    for (const phase of ['queued', 'awaiting_approval', 'deploying', 'verifying', 'outcome_unknown', 'done', 'failed']) {
      expect(deploymentToastFor(undefined, { ...deploying, phase })).toBeNull()
    }
  })

  test('changes to done, failed and awaiting_approval toast once each', () => {
    const done: Deployment = { ...deploying, status: 'succeeded', phase: 'done' }
    expect(deploymentToastFor(deploymentKey(deploying), done)).toBe('Swarm2 deploy acme/app → dev deployed')
    expect(deploymentToastFor(deploymentKey(done), done)).toBeNull()
    const cancelled: Deployment = { ...deploying, status: 'cancelled', phase: 'failed' }
    expect(deploymentToastFor(deploymentKey(deploying), cancelled)).toBe('Swarm2 deploy acme/app → dev failed (cancelled)')
    expect(deploymentToastFor(deploymentKey({ ...deploying, status: 'failed', phase: 'failed' }), cancelled)).toBeNull()
    const waiting: Deployment = { ...deploying, target: 'prod', status: 'awaiting_approval', phase: 'awaiting_approval' }
    expect(deploymentToastFor(null, waiting)).toBe('Swarm2 deploy acme/app → prod awaiting approval')
    expect(deploymentToastFor(null, deploying)).toBeNull()
  })

  test('intermediate phases do not toast; a missing phase is derived from the status', () => {
    for (const [from, to] of [['queued', 'deploying'], ['deploying', 'verifying'], ['verifying', 'outcome_unknown']] as const) {
      expect(deploymentToastFor(deploymentKey({ ...deploying, status: from, phase: from }), { ...deploying, status: to, phase: to })).toBeNull()
    }
    expect(deploymentToastFor(deploymentKey(deploying), { ...deploying, status: 'succeeded', phase: null }))
      .toBe('Swarm2 deploy acme/app → dev deployed')
  })
})

const message = (id: number, body = `hello ${id}`): Message => ({
  id, repo: 'acme/app', from: 'colleague@example.test', from_run_id: null, body, created_at: '2026-11-03T10:15:00Z',
})

describe('message toasts', () => {
  test('the first load records ids without toasting; each new message then toasts once, oldest first', () => {
    let seen = messageToasts(null, [message(1)]).seen
    expect(messageToasts(null, [message(1)]).toasts).toEqual([])
    const toasts: string[] = []
    for (const feed of [[message(3), message(2), message(1)], [message(3), message(2), message(1)], [message(4), message(3), message(2)]]) {
      const result = messageToasts(seen, feed)
      toasts.push(...result.toasts)
      seen = result.seen
    }
    expect(toasts).toEqual([2, 3, 4].map(id => `Swarm2 message acme/app · colleague@example.test: hello ${id}`))
  })

  test('many new messages collapse into one summary toast', () => {
    const seen = messageToasts(null, []).seen
    const burst = Array.from({ length: MAX_MESSAGE_TOASTS + 2 }, (_, i) => ({ ...message(10 + i), repo: i % 2 ? 'acme/b' : 'acme/a' }))
    const result = messageToasts(seen, burst)
    expect(result.toasts).toEqual([`Swarm2: ${burst.length} new project messages (acme/a, acme/b)`])
    expect(messageToasts(result.seen, burst).toasts).toEqual([])
  })

  test('long or multi-line bodies are shortened to one line, and the seen set stays bounded', () => {
    const [toast] = messageToasts(new Set(), [message(5, `line one\n\nline two ${'x'.repeat(300)}`)]).toasts
    expect(toast).toStartWith('Swarm2 message acme/app · colleague@example.test: line one line two x')
    expect(toast).toEndWith('…')
    expect(oneLine('short', 10)).toBe('short')
    let seen = messageToasts(null, []).seen
    for (let start = 0; start < 3000; start += 50) seen = messageToasts(seen, Array.from({ length: 50 }, (_, i) => message(start + i))).seen
    expect(seen.size).toBeLessThanOrEqual(1000)
    expect(seen.has(2999)).toBe(true)
  })
})

describe('account and attention toasts', () => {
  const account: Account = {
    id: 'a1', provider: 'anthropic', kind: 'subscription_token', label: null, owner: 'you', health: 'ok',
    windows: [{ name: '5h', used_pct: 50, resets_at: null }], observed_at: null, in_use: 0, engine_workers: 0, users: [],
  }

  test('an account toasts when it passes 90% or turns exhausted, not when first seen or back to ok', () => {
    const high: Account = { ...account, windows: [{ name: '5h', used_pct: 95, resets_at: null }] }
    expect(accountToastFor(undefined, high)).toBeNull()
    expect(accountToastFor(accountKey(account), high)).toBe('Swarm2: anthropic (you) is past 90% of its limit')
    expect(accountToastFor(accountKey(high), high)).toBeNull()
    expect(accountToastFor(accountKey(high), { ...account, health: 'exhausted' })).toBe('Swarm2: anthropic (you) is exhausted')
    expect(accountToastFor(accountKey(high), account)).toBeNull()
  })

  test('new attention items toast once, except those another rule already toasts', () => {
    const approval = { kind: 'run_approval', text: 'acme/app: a run\'s scope change is waiting for your approval', url: null }
    const deploy = { kind: 'deploy_approval', text: 'acme/app: prod deploy is waiting for your approval', url: null }
    const first = attentionToasts(null, [deploy])
    expect(first.toasts).toEqual([])
    const second = attentionToasts(first.seen, [deploy, approval])
    expect(second.toasts).toEqual([`Swarm2 needs you: ${approval.text}`])
    expect(attentionToasts(second.seen, [deploy, approval]).toasts).toEqual([])
    expect(attentionToasts(second.seen, [{ kind: 'run_blocked', text: 'acme/app: run blocked', url: null }]).toasts).toEqual([])
  })
})

describe('AI account failure toasts', () => {
  const account: Account = {
    id: 'a1', provider: 'anthropic', kind: 'api_key', label: null, owner: 'you', health: 'ok',
    windows: [{ name: '5h', used_pct: 50, resets_at: null }], observed_at: null, in_use: 0, engine_workers: 0, users: [],
  }

  test('degraded is an alarm level; first sight never toasts; invalid names the repair', () => {
    const degraded: Account = { ...account, health: 'degraded', health_since: '2026-11-08T10:00:00Z', last_error: 'rate_limited (HTTP 429)' }
    expect(accountKey(degraded)).toBe('degraded')
    expect(accountToastFor(undefined, degraded)).toBeNull()
    expect(accountToastFor(accountKey(account), degraded)).toBe('Swarm2: anthropic (you) is degraded')
    const invalid: Account = { ...account, health: 'invalid', attention: true }
    expect(accountToastFor(accountKey(account), invalid))
      .toBeNull()
    expect(accountToastFor(accountKey(account), { ...account, health: 'invalid' })).toBe('Swarm2: anthropic (you) is invalid')
    expect(accountToastFor(accountKey(account), { ...account, health: 'exhausted' })).toBe('Swarm2: anthropic (you) is exhausted')
  })

  test('account_invalid attention toasts once per transition, without replaying the first poll', () => {
    const item = { kind: 'account_invalid', text: 'Your Anthropic account is invalid: dispatch skips it until you replace the credential',
      url: 'https://swarm.test/me/credentials' }
    const first = attentionToasts(null, [item])
    expect(first.toasts).toEqual([])
    expect(attentionToasts(first.seen, [item]).toasts).toEqual([])
    expect(attentionToasts(new Set(), [item]).toasts).toEqual([`Swarm2 needs you: ${item.text}`])
    const recovered = attentionToasts(first.seen, [])
    expect(attentionToasts(recovered.seen, [item]).toasts).toEqual([])
    expect(attentionToasts(recovered.seen, [{ ...item, id: "credential:new-transition" }]).toasts).toEqual([`Swarm2 needs you: ${item.text}`])
  })
})

describe('observation toasts', () => {
  test('health outcomes name observation and merged SHA, with cancellation distinct from success', () => {
    const observing: Deployment = { ...deploying, source: 'external', status: 'verifying', phase: 'verifying',
      outcome: null, merge_sha: 'b'.repeat(64) }
    for (const [status, outcome, label] of [['succeeded', 'ok', 'ok'], ['failed', 'failed', 'failed'],
      ['failed', 'timeout', 'timeout'], ['cancelled', null, 'cancelled']] as const) {
      const done: Deployment = { ...observing, status, outcome, phase: status === 'succeeded' ? 'done' : 'failed' }
      expect(deploymentToastFor(deploymentKey(observing), done))
        .toBe(`Swarm2 observation acme/app → dev observed · ${label} · merged bbbbbbbb`)
      expect(deploymentToastFor(undefined, done)).toBeNull()
      expect(deploymentToastFor(deploymentKey(done), done)).toBeNull()
    }
  })
})
