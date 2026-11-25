import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: resolve(__dirname, '../.env') })

import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { AppSettings, CandidateRecord, CompanyProfile, Lead, PersonProfile, ScanJob, ScanPage } from './models/index.js'
import { ScanJobManager } from './services/jobManager.js'
import { normalizeWebsite } from './discovery/url.js'
import { generateCsv } from './utils/csv.js'
import { normalizeDomain } from './utils/domain.js'
import { cleanupScanData, resetAllHistoryAndCrmData } from './services/historyCleanup.js'
import { executeContactExtraction, isCandidateVerified } from './services/contactExtraction.js'
import { promoteCandidates, promoteSingleCandidate } from './services/crmPromotion.js'
import { cleanText, normalizeEmail, normalizePhone, normalizeLinkedInUrl, makeWhitespaceFlexibleRegex } from './extraction/normalization.js'

const app = express()
const server = createServer(app)
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
const allowedOrigins = new Set([
  clientOrigin,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
].filter(Boolean))

const allowOrigin = (origin, callback) => {
  if (!origin || allowedOrigins.has(origin)) return callback(null, true)
  try {
    const { hostname } = new URL(origin)
    if (hostname === 'localhost' || hostname === '127.0.0.1') return callback(null, true)
  } catch {
    // fallback to reject non-local unknown origins
  }
  return callback(null, false)
}
const io = new Server(server, { cors: { origin: allowOrigin } })
const jobs = new ScanJobManager({ io })
app.use(cors({ origin: allowOrigin }))
app.use(express.json({ limit: '1mb' }))

let dbReady = false
let dbInitialized = false
let dbRecovery = null
let dbRecoveryTimer = null
let dbRecoveryAttempt = 0
let mongoConnectPromise = null
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/leadintel'
const isDatabaseReady = () => dbReady && mongoose.connection.readyState === 1
const requireDb = (req, res, next) => isDatabaseReady() ? next() : res.status(503).json({ error: 'Database unavailable. The backend will resume when MongoDB reconnects.', dbConnected: false })
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
app.get('/api/health', (req, res) => {
  const dbConnected = isDatabaseReady()
  const worker = jobs.health()
  res.status(dbConnected && worker.status === 'ok' ? 200 : 503).json({ status: dbConnected && worker.status === 'ok' ? 'ok' : 'degraded', dbConnected, worker })
})
app.use('/api', requireDb)

function validateScanOptions(options) {
  if (options === undefined) return { valid: true, options: {} }
  if (!options || typeof options !== 'object' || Array.isArray(options)) return { valid: false, error: 'Scan options must be an object.' }
  const unknownOptions = Object.keys(options).filter(key => !['maxPages', 'maxDepth'].includes(key))
  if (unknownOptions.length) return { valid: false, error: `Unsupported scan option(s): ${unknownOptions.join(', ')}.` }
  const validInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
  if (options.maxPages !== undefined && !validInteger(options.maxPages, 1, 5000)) return { valid: false, error: 'maxPages must be an integer from 1 to 5000.' }
  if (options.maxDepth !== undefined && !validInteger(options.maxDepth, 0, 20)) return { valid: false, error: 'maxDepth must be an integer from 0 to 20.' }
  return { valid: true, options }
}

async function isWebsiteActive(normalizedTarget) {
  if (!normalizedTarget) return false
  const activeJobs = await ScanJob.find({ status: { $in: ['queued', 'running', 'cancelling'] } }).select('target')
  for (const job of activeJobs) {
    const jobNormalized = normalizeWebsite(job.target)
    if (jobNormalized && jobNormalized === normalizedTarget) {
      return true
    }
  }
  return false
}

app.get('/api/queue', asyncRoute(async (req, res) => {
  const queueStatus = await jobs.getQueueStatus()
  res.json(queueStatus)
}))

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const [totalLeads, people, companies, completedScans, recentScans] = await Promise.all([Lead.countDocuments(), PersonProfile.countDocuments(), CompanyProfile.countDocuments(), ScanJob.countDocuments({ status: 'completed' }), ScanJob.find().sort({ createdAt: -1 }).limit(6)])
  res.json({ totalLeads, people, companies, completedScans, recentScans })
}))

app.post('/api/scans/batch', asyncRoute(async (req, res) => {
  const rawUrls = req.body?.urls || req.body?.targets
  if (!Array.isArray(rawUrls) || !rawUrls.length) {
    return res.status(400).json({ error: 'Please provide an array of website URLs to scan.' })
  }
  if (rawUrls.length > 500) {
    return res.status(400).json({ error: 'Batch submission is limited to 500 URLs per request.' })
  }
  const optsRes = validateScanOptions(req.body?.options)
  if (!optsRes.valid) return res.status(400).json({ error: optsRes.error })

  const activeJobs = await ScanJob.find({ status: { $in: ['queued', 'running', 'cancelling'] } }).select('target')
  const activeTargets = new Set(activeJobs.map(j => normalizeWebsite(j.target)).filter(Boolean))

  const seenInBatch = new Set()
  const invalid = []
  const duplicatesInBatch = []
  const alreadyActive = []
  const toCreate = []

  for (const item of rawUrls) {
    const raw = String(item || '').trim()
    if (!raw) continue
    const withProto = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
    const normalized = normalizeWebsite(withProto)
    if (!normalized) {
      invalid.push({ url: raw, reason: 'Invalid HTTP or HTTPS URL' })
      continue
    }
    if (seenInBatch.has(normalized)) {
      duplicatesInBatch.push({ url: raw, normalizedUrl: normalized })
      continue
    }
    seenInBatch.add(normalized)
    if (activeTargets.has(normalized)) {
      alreadyActive.push({ url: raw, normalizedUrl: normalized, reason: 'Website is already queued or currently running' })
      continue
    }
    toCreate.push({ rawUrl: raw, normalizedUrl: normalized })
  }

  if (!toCreate.length) {
    return res.status(409).json({
      error: 'No new unique website URLs to queue.',
      invalid,
      duplicatesInBatch,
      alreadyActive,
      totalQueued: 0,
    })
  }

  const createdJobs = []
  for (const item of toCreate) {
    const job = await ScanJob.create({
      type: 'website',
      target: item.normalizedUrl,
      status: 'queued',
      options: optsRes.options,
      logs: [{ at: new Date(), message: 'Job queued for discovery via batch submission.' }]
    })
    createdJobs.push(job)
  }

  await jobs.enqueueBatch(createdJobs)

  res.status(201).json({
    created: createdJobs,
    totalCreated: createdJobs.length,
    invalid,
    duplicatesInBatch,
    alreadyActive,
    totalQueued: createdJobs.length,
  })
}))

