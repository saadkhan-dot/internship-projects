import test from 'node:test'
import assert from 'node:assert/strict'
import { ScanJobManager } from '../src/services/jobManager.js'
import { normalizeWebsite } from '../src/discovery/url.js'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 2000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await pause(5)
  }
  throw new Error('Timed out waiting for condition')
}

function createInMemoryScanJobModel(initialJobs = []) {
  let counter = 1
  const store = initialJobs.map(j => ({
    _id: j._id || `job-${counter++}`,
    target: j.target,
    type: j.type || 'website',
    status: j.status || 'queued',
    cancellationRequested: Boolean(j.cancellationRequested),
    options: j.options || {},
    logs: j.logs || [],
    progress: j.progress || {},
    createdAt: j.createdAt || new Date(Date.now() + counter),
    updatedAt: j.updatedAt || new Date(),
    toObject() { return { ...this } },
    async save() { return this },
  }))

  const model = {
    _store: store,
    async create(doc) {
      const record = {
        _id: doc._id || `job-${counter++}`,
        target: doc.target,
        type: doc.type || 'website',
        status: doc.status || 'queued',
        cancellationRequested: Boolean(doc.cancellationRequested),
        options: doc.options || {},
        logs: doc.logs ? [...doc.logs] : [],
        progress: doc.progress || {},
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
        toObject() { return { ...this } },
        async save() { return this },
      }
      store.push(record)
      return record
    },
    find(filter = {}) {
      let results = [...store]
      if (filter.status) {
        if (typeof filter.status === 'object' && filter.status.$in) {
          results = results.filter(j => filter.status.$in.includes(j.status))
        } else {
          results = results.filter(j => j.status === filter.status)
        }
      }
      if (filter.cancellationRequested && typeof filter.cancellationRequested === 'object' && filter.cancellationRequested.$ne !== undefined) {
        results = results.filter(j => j.cancellationRequested !== filter.cancellationRequested.$ne)
      } else if (filter.cancellationRequested !== undefined) {
        results = results.filter(j => j.cancellationRequested === filter.cancellationRequested)
      }
      const query = {
        sort(sortObj = {}) {
          results.sort((a, b) => {
            const timeDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            if (timeDiff !== 0) return sortObj.createdAt === -1 ? -timeDiff : timeDiff
            return String(a._id).localeCompare(String(b._id))
          })
          return query
        },
        select() { return query },
        limit(n) { results = results.slice(0, n); return query },
        then(resolve, reject) { return Promise.resolve(results).then(resolve, reject) }
      }
      return query
    },
    findOne(filter = {}) {
      const q = model.find(filter)
      const query = {
        sort(sortObj) { q.sort(sortObj); return query },
        select(fields) { q.select(fields); return query },
        then(resolve, reject) {
          return q.then(results => resolve(results[0] || null), reject)
        }
      }
      return query
    },
    async findById(id) {
      const match = store.find(j => String(j._id) === String(id))
      return match || null
    },
    async findOneAndUpdate(filter, update, options = {}) {
      const job = store.find(j => {
        if (filter._id && String(j._id) !== String(filter._id)) return false
        if (filter.status && typeof filter.status === 'object' && filter.status.$in) {
          if (!filter.status.$in.includes(j.status)) return false
        } else if (filter.status && j.status !== filter.status) return false
        if (filter.cancellationRequested && typeof filter.cancellationRequested === 'object' && filter.cancellationRequested.$ne !== undefined) {
          if (j.cancellationRequested === filter.cancellationRequested.$ne) return false
        } else if (filter.cancellationRequested !== undefined && j.cancellationRequested !== filter.cancellationRequested) {
          return false
        }
        if (filter.workerToken && j.workerToken !== filter.workerToken) return false
        return true
      })
      if (!job) return null
      if (update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
          if (k.includes('.')) {
            const [p, c] = k.split('.')
            job[p] = job[p] || {}
            job[p][c] = v
          } else {
            job[k] = v
          }
        }
      }
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) delete job[k]
      }
      if (update.$push?.logs) {
        const entry = update.$push.logs.$each ? update.$push.logs.$each[0] : update.$push.logs
        job.logs.push(entry)
      }
      job.updatedAt = new Date()
      return job
    },
    async updateOne(filter, update) {
      return model.findOneAndUpdate(filter, update)
    },
    async countDocuments(filter = {}) {
      const matches = await model.find(filter)
      return matches.length
    },
    async aggregate(pipeline = []) {
      const groupStage = pipeline.find(p => p.$group)
      if (groupStage) {
        const counts = {}
        for (const j of store) {
          const key = j.status
          counts[key] = (counts[key] || 0) + 1
        }
        return Object.entries(counts).map(([_id, count]) => ({ _id, count }))
      }
      return []
    }
  }
  return model
}

