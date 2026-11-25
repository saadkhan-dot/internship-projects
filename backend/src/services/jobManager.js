import { ScanJob, ScanPage, AppSettings, CandidateRecord } from '../models/index.js'
import { getDiscoveryAdapter } from '../discovery/index.js'
import { normalizeWebsite } from '../discovery/url.js'
import { CrawlCancelledError } from '../discovery/fetch.js'
import { calculateProgressPercent, syncJobProgress } from './progress.js'
import { randomUUID } from 'node:crypto'
import { persistCandidate } from './candidatePersistence.js'

const DEFAULTS = { defaultPageLimit: 100, crawlDepth: 3, requestDelay: 1, concurrency: 3, requestTimeoutMs: 10000, sitemapDiscovery: true, internalLinkCrawling: true, queryParameterPolicy: 'preserve' }
const terminal = new Set(['completed', 'failed', 'cancelled'])
const retryDelays = [100, 250, 500, 1000]
export const MAX_PERSISTED_LOGS = 200
export const boundedLogPush = entry => ({ $each: [entry], $slice: -MAX_PERSISTED_LOGS })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const isIntBetween = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const safeFailureReason = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
function validateWorkerConfig(config, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['maxPages', 'maxDepth'].includes(key))) throw new Error('Stored website scan options are invalid.')
  if (options.maxPages !== undefined && !isIntBetween(options.maxPages, 1, 5000)) throw new Error('Stored maxPages must be an integer from 1 to 5000.')
  if (options.maxDepth !== undefined && !isIntBetween(options.maxDepth, 0, 20)) throw new Error('Stored maxDepth must be an integer from 0 to 20.')
  const maxPages = options.maxPages === undefined ? config.defaultPageLimit : options.maxPages
  const maxDepth = options.maxDepth === undefined ? config.crawlDepth : options.maxDepth
  if (!isIntBetween(maxPages, 1, 5000) || !isIntBetween(maxDepth, 0, 20) || !isIntBetween(config.concurrency, 1, 5) || !isIntBetween(config.requestTimeoutMs, 1000, 60000) || typeof config.requestDelay !== 'number' || !Number.isFinite(config.requestDelay) || config.requestDelay < 0 || config.requestDelay > 60) throw new Error('Stored crawler settings are outside supported ranges.')
  if (typeof config.sitemapDiscovery !== 'boolean' || typeof config.internalLinkCrawling !== 'boolean' || !['preserve', 'remove-tracking', 'remove-all'].includes(config.queryParameterPolicy)) throw new Error('Stored crawler settings contain invalid flags or query policy.')
  return { maxPages, maxDepth }
}