app.post('/api/scans', asyncRoute(async (req, res) => {
  const { type, target } = req.body || {}
  if (!['website', 'sitemap', 'individual', 'company'].includes(type) || !String(target || '').trim()) return res.status(400).json({ error: 'Choose a scan type and enter a target.' })
  const trimmedTarget = String(target).trim()
  const withProto = trimmedTarget.startsWith('http://') || trimmedTarget.startsWith('https://') ? trimmedTarget : `https://${trimmedTarget}`
  const normalized = normalizeWebsite(type === 'website' ? withProto : trimmedTarget)
  if (type === 'website') {
    if (!normalized) return res.status(400).json({ error: 'Enter a valid HTTP or HTTPS website URL.' })
    if (await isWebsiteActive(normalized)) {
      return res.status(409).json({ error: 'This website is already queued or currently running.' })
    }
  }
  const optsRes = validateScanOptions(req.body?.options)
  if (!optsRes.valid) return res.status(400).json({ error: optsRes.error })

  const finalTarget = type === 'website' ? normalized : trimmedTarget
  const job = await ScanJob.create({ type, target: finalTarget, status: 'queued', options: optsRes.options, logs: [{ at: new Date(), message: 'Job queued for discovery.' }] })
  if (type !== 'website') {
    job.status = 'failed'; job.endedAt = new Date(); job.error = 'Phase 2A implements Website URL discovery only.'; job.progress.stage = 'failed'; job.logs.push({ at: new Date(), message: job.error }); await job.save()
  } else await jobs.enqueue(job)
  res.status(201).json(job)
}))

app.post('/api/scans/:id/retry', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })
  const original = await ScanJob.findById(req.params.id)
  if (!original) return res.status(404).json({ error: 'Scan not found.' })
  if (['queued', 'running', 'cancelling'].includes(original.status)) {
    return res.status(400).json({ error: 'Scan is currently active or queued.' })
  }
  const normalized = normalizeWebsite(original.target)
  if (normalized && await isWebsiteActive(normalized)) {
    return res.status(409).json({ error: 'This website is already queued or currently running.' })
  }
  const newJob = await ScanJob.create({
    type: original.type,
    target: original.target,
    status: 'queued',
    options: original.options || {},
    logs: [{ at: new Date(), message: `Retry requested for scan ${original._id}. Job queued for discovery.` }]
  })
  await jobs.enqueue(newJob)
  res.status(201).json(newJob)
}))