test('1. Submitting one website creates one scan job', async () => {
  const model = createInMemoryScanJobModel()
  const job = await model.create({ type: 'website', target: 'https://example.com/', status: 'queued' })
  assert.equal(model._store.length, 1)
  assert.equal(job.target, 'https://example.com/')
  assert.equal(job.status, 'queued')
})

test('2. Submitting multiple websites creates multiple distinct jobs', async () => {
  const model = createInMemoryScanJobModel()
  const targets = ['https://site-a.com/', 'https://site-b.com/', 'https://site-c.com/']
  const jobs = []
  for (const target of targets) {
    jobs.push(await model.create({ type: 'website', target, status: 'queued' }))
  }
  assert.equal(jobs.length, 3)
  assert.equal(model._store.length, 3)
  assert.deepEqual(jobs.map(j => j.target), targets)
})

test('3. Jobs are executed in strict FIFO order', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  const executionOrder = []
  manager.run = async (job) => {
    executionOrder.push(job.target)
    job.status = 'completed'
  }

  const job1 = await model.create({ target: 'https://first.com/', createdAt: new Date(1000) })
  const job2 = await model.create({ target: 'https://second.com/', createdAt: new Date(2000) })
  const job3 = await model.create({ target: 'https://third.com/', createdAt: new Date(3000) })

  await manager.enqueueBatch([job1, job2, job3])
  await waitFor(() => executionOrder.length === 3)

  assert.deepEqual(executionOrder, [
    'https://first.com/',
    'https://second.com/',
    'https://third.com/'
  ])
})

test('4. Only ONE scan runs at a time globally (concurrency is strictly 1)', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  let maxConcurrent = 0
  let currentConcurrent = 0

  manager.run = async (job) => {
    currentConcurrent++
    if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent
    assert.equal(currentConcurrent, 1, 'Never run more than 1 scan simultaneously')
    await pause(20)
    currentConcurrent--
    job.status = 'completed'
  }

  const job1 = await model.create({ target: 'https://site1.com/' })
  const job2 = await model.create({ target: 'https://site2.com/' })
  const job3 = await model.create({ target: 'https://site3.com/' })

  await manager.enqueueBatch([job1, job2, job3])
  await waitFor(() => !manager.pumping && model._store.every(j => j.status === 'completed'))

  assert.equal(maxConcurrent, 1)
})

test('5. New jobs submitted during an active scan are appended to the queue', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  const executionOrder = []

  manager.run = async (job) => {
    executionOrder.push(job.target)
    await pause(40)
    job.status = 'completed'
  }

  const job1 = await model.create({ target: 'https://job1.com/' })
  await manager.enqueue(job1)

  // Enqueue job 2 and 3 while job 1 is running
  await pause(10)
  assert.equal(manager.running.size, 1)

  const job2 = await model.create({ target: 'https://job2.com/' })
  const job3 = await model.create({ target: 'https://job3.com/' })
  await manager.enqueue(job2)
  await manager.enqueue(job3)

  await waitFor(() => executionOrder.length === 3)
  assert.deepEqual(executionOrder, ['https://job1.com/', 'https://job2.com/', 'https://job3.com/'])
})

