import test from 'node:test'
import assert from 'node:assert/strict'
import { ScanJobManager } from '../src/services/jobManager.js'

const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)) }
  throw new Error('Timed out waiting for queue operation')
}

function setupManager({ job, readFailures = 0, claimFailures = 0, commitThenFailClaim = false, permanentReadFailure = false, retryDelaysMs = [0, 0, 0, 0] } = {}) {
  const record = job || { _id: 'job-1', target: 'https://example.test', status: 'queued', cancellationRequested: false, progress: {}, logs: [], toObject() { return { ...this } }, async save() {} }
  let reads = 0, claims = 0
  const calls = { reads: 0, claims: 0, runs: 0 }
  const model = {
    async findById() {
      calls.reads++; reads++
      if (permanentReadFailure || reads <= readFailures) throw Object.assign(new Error('temporary database failure'), { name: 'MongoNetworkError' })
      return record
    },
    async findOneAndUpdate(filter, update) {
      calls.claims++; claims++
      if (claims <= claimFailures) throw Object.assign(new Error('transition write failed'), { name: 'MongoNetworkError' })
      if (record.status !== filter.status) return null
      for (const [key, value] of Object.entries(update.$set || {})) {
        if (key.includes('.')) { const [parent, child] = key.split('.'); record[parent] ||= {}; record[parent][child] = value }
        else record[key] = value
      }
      if (update.$push?.logs) record.logs.push(update.$push.logs)
      if (commitThenFailClaim && claims === 1) throw Object.assign(new Error('claim acknowledgement lost'), { name: 'MongoNetworkError' })
      return record
    },
  }
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs })
  manager.run = async current => { calls.runs++; current.status = 'completed' }
  return { manager, job: record, calls, model }
}

test('a MongoDB read failure after queue selection retries and executes once despite duplicate enqueue', async () => {
  const fixture = setupManager({ readFailures: 1 })
  await fixture.manager.enqueue(fixture.job)
  await fixture.manager.enqueue(fixture.job)
  await waitFor(() => !fixture.manager.pumping)
  assert.equal(fixture.calls.runs, 1)
  assert.equal(fixture.job.status, 'completed')
  assert.equal(fixture.manager.queue.length, 0)
})

test('a transient Queued to Running transition failure retries without duplicate execution', async () => {
  const fixture = setupManager({ claimFailures: 1 })
  await fixture.manager.enqueue(fixture.job)
  await waitFor(() => !fixture.manager.pumping)
  assert.equal(fixture.calls.claims, 2)
  assert.equal(fixture.calls.runs, 1)
})

test('a lost claim acknowledgement is recovered by its worker token without running twice', async () => {
  const fixture = setupManager({ commitThenFailClaim: true })
  await fixture.manager.enqueue(fixture.job)
  await waitFor(() => !fixture.manager.pumping)
  assert.equal(fixture.calls.runs, 1)
  assert.equal(fixture.calls.claims, 1)
  assert.ok(fixture.job.workerToken, 'the committed claim retains the token used to recover its lost acknowledgement')
})

test('cancellation during a lost claim acknowledgement ends the not-yet-started job', async () => {
  const fixture = setupManager({ commitThenFailClaim: true, retryDelaysMs: [50, 100, 200, 400] })
  await fixture.manager.enqueue(fixture.job)
  await waitFor(() => fixture.manager.lastQueueError !== null)
  const cancelled = await fixture.manager.cancel(fixture.job._id)
  assert.equal(cancelled.status, 'cancelled')
  await waitFor(() => !fixture.manager.pumping)
  assert.equal(fixture.calls.runs, 0)
  assert.equal(fixture.job.status, 'cancelled')
})

test('retry exhaustion marks the queued job failed when MongoDB can record the failure', async () => {
  const fixture = setupManager({ permanentReadFailure: true })
  fixture.model.findById = async () => { fixture.calls.reads++; throw Object.assign(new Error('database unavailable'), { name: 'MongoServerSelectionError' }) }
  await fixture.manager.enqueue(fixture.job)
  await waitFor(() => !fixture.manager.pumping)
  assert.equal(fixture.calls.runs, 0)
  assert.equal(fixture.job.status, 'failed')
  assert.match(fixture.job.error, /could not recover queued scan/)
  assert.equal(fixture.manager.health().pausedJobs, 0)
})

test('cancellation during a retry is persisted and prevents worker execution', async () => {
  const fixture = setupManager({ readFailures: 1, retryDelaysMs: [50, 100, 200, 400] })
  await fixture.manager.enqueue(fixture.job)
  await waitFor(() => fixture.manager.lastQueueError !== null)
  const cancelled = await fixture.manager.cancel(fixture.job._id)
  assert.equal(cancelled.status, 'cancelled')
  await waitFor(() => !fixture.manager.pumping)
  assert.equal(fixture.calls.runs, 0)
  assert.equal(fixture.job.status, 'cancelled')
})

test('queued work pauses while MongoDB is unavailable and resumes after recovery', async () => {
  const fixture = setupManager()
  fixture.manager.setDatabaseAvailable(false)
  await fixture.manager.enqueue(fixture.job)
  assert.equal(fixture.manager.queue.length, 1)
  assert.equal(fixture.calls.runs, 0)
  fixture.manager.setDatabaseAvailable(true)
  await waitFor(() => !fixture.manager.pumping)
  assert.equal(fixture.calls.runs, 1)
})

test('restart recovery fails interrupted jobs and requeues persisted queued jobs once', async () => {
  const active = { _id: 'active', status: 'running', cancellationRequested: false, progress: {}, logs: [], async save() {}, toObject() { return { ...this } } }
  const queued = { _id: 'queued', target: 'https://example.test', status: 'queued', cancellationRequested: false, progress: {}, logs: [], async save() {}, toObject() { return { ...this } } }
  const model = {
    find: filter => {
      const records = filter.status?.$in ? [active] : [queued]
      const query = { sort() { return query }, then(resolve, reject) { return Promise.resolve(records).then(resolve, reject) } }
      return query
    },
    findById: async id => id === 'queued' ? queued : active,
    findOneAndUpdate: async (_filter, update) => { Object.assign(queued, update.$set); return queued },
  }
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  let runs = 0; manager.run = async () => { runs++ }
  await manager.restore()
  await waitFor(() => !manager.pumping)
  assert.equal(active.status, 'failed')
  assert.equal(queued.status, 'running')
  assert.equal(runs, 1)
})