function formatDuration(startedAt, endedAt) {
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  const end = endedAt ? new Date(endedAt).getTime() : Date.now()
  const diffSec = Math.max(0, Math.floor((end - start) / 1000))
  if (diffSec < 60) return `${diffSec}s`
  const mins = Math.floor(diffSec / 60)
  const secs = diffSec % 60
  if (mins < 60) return `${mins}m ${secs}s`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${mins % 60}m`
}

function enrichScanJob(job) {
  const obj = job.toObject ? job.toObject() : { ...job }
  const started = obj.startedAt || obj.createdAt
  const ended = obj.endedAt
  obj.durationMs = started ? Math.max(0, (ended ? new Date(ended).getTime() : Date.now()) - new Date(started).getTime()) : 0
  obj.durationFormatted = formatDuration(started, ended)
  return obj
}

function buildLeadFilter(query = {}) {
  const filter = {}
  if (query.ids || query.selectedIds) {
    const rawIds = query.ids || query.selectedIds
    const idList = (Array.isArray(rawIds) ? rawIds : String(rawIds).split(','))
      .map(id => id.trim())
      .filter(id => mongoose.isValidObjectId(id))
    filter._id = { $in: idList }
  }
  if (query.type) filter.entityType = query.type
  if (query.scanId && mongoose.isValidObjectId(query.scanId)) filter.scanId = query.scanId
  if (query.companyId && mongoose.isValidObjectId(query.companyId)) filter.companyId = query.companyId
  if (query.status) filter.status = query.status

  if (query.hasEmail === 'true' || query.hasEmail === true) {
    filter.email = { $exists: true, $nin: [null, ''] }
  }
  if (query.hasPhone === 'true' || query.hasPhone === true) {
    filter.phone = { $exists: true, $nin: [null, ''] }
  }
  if (query.hasLinkedIn === 'true' || query.hasLinkedIn === true) {
    filter.linkedinUrl = { $exists: true, $nin: [null, ''] }
  }
  if (query.sourceUrl) {
    filter.sourceUrl = { $regex: String(query.sourceUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  }
  if (query.company && !query.companyId) {
    filter.company = { $regex: String(query.company).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  }
  if (query.title || query.designation) {
    filter.title = { $regex: String(query.title || query.designation).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  }
  if (query.name) {
    filter.name = { $regex: String(query.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  }
  if (query.email) {
    filter.email = { $regex: String(query.email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  }
  if (query.phone) {
    filter.phone = { $regex: String(query.phone).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  }

  const searchTerm = query.search || query.q
  if (searchTerm) {
    const escaped = String(searchTerm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    filter.$or = ['name', 'email', 'company', 'title', 'phone'].map(key => ({ [key]: new RegExp(escaped, 'i') }))
  }

  return filter
}

async function getEnrichedCompanies(query = {}) {
  const filter = {}
  const searchTerm = query.search || query.q
  if (searchTerm) {
    const escaped = String(searchTerm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    filter.$or = [
      { name: new RegExp(escaped, 'i') },
      { domain: new RegExp(escaped, 'i') },
      { website: new RegExp(escaped, 'i') },
    ]
  }

  const companies = await CompanyProfile.find(filter).sort({ name: 1 })
  const companyIds = companies.map(c => c._id)

  // Aggregate leads coverage per company
  const leadsAggregation = await Lead.aggregate([
    { $match: { companyId: { $in: companyIds } } },
    {
      $group: {
        _id: '$companyId',
        totalLeads: { $sum: 1 },
        emailCount: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$email', null] }, { $ne: ['$email', ''] }] },
              1,
              0,
            ],
          },
        },
        phoneCount: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$phone', null] }, { $ne: ['$phone', ''] }] },
              1,
              0,
            ],
          },
        },
        linkedInCount: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$linkedinUrl', null] }, { $ne: ['$linkedinUrl', ''] }] },
              1,
              0,
            ],
          },
        },
      },
    },
  ])

  const statsMap = new Map()
  for (const stat of leadsAggregation) {
    statsMap.set(String(stat._id), stat)
  }

  let enriched = companies.map(comp => {
    const stat = statsMap.get(String(comp._id)) || {
      totalLeads: comp.totalLeads || 0,
      emailCount: 0,
      phoneCount: 0,
      linkedInCount: 0,
    }
    const obj = comp.toObject ? comp.toObject() : { ...comp }
    obj.totalLeads = stat.totalLeads || comp.totalLeads || 0
    obj.emailCount = stat.emailCount || (comp.email ? 1 : 0)
    obj.phoneCount = stat.phoneCount || (comp.phone ? 1 : 0)
    obj.linkedInCount = stat.linkedInCount || (comp.linkedinUrl ? 1 : 0)
    return obj
  })

  if (query.hasEmail === 'true') {
    enriched = enriched.filter(c => c.emailCount > 0)
  }
  if (query.hasPhone === 'true') {
    enriched = enriched.filter(c => c.phoneCount > 0)
  }
  if (query.hasLinkedIn === 'true') {
    enriched = enriched.filter(c => c.linkedInCount > 0)
  }

  return enriched
}

app.get('/api/history', asyncRoute(async (req, res) => {
  const filter = {}
  if (req.query.status) filter.status = req.query.status
  if (req.query.type) filter.type = req.query.type
  const searchTerm = req.query.search || req.query.q
  if (searchTerm) {
    filter.target = { $regex: String(searchTerm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  }

  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20))
  const skip = (page - 1) * limit
  const sortField = req.query.sortBy || 'createdAt'
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1

  const [rawItems, total, totalAll, completed, running, queued, failed, cancelled] = await Promise.all([
    ScanJob.find(filter).sort({ [sortField]: sortOrder }).skip(skip).limit(limit),
    ScanJob.countDocuments(filter),
    ScanJob.countDocuments(),
    ScanJob.countDocuments({ status: 'completed' }),
    ScanJob.countDocuments({ status: 'running' }),
    ScanJob.countDocuments({ status: 'queued' }),
    ScanJob.countDocuments({ status: 'failed' }),
    ScanJob.countDocuments({ status: 'cancelled' }),
  ])

  const items = rawItems.map(enrichScanJob)
  res.json({
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    summary: {
      total: totalAll,
      completed,
      running,
      queued,
      failed,
      cancelled,
    },
  })
}))

app.get('/api/history/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })
  const job = await ScanJob.findById(req.params.id)
  if (!job) return res.status(404).json({ error: 'Scan not found.' })

  const [pagesCount, candidatesCount, leadsCount] = await Promise.all([
    ScanPage.countDocuments({ scanId: job._id }),
    CandidateRecord.countDocuments({ scanJobId: job._id }),
    Lead.countDocuments({ scanId: job._id }),
  ])

  const enriched = enrichScanJob(job)
  enriched.pagesCount = pagesCount
  enriched.candidatesCount = candidatesCount
  enriched.leadsCount = leadsCount
  res.json(enriched)
}))

app.delete('/api/history/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })
  const job = await ScanJob.findById(req.params.id)
  if (!job) return res.status(404).json({ error: 'Scan not found.' })
  if (['queued', 'running', 'cancelling'].includes(job.status)) {
    return res.status(409).json({ error: 'Cannot delete an active or queued scan.' })
  }

  const cleanup = await cleanupScanData([job._id])

  res.json({
    success: true,
    message: 'Scan history session deleted.',
    cleanup,
  })
}))

app.delete('/api/history', asyncRoute(async (req, res) => {
  // Clear All History: Completely resets all scan history, crawl cache, candidate records, and CRM data.
  const activeCount = await ScanJob.countDocuments({
    status: { $in: ['queued', 'running', 'cancelling'] },
  })

  if (activeCount > 0) {
    return res.status(409).json({
      error: 'Cannot clear history while scans are actively running or queued. Please cancel or allow active scans to finish first.',
      activeCount,
    })
  }

  const cleanup = await resetAllHistoryAndCrmData()

  res.json({
    success: true,
    deletedCount: cleanup.deletedScans,
    message: 'All scan history, discovered candidates, and CRM records have been completely cleared.',
    cleanup,
  })
}))

app.delete('/api/scans/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })
  const job = await ScanJob.findById(req.params.id)
  if (!job) return res.status(404).json({ error: 'Scan not found.' })
  if (['queued', 'running', 'cancelling'].includes(job.status)) {
    return res.status(409).json({ error: 'Cannot delete an active or queued scan.' })
  }

  const cleanup = await cleanupScanData([job._id])

  res.json({
    success: true,
    message: 'Scan deleted.',
    cleanup,
  })
}))

app.get('/api/scans', asyncRoute(async (req, res) => {
  const filter = {}
  if (req.query.status) filter.status = req.query.status
  if (req.query.type) filter.type = req.query.type
  const searchTerm = req.query.search || req.query.q
  if (searchTerm) {
    filter.target = { $regex: String(searchTerm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  }

  if (req.query.page || req.query.paginated === 'true') {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20))
    const skip = (page - 1) * limit
    const [rawItems, total] = await Promise.all([
      ScanJob.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      ScanJob.countDocuments(filter),
    ])
    const items = rawItems.map(enrichScanJob)
    return res.json({ items, total, page, limit, totalPages: Math.ceil(total / limit) || 1 })
  }

  const jobs = await ScanJob.find(filter).sort({ createdAt: -1 })
  res.json(jobs.map(enrichScanJob))
}))
app.get('/api/scans/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })
  const job = await ScanJob.findById(req.params.id)
  return job ? res.json(enrichScanJob(job)) : res.status(404).json({ error: 'Scan not found.' })
}))
app.get('/api/scans/:id/logs', asyncRoute(async (req, res) => { const job = await ScanJob.findById(req.params.id).select('logs'); return job ? res.json(job.logs) : res.status(404).json({ error: 'Scan not found.' }) }))
app.get('/api/scans/:id/pages', asyncRoute(async (req, res) => {
  const filter = { scanId: req.params.id }
  if (req.query.source) filter.source = req.query.source
  if (req.query.status) filter.processingStatus = req.query.status
  if (req.query.q) filter.url = { $regex: String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200))
  const skip = Math.max(0, Math.min(5000, Number(req.query.skip) || 0))
  const [items, total] = await Promise.all([ScanPage.find(filter).sort({ discoveredAt: 1 }).skip(skip).limit(limit), ScanPage.countDocuments(filter)])
  res.json({ items, total, limit, skip })
}))
app.get('/api/scans/:id/candidates', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })
  const allowedTypes = ['person', 'company', 'organization', 'unknown']
  const allowedStatuses = ['candidate', 'needs_review', 'validated', 'rejected']
  if (req.query.type && !allowedTypes.includes(req.query.type)) return res.status(400).json({ error: 'Invalid candidate type.' })
  if (req.query.status && !allowedStatuses.includes(req.query.status)) return res.status(400).json({ error: 'Invalid extraction status.' })
  const filter = { scanJobId: req.params.id }
  if (req.query.type) filter.candidateType = req.query.type
  if (req.query.status) filter.extractionStatus = req.query.status
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100))
  const skip = Math.max(0, Math.min(10000, Number(req.query.skip) || 0))
  const [items, total] = await Promise.all([
    CandidateRecord.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit),
    CandidateRecord.countDocuments(filter),
  ])
  res.json({ items, total, limit, skip })
}))
app.get('/api/scans/:id/profiles', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })

  const allScanCandidates = await CandidateRecord.find({ scanJobId: req.params.id, candidateType: 'person' }).lean()
  const counts = {
    all: allScanCandidates.length,
    shortlisted: allScanCandidates.filter(c => c.shortlisted).length,
    extracted: allScanCandidates.filter(c => c.extractionStatus === 'completed' || c.extractionStatus === 'needs_review' || Boolean(c.fields?.email) || Boolean(c.fields?.phone)).length,
    verified: allScanCandidates.filter(c => isCandidateVerified(c)).length,
    unverified: allScanCandidates.filter(c => !isCandidateVerified(c)).length,
    promoted: allScanCandidates.filter(c => c.promoted).length,
  }

  const filter = { scanJobId: req.params.id, candidateType: 'person' }
  if (req.query.shortlisted !== undefined) {
    if (req.query.shortlisted === 'true' || req.query.shortlisted === true) {
      filter.shortlisted = true
    } else if (req.query.shortlisted === 'false' || req.query.shortlisted === false) {
      filter.shortlisted = false
    }
  }

  if (req.query.category) {
    if (req.query.category === 'verified') {
      const verifiedIds = allScanCandidates.filter(c => isCandidateVerified(c)).map(c => c._id)
      filter._id = { $in: verifiedIds }
    } else if (req.query.category === 'unverified') {
      const unverifiedIds = allScanCandidates.filter(c => !isCandidateVerified(c)).map(c => c._id)
      filter._id = { $in: unverifiedIds }
    } else if (req.query.category === 'extracted') {
      const extractedIds = allScanCandidates.filter(c => c.extractionStatus === 'completed' || c.extractionStatus === 'needs_review' || Boolean(c.fields?.email) || Boolean(c.fields?.phone)).map(c => c._id)
      filter._id = { $in: extractedIds }
    }
  }

  if (req.query.q) {
    const escaped = String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    filter.$or = [
      { 'fields.full_name': new RegExp(escaped, 'i') },
      { 'fields.designation': new RegExp(escaped, 'i') },
      { 'fields.company': new RegExp(escaped, 'i') },
    ]
  }
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
  const skip = Math.max(0, Math.min(10000, Number(req.query.skip) || 0))

  const [docs, total] = await Promise.all([
    CandidateRecord.find(filter)
      .sort({ confidenceScore: -1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CandidateRecord.countDocuments(filter),
  ])

  const items = docs.map(c => ({
    _id: c._id,
    id: c._id,
    name: c.fields?.full_name || null,
    title: c.fields?.designation || null,
    designation: c.fields?.designation || null,
    company: c.fields?.company || null,
    email: c.fields?.email || null,
    phone: c.fields?.phone || null,
    profileUrl: c.fields?.profile_url || null,
    sourceUrl: c.sourceUrl || c.fields?.source_url || null,
    biography: c.fields?.biography || null,
    profileImageUrl: c.fields?.profile_image_url || null,
    linkedinUrl: c.fields?.linkedin_url || null,
    confidenceScore: c.confidenceScore ?? (c.fields?.score || 1),
    shortlisted: Boolean(c.shortlisted),
    promoted: Boolean(c.promoted),
    leadId: c.leadId || null,
    extractionStatus: c.extractionStatus || 'candidate',
    validationStatus: c.validationStatus || 'unverified',
    classification: isCandidateVerified(c) ? 'verified' : 'unverified',
    isVerified: isCandidateVerified(c),
    provenance: c.provenance || [],
    extractionError: c.fields?.extractionError || null,
  }))

  res.json({ items, total, limit, skip, counts })
}))

const handleBulkShortlist = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })
  const scan = await ScanJob.findById(req.params.id)
  if (!scan) return res.status(404).json({ error: 'Scan not found.' })

  const { shortlistAll, removeAll, action, candidateIds } = req.body || {}
  let shortlistedValue = req.body?.shortlisted

  if (shortlistAll === true || action === 'shortlist_all') {
    shortlistedValue = true
  } else if (removeAll === true || action === 'remove_all') {
    shortlistedValue = false
  }

  if (typeof shortlistedValue !== 'boolean' && !Array.isArray(candidateIds)) {
    return res.status(400).json({ error: 'Must provide boolean "shortlisted", "shortlistAll", "removeAll", or "candidateIds" array.' })
  }

  let query = { scanJobId: req.params.id, candidateType: 'person' }
  if (Array.isArray(candidateIds) && candidateIds.length > 0) {
    for (const cid of candidateIds) {
      if (!mongoose.isValidObjectId(cid)) return res.status(400).json({ error: `Invalid candidate ID: ${cid}` })
    }
    query._id = { $in: candidateIds }
  }

  const targetShortlist = shortlistedValue !== undefined ? Boolean(shortlistedValue) : true
  const updateResult = await CandidateRecord.updateMany(query, { $set: { shortlisted: targetShortlist } })

  const [totalShortlisted, totalCandidates] = await Promise.all([
    CandidateRecord.countDocuments({ scanJobId: req.params.id, candidateType: 'person', shortlisted: true }),
    CandidateRecord.countDocuments({ scanJobId: req.params.id, candidateType: 'person' }),
  ])

  res.json({
    success: true,
    action: targetShortlist ? 'shortlist_all' : 'remove_all',
    shortlisted: targetShortlist,
    modifiedCount: updateResult.modifiedCount,
    totalShortlisted,
    totalCandidates,
    scanJobId: req.params.id,
  })
}

app.patch('/api/scans/:id/profiles/shortlist', asyncRoute(handleBulkShortlist))
app.post('/api/scans/:id/profiles/shortlist', asyncRoute(handleBulkShortlist))

app.patch('/api/scans/:id/profiles/:candidateId/shortlist', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })
  if (!mongoose.isValidObjectId(req.params.candidateId)) return res.status(400).json({ error: 'Invalid candidate ID.' })

  if (typeof req.body?.shortlisted !== 'boolean') {
    return res.status(400).json({ error: 'Field "shortlisted" must be an explicit boolean.' })
  }

  const candidate = await CandidateRecord.findOne({
    _id: req.params.candidateId,
    scanJobId: req.params.id,
  })

  if (!candidate) {
    return res.status(404).json({ error: 'Candidate not found for this scan.' })
  }

  if (candidate.candidateType !== 'person') {
    return res.status(400).json({ error: 'Only person candidates can be shortlisted.' })
  }

  candidate.shortlisted = req.body.shortlisted
  await candidate.save()

  res.json({
    _id: candidate._id,
    id: candidate._id,
    shortlisted: candidate.shortlisted,
    scanJobId: candidate.scanJobId,
    name: candidate.fields?.full_name,
  })
}))
app.post('/api/scans/:id/extract-contacts', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })

  const scan = await ScanJob.findById(req.params.id)
  if (!scan) return res.status(404).json({ error: 'Scan not found.' })

  const { candidateIds, allShortlisted } = req.body || {}

  let candidates = []

  if (Array.isArray(candidateIds) && candidateIds.length > 0) {
    for (const cid of candidateIds) {
      if (!mongoose.isValidObjectId(cid)) return res.status(400).json({ error: `Invalid candidate ID: ${cid}` })
    }

    candidates = await CandidateRecord.find({ _id: { $in: candidateIds } })

    // Validate ownership: every requested candidate must belong to this scan
    const mismatch = candidates.some(c => String(c.scanJobId) !== String(req.params.id))
    if (mismatch || candidates.length !== candidateIds.length) {
      return res.status(400).json({ error: 'One or more candidates do not belong to this scan.' })
    }

    // Validate shortlisted: Level 2 must operate exclusively on shortlisted candidates
    const nonShortlisted = candidates.some(c => !c.shortlisted)
    if (nonShortlisted) {
      return res.status(400).json({ error: 'Level 2 extraction operates exclusively on shortlisted candidates.' })
    }

    // Validate candidateType
    const nonPerson = candidates.some(c => c.candidateType !== 'person')
    if (nonPerson) {
      return res.status(400).json({ error: 'Only person candidates can be processed for contact extraction.' })
    }
  } else if (allShortlisted === true) {
    candidates = await CandidateRecord.find({
      scanJobId: req.params.id,
      candidateType: 'person',
      shortlisted: true,
    })

    if (candidates.length === 0) {
      return res.status(400).json({ error: 'No shortlisted candidates found for this scan.' })
    }
  } else {
    return res.status(400).json({ error: 'Must provide candidateIds array or set allShortlisted: true.' })
  }

  // Execute extraction with controlled concurrency
  const results = await executeContactExtraction(candidates, {
    concurrency: 3,
    allowLocalFixtures: process.env.NODE_ENV === 'test' || process.env.LEADINTEL_ALLOW_LOCAL_FIXTURES === 'true',
  })

  // Format return projection
  const projectedItems = results.items.map(c => ({
    _id: c._id,
    id: c._id,
    name: c.fields?.full_name || null,
    title: c.fields?.designation || null,
    company: c.fields?.company || null,
    email: c.fields?.email || null,
    phone: c.fields?.phone || null,
    linkedinUrl: c.fields?.linkedin_url || null,
    biography: c.fields?.biography || null,
    profileUrl: c.fields?.profile_url || null,
    sourceUrl: c.sourceUrl || c.fields?.source_url || null,
    confidenceScore: c.confidenceScore,
    shortlisted: c.shortlisted,
    extractionStatus: c.extractionStatus,
    validationStatus: c.validationStatus,
    provenance: c.provenance || [],
    extractionError: c.fields?.extractionError || null,
  }))

  res.json({
    success: true,
    total: results.total,
    completed: results.completed,
    needsReview: results.needsReview,
    failed: results.failed,
    items: projectedItems,
  })
}))
app.post('/api/scans/:id/promote', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid scan ID.' })
  const scan = await ScanJob.findById(req.params.id)
  if (!scan) return res.status(404).json({ error: 'Scan not found.' })

  const { candidateIds, candidateId, allShortlisted, category } = req.body || {}

  let idsToPromote = []
  if (candidateId) {
    idsToPromote = [candidateId]
  } else if (Array.isArray(candidateIds) && candidateIds.length > 0) {
    idsToPromote = candidateIds
  }

  let result
  if (idsToPromote.length > 0) {
    for (const cid of idsToPromote) {
      if (!mongoose.isValidObjectId(cid)) return res.status(400).json({ error: `Invalid candidate ID: ${cid}` })
    }

    const candidates = await CandidateRecord.find({ _id: { $in: idsToPromote } })
    if (candidates.length !== idsToPromote.length || candidates.some(c => String(c.scanJobId) !== String(req.params.id))) {
      return res.status(400).json({ error: 'One or more requested candidates do not belong to this scan.' })
    }

    result = await promoteCandidates({
      scanJobId: req.params.id,
      candidateIds: idsToPromote,
    })
  } else if (category) {
    result = await promoteCandidates({
      scanJobId: req.params.id,
      category,
    })
  } else if (allShortlisted === true) {
    result = await promoteCandidates({
      scanJobId: req.params.id,
      allShortlisted: true,
    })
  } else {
    // Backward compatibility: promote all candidates for scan
    const allCandidates = await CandidateRecord.find({ scanJobId: req.params.id })
    const allIds = allCandidates.map(c => c._id)
    if (allIds.length === 0) {
      return res.json({ success: true, total: 0, promoted: 0, reused: 0, alreadyPromoted: 0, failed: 0, items: [], totalLeads: 0 })
    }
    result = await promoteCandidates({
      scanJobId: req.params.id,
      candidateIds: allIds,
    })
  }

  const totalLeads = await Lead.countDocuments({ scanId: req.params.id })
  await ScanJob.updateOne({ _id: req.params.id }, { leadsFound: totalLeads })

  res.json({
    success: true,
    promoted: result.promoted,
    reused: result.reused,
    alreadyPromoted: result.alreadyPromoted,
    total: result.total,
    failed: result.failed,
    items: result.items,
    totalLeads,
  })
}))
app.post('/api/scans/:id/cancel', asyncRoute(async (req, res) => { const job = await jobs.cancel(req.params.id); return job ? res.json(job) : res.status(404).json({ error: 'Scan not found.' }) }))

const LEAD_CSV_COLUMNS = [
  { key: 'name', label: 'Full Name' },
  { key: 'title', label: 'Designation' },
  { key: 'company', label: 'Company' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'linkedinUrl', label: 'LinkedIn' },
  { key: 'status', label: 'Lead Status' },
  {
    key: 'sourceWebsite',
    label: 'Source Website',
    getter: l => l.sourceWebsite || (l.sourceUrl ? (() => { try { return new URL(l.sourceUrl).origin } catch { return '' } })() : ''),
  },
  { key: 'sourceUrl', label: 'Profile URL' },
  {
    key: 'discoveredAt',
    label: 'Date Discovered',
    getter: l => l.discoveredAt ? new Date(l.discoveredAt).toISOString() : '',
  },
  { key: 'biography', label: 'Biography' },
  { key: 'notes', label: 'Notes' },
]

const handleLeadExport = async (req, res) => {
  const queryParams = { ...req.query, ...(req.body || {}) }
  const filter = buildLeadFilter(queryParams)
  const allowedSortFields = ['discoveredAt', 'name', 'company', 'status', 'title', 'email', 'phone', 'createdAt', 'confidenceScore']
  const sortField = allowedSortFields.includes(queryParams.sortBy) ? queryParams.sortBy : 'discoveredAt'
  const sortOrder = queryParams.sortOrder === 'asc' ? 1 : -1

  const leads = await Lead.find(filter).sort({ [sortField]: sortOrder })
  const csvText = generateCsv(LEAD_CSV_COLUMNS, leads)

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="leadintel-leads-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send(csvText)
}

app.get('/api/leads/export', asyncRoute(handleLeadExport))
app.post('/api/leads/export', asyncRoute(handleLeadExport))

app.get('/api/leads', asyncRoute(async (req, res) => {
  const filter = buildLeadFilter(req.query)
  const allowedSortFields = ['discoveredAt', 'name', 'company', 'status', 'title', 'email', 'phone', 'createdAt', 'confidenceScore']
  const sortField = allowedSortFields.includes(req.query.sortBy) ? req.query.sortBy : 'discoveredAt'
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1

  if (req.query.page || req.query.paginated === 'true') {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50))
    const skip = (page - 1) * limit

    const [items, total] = await Promise.all([
      Lead.find(filter).sort({ [sortField]: sortOrder }).skip(skip).limit(limit),
      Lead.countDocuments(filter),
    ])
    return res.json({ items, total, page, limit, totalPages: Math.ceil(total / limit) || 1 })
  }

  res.json(await Lead.find(filter).sort({ [sortField]: sortOrder }))
}))

app.get('/api/leads/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid lead ID.' })
  const lead = await Lead.findById(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead not found.' })
  res.json(lead)
}))

app.post('/api/leads', asyncRoute(async (req, res) => {
  const { name, email, phone, company, title, entityType = 'person', notes } = req.body || {}
  if (!name && !email && !company) return res.status(400).json({ error: 'Please provide at least a name, email, or company.' })
  const lead = await Lead.create({ name, email, phone, company, title, entityType, notes, discoveredAt: new Date() })
  res.status(201).json(lead)
}))

app.put('/api/leads/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid lead ID.' })
  const lead = await Lead.findById(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead not found.' })

  const { status, notes, name, email, phone, company, title, linkedinUrl, biography, companyId } = req.body || {}

  const oldCompanyId = lead.companyId
  let newCompanyId = oldCompanyId

  if (companyId !== undefined) {
    if (companyId && mongoose.isValidObjectId(companyId)) {
      newCompanyId = companyId
    } else {
      newCompanyId = null
    }
    lead.companyId = newCompanyId
  } else if (company !== undefined && cleanText(company) !== cleanText(lead.company)) {
    const compName = cleanText(company)
    if (compName) {
      const compRegex = makeWhitespaceFlexibleRegex(compName)
      let foundComp = await CompanyProfile.findOne({ name: compRegex })
      if (!foundComp) {
        foundComp = await CompanyProfile.create({
          name: compName,
          domain: normalizeDomain(compName),
          createdAt: new Date(),
        })
      }
      newCompanyId = foundComp._id
      lead.companyId = newCompanyId
    } else {
      newCompanyId = null
      lead.companyId = null
    }
  }

  if (status !== undefined) lead.status = status
  if (notes !== undefined) lead.notes = notes
  if (name !== undefined) lead.name = cleanText(name) || name
  if (email !== undefined) lead.email = email ? (normalizeEmail(email)?.value || (typeof email === 'string' ? email.trim().toLowerCase() : null)) : null
  if (phone !== undefined) lead.phone = phone ? (normalizePhone(phone)?.normalized || (typeof phone === 'string' ? phone.trim() : null)) : null
  if (company !== undefined) lead.company = cleanText(company) || company
  if (title !== undefined) lead.title = cleanText(title) || title
  if (linkedinUrl !== undefined) lead.linkedinUrl = linkedinUrl ? normalizeLinkedInUrl(linkedinUrl) : null
  if (biography !== undefined) lead.biography = cleanText(biography) || biography

  await lead.save()

  // Maintain company lead counts
  if (String(oldCompanyId) !== String(newCompanyId)) {
    if (oldCompanyId) {
      const oldCount = await Lead.countDocuments({ companyId: oldCompanyId })
      await CompanyProfile.updateOne({ _id: oldCompanyId }, { totalLeads: oldCount })
    }
    if (newCompanyId) {
      const newCount = await Lead.countDocuments({ companyId: newCompanyId })
      await CompanyProfile.updateOne({ _id: newCompanyId }, { totalLeads: newCount })
    }
  }

  res.json(lead)
}))

app.delete('/api/leads/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid lead ID.' })
  const lead = await Lead.findById(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead not found.' })

  const companyId = lead.companyId
  const leadId = lead._id

  await Lead.findByIdAndDelete(leadId)

  // Recount company lead count
  if (companyId) {
    const remaining = await Lead.countDocuments({ companyId })
    await CompanyProfile.updateOne({ _id: companyId }, { totalLeads: remaining })
  }

  // Reset candidate record promotion status if linked
  await CandidateRecord.updateMany(
    { leadId },
    { $set: { promoted: false, promotedAt: null, leadId: null } }
  )

  res.json({ success: true, message: 'Lead deleted.' })
}))

app.get('/api/companies', asyncRoute(async (req, res) => {
  const enriched = await getEnrichedCompanies(req.query)

  if (req.query.sortBy === 'totalLeads') {
    enriched.sort((a, b) => (b.totalLeads || 0) - (a.totalLeads || 0))
  } else if (req.query.sortBy === 'lastCrawledAt') {
    enriched.sort((a, b) => new Date(b.lastCrawledAt || 0) - new Date(a.lastCrawledAt || 0))
  } else {
    enriched.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }

  if (req.query.page || req.query.paginated === 'true') {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20))
    const skip = (page - 1) * limit
    const total = enriched.length
    const items = enriched.slice(skip, skip + limit)
    return res.json({ items, total, page, limit, totalPages: Math.ceil(total / limit) || 1 })
  }

  res.json(enriched)
}))

app.get('/api/companies/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid company ID.' })
  const company = await CompanyProfile.findById(req.params.id)
  if (!company) return res.status(404).json({ error: 'Company not found.' })

  const obj = company.toObject ? company.toObject() : { ...company }
  const leadFilter = {
    $or: [
      { companyId: company._id },
      { company: new RegExp(`^${(company.name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    ],
  }

  const [totalLeads, emailCount, phoneCount, linkedInCount] = await Promise.all([
    Lead.countDocuments(leadFilter),
    Lead.countDocuments({ ...leadFilter, email: { $exists: true, $nin: [null, ''] } }),
    Lead.countDocuments({ ...leadFilter, phone: { $exists: true, $nin: [null, ''] } }),
    Lead.countDocuments({ ...leadFilter, linkedinUrl: { $exists: true, $nin: [null, ''] } }),
  ])

  obj.totalLeads = totalLeads
  obj.emailCount = emailCount
  obj.phoneCount = phoneCount
  obj.linkedInCount = linkedInCount

  // Find recent crawl sessions for this domain or website
  const targetDomain = company.domain || normalizeDomain(company.website || '')
  if (targetDomain) {
    obj.recentScans = await ScanJob.find({
      target: { $regex: targetDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
    }).sort({ createdAt: -1 }).limit(5)
  } else {
    obj.recentScans = []
  }

  res.json(obj)
}))