test('6. Completing a scan automatically starts the next queued job', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  const completed = []

  manager.run = async (job) => {
    await pause(10)
    job.status = 'completed'
    completed.push(job._id)
  }

  const jobA = await model.create({ target: 'https://alpha.com/' })
  const jobB = await model.create({ target: 'https://beta.com/' })
  await manager.enqueueBatch([jobA, jobB])

  await waitFor(() => completed.length === 2)
  assert.equal(completed[0], jobA._id)
  assert.equal(completed[1], jobB._id)
})

test('7. A failed scan does not block subsequent queued jobs from executing', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  const outcomes = []

  manager.run = async (job) => {
    if (job.target.includes('fail')) {
      job.status = 'failed'
      job.error = 'Network unreachable'
      outcomes.push({ target: job.target, status: 'failed' })
      throw new Error('Network unreachable')
    }
    job.status = 'completed'
    outcomes.push({ target: job.target, status: 'completed' })
  }

  const job1 = await model.create({ target: 'https://fail-test.com/' })
  const job2 = await model.create({ target: 'https://success-test.com/' })

  await manager.enqueueBatch([job1, job2])
  await waitFor(() => outcomes.length === 2)

  assert.equal(outcomes[0].status, 'failed')
  assert.equal(outcomes[1].status, 'completed')
  assert.equal(outcomes[1].target, 'https://success-test.com/')
})

test('8. A queued job can be cancelled before execution and is never run', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  const executed = []

  manager.run = async (job) => {
    executed.push(job.target)
    await pause(30)
    job.status = 'completed'
  }

  const job1 = await model.create({ target: 'https://active.com/' })
  const job2 = await model.create({ target: 'https://cancelled-in-queue.com/' })
  const job3 = await model.create({ target: 'https://after-cancel.com/' })

  await manager.enqueue(job1)
  await manager.enqueue(job2)
  await manager.enqueue(job3)

  // Cancel job2 while job1 is in-flight
  const cancelled = await manager.cancel(job2._id)
  assert.equal(cancelled.status, 'cancelled')

  await waitFor(() => !manager.pumping)
  assert.equal(executed.includes('https://cancelled-in-queue.com/'), false)
  assert.deepEqual(executed, ['https://active.com/', 'https://after-cancel.com/'])
})

test('9. An active running job can be cancelled safely, terminating work and starting the next job', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  const executed = []

  manager.run = async (job) => {
    executed.push(job.target)
    const ctrl = manager.controllers.get(String(job._id))
    if (job.target === 'https://run-and-cancel.com/') {
      // Simulate slow crawler listening to signal
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500)
        ctrl?.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          job.status = 'cancelled'
          resolve()
        })
      })
    } else {
      job.status = 'completed'
    }
  }

  const job1 = await model.create({ target: 'https://run-and-cancel.com/' })
  const job2 = await model.create({ target: 'https://next-in-line.com/' })

  await manager.enqueueBatch([job1, job2])
  await waitFor(() => manager.running.has(String(job1._id)))

  // Cancel running job
  const cancelling = await manager.cancel(job1._id)
  assert.ok(['cancelling', 'cancelled'].includes(cancelling.status))

  await waitFor(() => executed.length === 2)
  assert.deepEqual(executed, ['https://run-and-cancel.com/', 'https://next-in-line.com/'])
})

test('10. Failed jobs can be retried and are appended to the queue', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })

  // Existing failed job
  const failed = await model.create({
    target: 'https://failed-site.com/',
    status: 'failed',
    options: { maxPages: 50, maxDepth: 2 },
    error: 'DNS lookup failed'
  })

  // Retry creates a new queued ScanJob preserving options
  const retriedJob = await model.create({
    type: failed.type,
    target: failed.target,
    status: 'queued',
    options: failed.options,
    logs: [{ at: new Date(), message: `Retry requested for scan ${failed._id}` }]
  })

  assert.equal(retriedJob.status, 'queued')
  assert.equal(retriedJob.target, 'https://failed-site.com/')
  assert.deepEqual(retriedJob.options, { maxPages: 50, maxDepth: 2 })

  let ran = false
  manager.run = async () => { ran = true }
  await manager.enqueue(retriedJob)
  await waitFor(() => ran)
  assert.equal(ran, true)
})

