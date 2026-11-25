import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateProgressPercent, syncJobProgress } from '../src/services/progress.js'
import { preferNewerJob } from '../../frontend/src/jobSnapshot.js'

test('completed progress is 100% when 17 URLs resolve with only 16 HTTP attempts', () => {
  const progress = { urlsDiscovered: 17, urlsProcessed: 17, pagesAttempted: 16, pagesFetched: 16, failedRequests: 0 }
  assert.equal(Math.round(progress.pagesAttempted / progress.urlsDiscovered * 100), 94)
  assert.equal(calculateProgressPercent(progress, 'completed'), 100)
  assert.equal(calculateProgressPercent({ ...progress, urlsProcessed: 16 }, 'running'), 94)
})

test('cancelled and failed jobs never report 100%; running work is capped below completion', () => {
  const fullyResolved = { urlsDiscovered: 17, urlsProcessed: 17 }
  assert.equal(calculateProgressPercent(fullyResolved, 'running'), 99)
  assert.equal(calculateProgressPercent(fullyResolved, 'cancelled'), null)
  assert.equal(calculateProgressPercent(fullyResolved, 'failed'), null)
  assert.equal(calculateProgressPercent({ urlsDiscovered: 17, urlsProcessed: 8 }, 'cancelled'), null)
  assert.equal(calculateProgressPercent({}, 'queued'), null)
})

test('legacy pagesProcessed follows resolved URL outcomes, not HTTP attempts', () => {
  const job = { status: 'running', progress: { urlsDiscovered: 17, urlsProcessed: 17, pagesAttempted: 16 } }
  syncJobProgress(job)
  assert.equal(job.progress.percent, 99)
  assert.equal(job.pagesProcessed, 17)
})

test('frontend snapshot selection ignores out-of-order progress and terminal-state regressions', () => {
  const completed = { _id: 'scan', status: 'completed', updatedAt: '2026-11-21T10:00:02.000Z', progress: { percent: 100 } }
  const staleRunning = { _id: 'scan', status: 'running', updatedAt: '2026-11-21T10:00:01.000Z', progress: { percent: 94 } }
  assert.equal(preferNewerJob(completed, staleRunning), completed)
  assert.equal(preferNewerJob(staleRunning, completed), completed)
})