app.get('/api/companies/:id/leads', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid company ID.' })
  const company = await CompanyProfile.findById(req.params.id)
  if (!company) return res.status(404).json({ error: 'Company not found.' })

  const baseFilter = {
    $or: [
      { companyId: company._id },
      { company: new RegExp(`^${(company.name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    ],
  }

  const queryFilter = buildLeadFilter({ ...req.query, companyId: undefined, company: undefined })
  const filter = { $and: [baseFilter, queryFilter] }

  if (req.query.page || req.query.paginated === 'true') {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20))
    const skip = (page - 1) * limit
    const [items, total] = await Promise.all([
      Lead.find(filter).sort({ discoveredAt: -1 }).skip(skip).limit(limit),
      Lead.countDocuments(filter),
    ])
    return res.json({ items, total, page, limit, totalPages: Math.ceil(total / limit) || 1 })
  }

  res.json(await Lead.find(filter).sort({ discoveredAt: -1 }))
}))

app.get('/api/companies/:id/export', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid company ID.' })
  const company = await CompanyProfile.findById(req.params.id)
  if (!company) return res.status(404).json({ error: 'Company not found.' })

  const filter = {
    $or: [
      { companyId: company._id },
      { company: new RegExp(`^${(company.name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    ],
  }

  const leads = await Lead.find(filter).sort({ discoveredAt: -1 })
  const csvText = generateCsv(LEAD_CSV_COLUMNS, leads)

  const cleanName = (company.name || 'company').toLowerCase().replace(/[^a-z0-9_-]/g, '_')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="leadintel-${cleanName}-leads-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send(csvText)
}))

app.delete('/api/companies/:id', asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid company ID.' })
  const company = await CompanyProfile.findById(req.params.id)
  if (!company) return res.status(404).json({ error: 'Company not found.' })

  // Detach associated leads so they are not deleted
  await Lead.updateMany({ companyId: company._id }, { $unset: { companyId: 1 } })
  await CompanyProfile.findByIdAndDelete(company._id)

  res.json({ success: true, message: 'Company profile deleted. Associated leads preserved.' })
}))