export class ScanJobManager {
  constructor({ io, ScanJobModel = ScanJob, ScanPageModel = ScanPage, AppSettingsModel = AppSettings, CandidateRecordModel = CandidateRecord, retryDelaysMs = retryDelays } = {}) {
    this.io = io; this.ScanJob = ScanJobModel; this.ScanPage = ScanPageModel; this.AppSettings = AppSettingsModel; this.CandidateRecord = CandidateRecordModel
    this.retryDelaysMs = retryDelaysMs; this.queue = []; this.pausedQueueIds = new Set(); this.retryCounts = new Map()
    this.controllers = new Map(); this.running = new Set(); this.cancelRequested = new Set(); this.pumping = false; this.databaseAvailable = true
    this.lastQueueError = null
  }
  emit(job) { this.io?.emit ? this.io.emit('scan:update', job.toObject ? job.toObject() : job) : null; return job }
  async enqueue(job) {
    const id = String(job._id)
    if (!this.queue.includes(id) && !this.pausedQueueIds.has(id) && !this.running.has(id)) this.queue.push(id)
    this.pump(); return job
  }
  async enqueueBatch(jobs) {
    for (const job of jobs) {
      const id = String(job._id)
      if (!this.queue.includes(id) && !this.pausedQueueIds.has(id) && !this.running.has(id)) this.queue.push(id)
    }
    this.pump(); return jobs
  }
  async getQueueStatus() {
    let runningJob = null, queuedJobs = [], counts = []
    if (typeof this.ScanJob.findOne === 'function') {
      const q = this.ScanJob.findOne({ status: { $in: ['running', 'cancelling'] } })
      runningJob = typeof q?.sort === 'function' ? await q.sort({ startedAt: -1, createdAt: -1 }) : await q
    }
    if (typeof this.ScanJob.find === 'function') {
      queuedJobs = await this.ScanJob.find({ status: 'queued' }).sort({ createdAt: 1, _id: 1 })
    }
    if (typeof this.ScanJob.aggregate === 'function') {
      counts = await this.ScanJob.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    }
    const statusCounts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
    for (const c of counts) {
      if (c._id in statusCounts) statusCounts[c._id] = c.count
    }
    if (!counts.length && queuedJobs.length) statusCounts.queued = queuedJobs.length
    if (!counts.length && runningJob) statusCounts.running = 1
    const queueWithPositions = (queuedJobs || []).map((job, idx) => {
      const obj = typeof job.toObject === 'function' ? job.toObject() : { ...job }
      obj.position = idx + 1
      return obj
    })
    return {
      active: runningJob ? (typeof runningJob.toObject === 'function' ? runningJob.toObject() : runningJob) : null,
      queued: queueWithPositions,
      totalQueued: (queuedJobs || []).length,
      counts: statusCounts,
    }
  }
  health() { return { status: this.pausedQueueIds.size ? 'degraded' : 'ok', queuedJobs: this.queue.length + this.pausedQueueIds.size, retryingJobs: this.retryCounts.size, pausedJobs: this.pausedQueueIds.size, lastQueueError: this.lastQueueError } }
  setDatabaseAvailable(available) {
    this.databaseAvailable = available
    if (available) {
      if (this.pausedQueueIds.size) { this.queue.unshift(...this.pausedQueueIds); this.pausedQueueIds.clear() }
      this.pump()
    } else {
      for (const controller of this.controllers.values()) controller.abort()
    }
  }
  async restore() {
    await this.reconcileInterrupted('Backend restarted while this scan was active; partial URL results were retained.')
    const jobs = await this.ScanJob.find({ status: 'queued' }).sort({ createdAt: 1, _id: 1 })
    for (const job of jobs) if (!this.queue.includes(String(job._id))) this.queue.push(String(job._id))
    this.pump()
  }
  async reconcileInterrupted(message) {
    const interrupted = await this.ScanJob.find({ status: { $in: ['running', 'cancelling'] } })
    for (const job of interrupted) {
      job.status = job.cancellationRequested ? 'cancelled' : 'failed'
      job.endedAt = new Date()
      job.progress = { ...job.progress, stage: job.status }
      if (!job.cancellationRequested) job.error = message
      job.logs.push({ at: new Date(), message: job.cancellationRequested ? 'Scan stopped during a database interruption; partial URL results were retained.' : message })
      job.logs = job.logs.slice(-MAX_PERSISTED_LOGS)
      syncJobProgress(job)
      await job.save(); this.emit(job)
    }
  }
  async recoverAfterReconnect() {
    this.databaseAvailable = true
    await this.reconcileInterrupted('MongoDB connection was lost while this scan was active; partial URL results were retained.')
    const jobs = await this.ScanJob.find({ status: 'queued' }).sort({ createdAt: 1, _id: 1 })
    const known = new Set([...this.queue, ...this.pausedQueueIds].map(String))
    for (const job of jobs) if (!known.has(String(job._id)) && !this.running.has(String(job._id))) this.queue.push(String(job._id))
    if (this.pausedQueueIds.size) { this.queue.unshift(...this.pausedQueueIds); this.pausedQueueIds.clear() }
    this.pump()
  }
  async cancel(id) {
    id = String(id)
    this.cancelRequested.add(id)
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = await this.ScanJob.findById(id)
      if (!job) { this.cancelRequested.delete(id); return null }
      if (terminal.has(job.status) || job.status === 'cancelling') { this.cancelRequested.delete(id); return job }
      const queued = job.status === 'queued'
      const workerNotStarted = job.status === 'running' && !this.running.has(id)
      const status = queued || workerNotStarted ? 'cancelled' : 'cancelling'
      const progress = { ...job.progress, stage: status }
      progress.percent = calculateProgressPercent(progress, status)
      const filter = { _id: id, status: job.status, cancellationRequested: { $ne: true } }
      const updated = await this.ScanJob.findOneAndUpdate(filter, {
        $set: { status, cancellationRequested: true, ...(queued || workerNotStarted ? { endedAt: new Date() } : {}), progress, pagesProcessed: Number(progress.urlsProcessed) || 0 },
        $push: { logs: boundedLogPush({ at: new Date(), message: 'Cancellation requested.' }) },
      }, { new: true })
      if (!updated) continue
      this.cancelRequested.delete(id)
      this.controllers.get(String(id))?.abort()
      if (queued || workerNotStarted) this.queue = this.queue.filter(item => item !== String(id))
      return this.emit(updated)
    }
    return this.ScanJob.findById(id)
  }
  async claimQueuedJob(id) {
    const token = randomUUID()
    let attempt = 0
    while (true) {
      try {
        if (!this.databaseAvailable) throw new Error('MongoDB is disconnected')
        const existing = await this.ScanJob.findById(id)
        if (this.cancelRequested.has(id)) {
          if (!existing || terminal.has(existing.status) || existing.status === 'cancelling' || existing.cancellationRequested) return null
          const filter = existing.status === 'queued' ? { _id: id, status: 'queued' } : existing.status === 'running' && existing.workerToken === token ? { _id: id, status: 'running', workerToken: token } : null
          if (!filter) return null
          const cancelled = await this.ScanJob.findOneAndUpdate(filter, { $set: { status: 'cancelled', cancellationRequested: true, endedAt: new Date(), progress: { ...existing.progress, stage: 'cancelled', percent: calculateProgressPercent(existing.progress, 'cancelled') } }, $push: { logs: boundedLogPush({ at: new Date(), message: 'Cancellation completed while the job was waiting for worker recovery.' }) } }, { new: true })
          if (cancelled) this.emit(cancelled)
          return null
        }
        if (!existing || terminal.has(existing.status) || existing.status === 'cancelling' || existing.cancellationRequested) return null
        if (existing.status === 'running' && existing.workerToken === token) return existing
        if (existing.status !== 'queued') return null
        const claimed = await this.ScanJob.findOneAndUpdate({ _id: id, status: 'queued', cancellationRequested: false }, {
          $set: { status: 'running', startedAt: new Date(), workerToken: token, progress: { stage: 'starting', urlsDiscovered: 0, urlsProcessed: 0, pagesAttempted: 0, pagesFetched: 0, failedRequests: 0, extractionPagesProcessed: 0, candidatesFound: 0, extractionPagesSkipped: 0, extractionErrors: 0, totalKnown: null, percent: null } },
          $push: { logs: boundedLogPush({ at: new Date(), message: `Website URL discovery started for ${existing.target}${attempt ? ` after ${attempt} database retry attempt(s)` : ''}.` }) },
        }, { new: true })
        if (claimed) return claimed
        // A write can commit even when its acknowledgement is lost. Re-read on
        // the next iteration and accept only this attempt's persisted token.
        const after = await this.ScanJob.findById(id)
        if (after?.status === 'running' && after.workerToken === token) return after
        return null
      } catch (error) {
        attempt++
        this.retryCounts.set(id, attempt)
        const delay = this.retryDelaysMs[attempt - 1]
        if (attempt > this.retryDelaysMs.length) throw error
        this.lastQueueError = error.name || 'Database operation failed'
        console.warn(`Queued scan database retry ${attempt}/${this.retryDelaysMs.length}`, { jobId: id, reason: this.lastQueueError })
        await pause(delay)
      }
    }
  }
  async failUnclaimableJob(id, reason) {
    try {
      const message = `Worker could not recover queued scan after ${this.retryDelaysMs.length + 1} database attempts (${reason}).`
      const job = await this.ScanJob.findOneAndUpdate({ _id: id, status: 'queued' }, {
        $set: { status: 'failed', endedAt: new Date(), error: message, 'progress.stage': 'failed', 'progress.percent': null },
        $push: { logs: boundedLogPush({ at: new Date(), message }) },
      }, { new: true })
      if (!job) return true
      this.emit(job); this.retryCounts.delete(id); this.lastQueueError = null
      return true
    } catch (error) {
      this.lastQueueError = error.name || 'Database operation failed'
      console.error('Queued scan remains persisted and paused after retry limit.', { jobId: id, reason: this.lastQueueError })
      return false
    }
  }
  async pump() {
    if (this.pumping || !this.databaseAvailable) return
    this.pumping = true
    try {
      while (this.queue.length) {
        const id = this.queue[0]
        if (this.running.has(id)) { this.queue.shift(); continue }
        try {
          const job = await this.claimQueuedJob(id)
          this.queue.shift()
          if (!job) { this.cancelRequested.delete(id); continue }
          this.retryCounts.delete(id); this.lastQueueError = null
          this.running.add(id)
          const controller = new AbortController()
          this.controllers.set(id, controller)
          try {
            await this.run(job, { claimed: true, controller })
          } finally {
            this.controllers.delete(id)
            this.running.delete(id)
          }
        } catch (error) {
          this.retryCounts.set(id, this.retryDelaysMs.length + 1)
          if (this.cancelRequested.has(id)) {
            this.queue.shift(); this.pausedQueueIds.add(id)
            this.lastQueueError = error.name || 'Cancellation persistence failed'
            console.error('Queued scan cancellation is waiting for database recovery.', { jobId: id, reason: this.lastQueueError })
            continue
          }
          const recorded = await this.failUnclaimableJob(id, error.name || 'database failure')
          this.queue.shift()
          if (!recorded) this.pausedQueueIds.add(id)
        }
        if (!this.queue.length && this.databaseAvailable && typeof this.ScanJob.find === 'function') {
          try {
            const pending = await this.ScanJob.find({ status: 'queued', cancellationRequested: { $ne: true } }).sort({ createdAt: 1, _id: 1 })
            for (const p of pending) {
              const pId = String(p._id)
              if (!this.queue.includes(pId) && !this.running.has(pId) && !this.pausedQueueIds.has(pId)) {
                this.queue.push(pId)
              }
            }
          } catch {}
        }
      }
    } catch (error) { console.error('Scan queue error:', { reason: error.name || 'queue failure' }) }
    finally { this.pumping = false; if (this.queue.length && this.databaseAvailable) queueMicrotask(() => this.pump()) }
  }
  async run(job, { claimed = false } = {}) {
    const id = String(job._id), controller = new AbortController()
    this.running.add(id); this.controllers.set(id, controller)
    let progress = { ...(job.progress || {}) }
    let writes = Promise.resolve()
    const serialized = fn => { writes = writes.then(fn); return writes }
    const persistProgress = async patch => {
      const set = {}
      for (const [key, value] of Object.entries(patch)) set[`progress.${key}`] = value
      progress = { ...progress, ...patch }
      progress.percent = calculateProgressPercent(progress, 'running')
      set['progress.percent'] = progress.percent
      if (Object.hasOwn(patch, 'urlsProcessed')) set.pagesProcessed = Number(progress.urlsProcessed) || 0
      await this.ScanJob.updateOne({ _id: job._id, status: { $in: ['running', 'cancelling'] } }, { $set: set })
    }
    const log = message => serialized(() => this.ScanJob.updateOne({ _id: job._id, status: { $in: ['running', 'cancelling'] } }, { $push: { logs: boundedLogPush({ at: new Date(), message }) } }))
    const stage = value => serialized(async () => {
      progress = { ...progress, stage: value }
      await this.ScanJob.updateOne({ _id: job._id, status: { $in: ['running', 'cancelling'] } }, { $set: { 'progress.stage': value }, $push: { logs: boundedLogPush({ at: new Date(), message: `Discovery stage: ${value}` }) } })
    })
    const metrics = patch => serialized(async () => {
      const next = {}
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'urlsDiscovered') continue // unique inserts below are the source of truth
        if (['pagesAttempted', 'pagesFetched', 'failedRequests', 'urlsProcessed', 'extractionPagesProcessed', 'candidatesFound', 'extractionPagesSkipped', 'extractionErrors'].includes(key)) next[key] = (Number(progress[key]) || 0) + value
        else next[key] = value
      }
      if (!Object.keys(next).length) return
      await persistProgress(next)
    })
    const onPage = record => serialized(async () => {
      const { processingStatus, httpStatus, contentType, ...discovery } = record
      const insert = { scanId: job._id, ...discovery, discoveredAt: new Date(), ...(processingStatus ? {} : { processingStatus: 'discovered' }) }
      const result = await this.ScanPage.updateOne({ scanId: job._id, normalizedUrl: record.normalizedUrl }, { $setOnInsert: insert, ...(processingStatus ? { $set: { processingStatus, httpStatus, contentType } } : {}) }, { upsert: true })
      if (result.upsertedCount > 0) await persistProgress({ urlsDiscovered: (Number(progress.urlsDiscovered) || 0) + result.upsertedCount })
    })
    const onCandidate = candidate => serialized(() => persistCandidate({ CandidateRecordModel: this.CandidateRecord, ScanPageModel: this.ScanPage, scanJobId: job._id, candidate, syncCrm: false }))
    const finalize = async (fresh, status, error, failureReason) => {
      const progress = { ...fresh.progress, stage: status, percent: calculateProgressPercent(fresh.progress, status) }
      const limited = progress.sitemapDiscovery?.truncated || progress.urlQueueTruncated
      const logMessage = status === 'completed' ? `URL discovery completed${limited ? ' with configured safety limits; results may be incomplete' : ''}. ${progress.urlsDiscovered || 0} URLs discovered.` : status === 'cancelled' ? 'Scan cancelled; discovered URLs were preserved.' : error
      const filter = status === 'cancelled'
        ? { _id: job._id, status: { $in: ['running', 'cancelling'] } }
        : { _id: job._id, status: 'running', cancellationRequested: false }
      const update = { $set: { status, endedAt: new Date(), progress, pagesProcessed: Number(progress.urlsProcessed) || 0 }, $push: { logs: boundedLogPush({ at: new Date(), message: logMessage }) } }
      if (status === 'cancelled') update.$unset = { error: 1, failureReason: 1 }
      else if (error) update.$set.error = error
      if (status === 'failed' && failureReason) update.$set.failureReason = safeFailureReason(failureReason)
      let saved = await this.ScanJob.findOneAndUpdate(filter, update, { new: true })
      if (!saved && status !== 'cancelled') {
        const latest = await this.ScanJob.findById(job._id)
        if (latest?.cancellationRequested || latest?.status === 'cancelling') return finalize(latest, 'cancelled')
        return latest
      }
      if (saved) this.emit(saved)
      return saved
    }
    try {
      const started = claimed ? job : await this.ScanJob.findOneAndUpdate({ _id: job._id, status: 'queued', cancellationRequested: false }, {
        $set: { status: 'running', startedAt: new Date(), progress: { stage: 'starting', urlsDiscovered: 0, urlsProcessed: 0, pagesAttempted: 0, pagesFetched: 0, failedRequests: 0, extractionPagesProcessed: 0, candidatesFound: 0, extractionPagesSkipped: 0, extractionErrors: 0, totalKnown: null, percent: null } },
        $push: { logs: { at: new Date(), message: `Website URL discovery started for ${job.target}` } },
      }, { new: true })
      if (!started) return
      job = started
      this.emit(job)
      if (controller.signal.aborted) throw new CrawlCancelledError()
      const settings = await this.AppSettings.findOne({ key: 'default' })
      const config = { ...DEFAULTS, ...(settings?.toObject() || {}), ...(job.options || {}) }
      if (controller.signal.aborted) throw new CrawlCancelledError()
      const target = normalizeWebsite(job.target)
      if (!target) throw new Error('Website scan requires a valid HTTP or HTTPS URL.')
      if (job.type !== 'website') throw new Error(`Phase 2A URL discovery supports Website scans only; ${job.type} scans are not implemented.`)
      const { maxPages, maxDepth } = validateWorkerConfig(config, job.options || {})
      job.target = target
      const adapter = getDiscoveryAdapter(config.discoveryAdapter || 'builtin')
      await adapter.discover({ siteUrl: target, options: { maxPages, maxDepth, maxQueuedUrls: config.maxQueuedUrls || Math.max(5000, maxPages * 10), maxHtmlBytes: 2_000_000, maxSitemapBytes: 5_000_000, sitemapEntries: 20000, sitemapIndexChildren: 100, sitemapSources: 30, concurrency: config.concurrency, requestDelay: config.requestDelay, requestTimeoutMs: config.requestTimeoutMs, sitemapDiscovery: config.sitemapDiscovery, internalLinkCrawling: config.internalLinkCrawling, queryParameterPolicy: config.queryParameterPolicy, allowLocalFixtures: process.env.NODE_ENV === 'test' && process.env.LEADINTEL_ALLOW_LOCAL_FIXTURES === 'true' }, signal: controller.signal, onLog: log, onStage: stage, onMetrics: metrics, onPage, onCandidate })
      await writes
      const fresh = await this.ScanJob.findById(job._id)
      if (fresh) {
        if (controller.signal.aborted || fresh.cancellationRequested || fresh.status === 'cancelling') await finalize(fresh, 'cancelled')
        else if ((fresh.progress.pagesAttempted || 0) > 0 && (fresh.progress.pagesFetched || 0) === 0) {
          const requestFailure = [...(fresh.logs || [])].reverse().find(entry => /^Request failed for /.test(entry.message || ''))
          const reason = requestFailure?.message?.match(/^Request failed for .*?: (.*)$/)?.[1]
          await finalize(fresh, 'failed', 'No HTML pages could be fetched.', reason)
        }
        else await finalize(fresh, 'completed')
      }
    } catch (error) {
      await writes.catch(() => {})
      const fresh = await this.ScanJob.findById(job._id)
      if (fresh) {
        const cancelled = controller.signal.aborted || error instanceof CrawlCancelledError || fresh.cancellationRequested || fresh.status === 'cancelling'
        await finalize(fresh, cancelled ? 'cancelled' : 'failed', cancelled ? undefined : `Scan failed: ${safeFailureReason(error.message)}`, cancelled ? undefined : error.message)
      }
    } finally { this.controllers.delete(id); this.running.delete(id) }
  }
}