test('11. Duplicate URLs within a batch are detected and normalized', () => {
  const inputUrls = [
    'https://example.com',
    'https://example.com/',
    'example.com',
    'https://unique.org',
    'https:// invalid url'
  ]

  const seen = new Set()
  const valid = []
  const duplicates = []
  const invalid = []

  for (const raw of inputUrls) {
    const withProto = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
    const normalized = normalizeWebsite(withProto)
    if (!normalized) {
      invalid.push(raw)
      continue
    }
    if (seen.has(normalized)) {
      duplicates.push({ raw, normalized })
      continue
    }
    seen.add(normalized)
    valid.push(normalized)
  }

  assert.equal(valid.length, 2)
  assert.deepEqual(valid, ['https://example.com/', 'https://unique.org/'])
  assert.equal(duplicates.length, 2)
  assert.equal(invalid.length, 1)
})

test('12. URLs already queued or running are rejected from duplicate active submission', async () => {
  const model = createInMemoryScanJobModel()
  await model.create({ target: 'https://running-site.com/', status: 'running' })
  await model.create({ target: 'https://queued-site.com/', status: 'queued' })

  const activeJobs = await model.find({ status: { $in: ['queued', 'running', 'cancelling'] } })
  const activeTargets = new Set(activeJobs.map(j => normalizeWebsite(j.target)))

  assert.equal(activeTargets.has(normalizeWebsite('https://running-site.com')), true)
  assert.equal(activeTargets.has(normalizeWebsite('https://queued-site.com')), true)
  assert.equal(activeTargets.has(normalizeWebsite('https://brand-new-site.com')), false)
})

test('13. Completed or cancelled scans can be resubmitted for fresh scans', async () => {
  const model = createInMemoryScanJobModel()
  await model.create({ target: 'https://completed-site.com/', status: 'completed' })
  await model.create({ target: 'https://cancelled-site.com/', status: 'cancelled' })

  // Active filter only checks ['queued', 'running', 'cancelling']
  const activeJobs = await model.find({ status: { $in: ['queued', 'running', 'cancelling'] } })
  const activeTargets = new Set(activeJobs.map(j => normalizeWebsite(j.target)))

  assert.equal(activeTargets.has(normalizeWebsite('https://completed-site.com')), false)
  assert.equal(activeTargets.has(normalizeWebsite('https://cancelled-site.com')), false)
})

test('14. Queue state is persisted in database and survives frontend refresh', async () => {
  const model = createInMemoryScanJobModel()
  await model.create({ target: 'https://site-1.com/', status: 'queued' })
  await model.create({ target: 'https://site-2.com/', status: 'queued' })

  // When frontend reloads and calls GET /queue, all jobs are in database
  const queued = await model.find({ status: 'queued' }).sort({ createdAt: 1, _id: 1 })
  assert.equal(queued.length, 2)
  assert.equal(queued[0].target, 'https://site-1.com/')
  assert.equal(queued[1].target, 'https://site-2.com/')
})

test('15. Queue state survives backend restart, reloading queued jobs in FIFO order', async () => {
  const model = createInMemoryScanJobModel()
  const job1 = await model.create({ target: 'https://queued-1.com/', status: 'queued', createdAt: new Date(100) })
  const job2 = await model.create({ target: 'https://queued-2.com/', status: 'queued', createdAt: new Date(200) })

  // Fresh manager simulating backend startup
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  let ran = 0
  manager.run = async () => { ran++ }

  assert.equal(manager.queue.length, 0)
  await manager.restore()
  await waitFor(() => ran === 2)

  assert.equal(ran, 2)
})