app.post('/api/companies/merge', asyncRoute(async (req, res) => {
  const { targetCompanyId, sourceCompanyId } = req.body || {}
  if (!mongoose.isValidObjectId(targetCompanyId) || !mongoose.isValidObjectId(sourceCompanyId)) {
    return res.status(400).json({ error: 'Valid targetCompanyId and sourceCompanyId are required.' })
  }
  if (targetCompanyId === sourceCompanyId) {
    return res.status(400).json({ error: 'Cannot merge a company into itself.' })
  }

  const [target, source] = await Promise.all([
    CompanyProfile.findById(targetCompanyId),
    CompanyProfile.findById(sourceCompanyId),
  ])

  if (!target) return res.status(404).json({ error: 'Target company not found.' })
  if (!source) return res.status(404).json({ error: 'Source company not found.' })

  // Reassign all leads associated with source to target
  const sourceLeadFilter = {
    $or: [
      { companyId: source._id },
      { company: new RegExp(`^${(source.name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    ],
  }

  const updateResult = await Lead.updateMany(sourceLeadFilter, {
    $set: {
      companyId: target._id,
      company: target.name,
    },
  })

  // Merge company metadata
  if (!target.website && source.website) target.website = source.website
  if (!target.domain && source.domain) target.domain = source.domain
  if (!target.industry && source.industry) target.industry = source.industry
  if (!target.description && source.description) target.description = source.description
  if (!target.email && source.email) target.email = source.email
  if (!target.phone && source.phone) target.phone = source.phone
  if (!target.linkedinUrl && source.linkedinUrl) target.linkedinUrl = source.linkedinUrl

  const combinedContacts = new Set([...(target.contacts || []), ...(source.contacts || [])])
  target.contacts = Array.from(combinedContacts)

  // Delete source company
  await CompanyProfile.findByIdAndDelete(source._id)

  // Recalculate target leads
  const newLeadCount = await Lead.countDocuments({ companyId: target._id })
  target.totalLeads = newLeadCount
  await target.save()

  res.json({
    success: true,
    targetCompany: target,
    reassignedLeadsCount: updateResult.modifiedCount,
    message: `Merged ${source.name} into ${target.name}. Reassigned ${updateResult.modifiedCount} lead(s).`,
  })
}))

app.get('/api/people', asyncRoute(async (req, res) => res.json(await PersonProfile.find(req.query.q ? { name: new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {}).sort({ name: 1 }))))

const defaultSettings = { defaultPageLimit: 100, crawlDepth: 3, requestDelay: 1, concurrency: 3, requestTimeoutMs: 10000, sitemapDiscovery: true, internalLinkCrawling: true, queryParameterPolicy: 'preserve' }
app.get('/api/settings', asyncRoute(async (req, res) => {
  const settings = await AppSettings.findOneAndUpdate({ key: 'default' }, { $setOnInsert: { ...defaultSettings, key: 'default' } }, { upsert: true, new: true })
  if (settings.seleniumFallback === true) {
    await AppSettings.updateOne({ _id: settings._id }, { $set: { seleniumFallback: false } })
    settings.seleniumFallback = false
  }
  res.json(settings)
}))
app.put('/api/settings', asyncRoute(async (req, res) => {
  const input = req.body || {}
  const values = { defaultPageLimit: Number(input.defaultPageLimit), crawlDepth: Number(input.crawlDepth), requestDelay: Number(input.requestDelay), concurrency: Number(input.concurrency), requestTimeoutMs: Number(input.requestTimeoutMs) }
  if (!Number.isInteger(values.defaultPageLimit) || values.defaultPageLimit < 1 || values.defaultPageLimit > 5000 || !Number.isInteger(values.crawlDepth) || values.crawlDepth < 0 || values.crawlDepth > 20 || !Number.isFinite(values.requestDelay) || values.requestDelay < 0 || values.requestDelay > 60 || !Number.isInteger(values.concurrency) || values.concurrency < 1 || values.concurrency > 5 || !Number.isInteger(values.requestTimeoutMs) || values.requestTimeoutMs < 1000 || values.requestTimeoutMs > 60000 || !['preserve', 'remove-tracking', 'remove-all'].includes(input.queryParameterPolicy)) return res.status(400).json({ error: 'Settings values are outside the supported ranges.' })
  const settings = { ...values, seleniumFallback: false, sitemapDiscovery: Boolean(input.sitemapDiscovery), internalLinkCrawling: Boolean(input.internalLinkCrawling), queryParameterPolicy: input.queryParameterPolicy }
  res.json(await AppSettings.findOneAndUpdate({ key: 'default' }, { $set: settings, $setOnInsert: { key: 'default' } }, { upsert: true, new: true, runValidators: true }))
}))

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Unexpected server error.' }) })
mongoose.connection.on('connected', () => { void initializeDatabase() })
mongoose.connection.on('disconnected', () => {
  dbReady = false
  jobs.setDatabaseAvailable(false)
  console.warn('MongoDB disconnected; API requests are paused and active scans are stopping.')
})
mongoose.connection.on('error', () => {
  dbReady = dbInitialized && mongoose.connection.readyState === 1
  console.error('MongoDB connection error; connection details omitted.')
})

void connectMongo()

async function initializeDatabase() {
  if (mongoose.connection.readyState !== 1) return
  if (dbRecovery) return dbRecovery
  dbRecovery = (async () => {
    try {
      await Promise.all([ScanPage.createIndexes(), CandidateRecord.createIndexes()])
      if (!dbInitialized) { await jobs.restore(); dbInitialized = true }
      else await jobs.recoverAfterReconnect()
      if (mongoose.connection.readyState === 1) {
        jobs.setDatabaseAvailable(true)
        dbReady = true
        dbRecoveryAttempt = 0
        if (dbRecoveryTimer) { clearTimeout(dbRecoveryTimer); dbRecoveryTimer = null }
        console.log('MongoDB connection ready')
      }
    } catch {
      dbReady = false
      jobs.setDatabaseAvailable(false)
      console.error('MongoDB recovery failed; API and scan worker remain paused.')
      scheduleDatabaseRecovery()
    } finally { dbRecovery = null }
  })()
  return dbRecovery
}

function scheduleDatabaseRecovery() {
  if (dbRecoveryTimer) return
  const delayMs = Math.min(30000, 1000 * (2 ** Math.min(dbRecoveryAttempt, 5)))
  dbRecoveryAttempt++
  console.warn(`MongoDB recovery will retry in ${Math.round(delayMs / 1000)} second(s).`)
  dbRecoveryTimer = setTimeout(() => {
    dbRecoveryTimer = null
    if (mongoose.connection.readyState === 1) void initializeDatabase()
    else void connectMongo()
  }, delayMs)
}

async function connectMongo() {
  if (mongoConnectPromise) return mongoConnectPromise
  mongoConnectPromise = mongoose.connect(mongoUri).then(() => initializeDatabase()).catch(() => {
    dbReady = false
    jobs.setDatabaseAvailable(false)
    console.error('MongoDB connection attempt failed; connection details omitted.')
    scheduleDatabaseRecovery()
  }).finally(() => { mongoConnectPromise = null })
  return mongoConnectPromise
}

const port = process.env.PORT || 4000
const host = process.env.HOST || '0.0.0.0'
server.listen(port, host, () => console.log(`LeadIntel API listening on http://${host}:${port}`))
