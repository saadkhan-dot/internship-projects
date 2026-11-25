import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PERSISTED_LOGS, boundedLogPush } from '../src/services/jobManager.js'

test('scan log updates retain a bounded tail including the terminal event', () => {
  const existing = Array.from({ length: MAX_PERSISTED_LOGS }, (_, index) => `event-${index}`)
  const terminal = { at: new Date(), message: 'URL discovery completed.' }
  const update = boundedLogPush(terminal)
  const next = [...existing, ...update.$each].slice(update.$slice)
  assert.equal(update.$slice, -200)
  assert.equal(next.length, MAX_PERSISTED_LOGS)
  assert.equal(next.at(-1), terminal)
  assert.equal(next.includes('event-0'), false)
})