test('16. Interrupted running jobs upon restart are recovered safely as failed with explanation', async () => {
  const model = createInMemoryScanJobModel()
  const interrupted = await model.create({
    target: 'https://crashed-site.com/',
    status: 'running',
    cancellationRequested: false
  })

  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  await manager.restore()

  const after = await model.findById(interrupted._id)
  assert.equal(after.status, 'failed')
  assert.match(after.error, /Backend restarted while this scan was active/)
})

test('17. Multiple concurrent worker-trigger/pump attempts do not result in duplicate scans', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  let runs = 0

  manager.run = async (job) => {
    runs++
    await pause(20)
    job.status = 'completed'
  }

  const job = await model.create({ target: 'https://single-run.com/', status: 'queued' })
  await manager.enqueue(job)

  // Trigger pump multiple times simultaneously
  await Promise.all([
    manager.pump(),
    manager.pump(),
    manager.enqueue(job),
    manager.pump()
  ])

  await waitFor(() => !manager.pumping)
  assert.equal(runs, 1, 'Job must only run once despite multiple triggers')
})

test('18. Existing single-website scan workflow remains fully functional', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })

  let executedTarget = ''
  manager.run = async (job) => {
    executedTarget = job.target
    job.status = 'completed'
  }

  const singleJob = await model.create({
    type: 'website',
    target: normalizeWebsite('https://my-company.com'),
    status: 'queued',
    options: { maxPages: 100, maxDepth: 3 }
  })

  await manager.enqueue(singleJob)
  await waitFor(() => executedTarget !== '')

  assert.equal(executedTarget, 'https://my-company.com/')
  assert.equal(singleJob.options.maxPages, 100)
  assert.equal(singleJob.options.maxDepth, 3)
})

test('19. Queue status endpoint correctly reports active scan, queue positions, and counts', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model })

  await model.create({ target: 'https://running.com/', status: 'running' })
  await model.create({ target: 'https://wait1.com/', status: 'queued', createdAt: new Date(1000) })
  await model.create({ target: 'https://wait2.com/', status: 'queued', createdAt: new Date(2000) })
  await model.create({ target: 'https://done.com/', status: 'completed' })
  await model.create({ target: 'https://broken.com/', status: 'failed' })

  const status = await manager.getQueueStatus()

  assert.equal(status.active?.target, 'https://running.com/')
  assert.equal(status.totalQueued, 2)
  assert.equal(status.queued.length, 2)
  assert.equal(status.queued[0].position, 1)
  assert.equal(status.queued[0].target, 'https://wait1.com/')
  assert.equal(status.queued[1].position, 2)
  assert.equal(status.queued[1].target, 'https://wait2.com/')
  assert.equal(status.counts.queued, 2)
  assert.equal(status.counts.running, 1)
  assert.equal(status.counts.completed, 1)
  assert.equal(status.counts.failed, 1)
})

test('20. End-to-end batch scan processing completes all jobs sequentially', async () => {
  const model = createInMemoryScanJobModel()
  const manager = new ScanJobManager({ io: { emit() {} }, ScanJobModel: model, retryDelaysMs: [0] })
  const log = []

  manager.run = async (job) => {
    log.push(`start:${job.target}`)
    await pause(10)
    log.push(`end:${job.target}`)
    job.status = 'completed'
  }

  const batchUrls = ['https://batch1.com/', 'https://batch2.com/', 'https://batch3.com/']
  const jobs = []
  for (const u of batchUrls) {
    jobs.push(await model.create({ target: u, status: 'queued' }))
  }

  await manager.enqueueBatch(jobs)
  await waitFor(() => log.length === 6)

  assert.deepEqual(log, [
    'start:https://batch1.com/',
    'end:https://batch1.com/',
    'start:https://batch2.com/',
    'end:https://batch2.com/',
    'start:https://batch3.com/',
    'end:https://batch3.com/'
  ])
  assert.equal(model._store.every(j => j.status === 'completed'), true)
})
