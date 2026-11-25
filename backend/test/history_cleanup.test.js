import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { ScanJob, ScanPage, CandidateRecord, Lead, PersonProfile, CompanyProfile } from '../src/models/index.js'
import { cleanupScanData } from '../src/services/historyCleanup.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_history_cleanup_test'

test('History Deletion & Data Cleanup MVP Test Suite', async (t) => {
  const apiPort = await freePort()
  let apiServer

  await mongoose.connect(TEST_DB_URI)

  await Promise.all([
    ScanJob.deleteMany({}),
    ScanPage.deleteMany({}),
    CandidateRecord.deleteMany({}),
    Lead.deleteMany({}),
    PersonProfile.deleteMany({}),
    CompanyProfile.deleteMany({}),
  ])

  const apiEnv = {
    ...process.env,
    NODE_ENV: 'test',
    MONGODB_URI: TEST_DB_URI,
    PORT: String(apiPort),
    HOST: '127.0.0.1',
    CLIENT_ORIGIN: 'http://localhost:5173',
  }
  apiServer = spawn('node', ['src/server.js'], { cwd: process.cwd(), env: apiEnv, stdio: 'ignore' })
  const base = `http://127.0.0.1:${apiPort}/api`

  let healthy = false
  for (let i = 0; i < 60; i++) {
    await wait(100)
    try {
      const res = await fetch(`${base}/health`)
      const data = await res.json()
      if (data.dbConnected) {
        healthy = true
        break
      }
    } catch {}
  }
  assert.ok(healthy, 'Backend server should start and report database connected')

  t.after(async () => {
    if (apiServer) {
      apiServer.kill('SIGTERM')
      await wait(200)
    }
    await Promise.all([
      ScanJob.deleteMany({}),
      ScanPage.deleteMany({}),
      CandidateRecord.deleteMany({}),
      Lead.deleteMany({}),
      PersonProfile.deleteMany({}),
      CompanyProfile.deleteMany({}),
    ])
    await mongoose.disconnect()
  })

  // 1. Individual scan deletion removes scan-specific data
  await t.test('1. Individual scan deletion: removes ScanJob, ScanPages, and CandidateRecords', async () => {
    const scan = await ScanJob.create({
      type: 'website',
      target: 'https://scan-single.test',
      domain: 'scan-single.test',
      status: 'completed',
    })

    const page = await ScanPage.create({
      scanId: scan._id,
      url: 'https://scan-single.test/team',
      normalizedUrl: 'https://scan-single.test/team',
      source: 'seed',
      processingStatus: 'fetched',
    })

    await CandidateRecord.create({
      scanJobId: scan._id,
      pageId: page._id,
      candidateKey: 'cand-single-1',
      candidateType: 'person',
      fields: { full_name: 'Single Person' },
      sourceUrl: 'https://scan-single.test/team',
      extractedAt: new Date(),
      parserVersion: 'v1',
    })

    const res = await fetch(`${base}/history/${scan._id}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
    assert.equal(data.cleanup.deletedScans, 1)
    assert.equal(data.cleanup.deletedPages, 1)
    assert.equal(data.cleanup.deletedCandidates, 1)

    // Verify database is clean
    const foundScan = await ScanJob.findById(scan._id)
    const foundPages = await ScanPage.find({ scanId: scan._id })
    const foundCands = await CandidateRecord.find({ scanJobId: scan._id })

    assert.equal(foundScan, null, 'ScanJob must be deleted')
    assert.equal(foundPages.length, 0, 'ScanPages must be deleted')
    assert.equal(foundCands.length, 0, 'CandidateRecords must be deleted')
  })

  // 2. Orphaned records are cleaned up correctly
  await t.test('2. Orphaned records: genuinely orphaned leads, persons, and companies are deleted', async () => {
    const scan = await ScanJob.create({
      type: 'website',
      target: 'https://orphaned.test',
      domain: 'orphaned.test',
      status: 'completed',
    })

    const page = await ScanPage.create({
      scanId: scan._id,
      url: 'https://orphaned.test/about',
      normalizedUrl: 'https://orphaned.test/about',
      source: 'seed',
      processingStatus: 'fetched',
    })

    // Orphan company shell: no domain, no website, created by this scan
    const comp = await CompanyProfile.create({
      scanId: scan._id,
      candidateKey: 'cand-comp-orphan',
    })

    // Orphan lead: unverified incomplete fragment with no contact details
    const orphanLead = await Lead.create({
      scanId: scan._id,
      candidateKey: 'cand-lead-orphan',
      status: 'new',
    })

    // Orphan person: empty person profile without contact details
    const orphanPerson = await PersonProfile.create({
      scanId: scan._id,
      candidateKey: 'cand-person-orphan',
    })

    const res = await fetch(`${base}/history/${scan._id}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)

    // Verify orphaned records are purged
    const foundLead = await Lead.findById(orphanLead._id)
    const foundPerson = await PersonProfile.findById(orphanPerson._id)
    const foundComp = await CompanyProfile.findById(comp._id)

    assert.equal(foundLead, null, 'Orphaned incomplete lead must be cleaned up')
    assert.equal(foundPerson, null, 'Orphaned person profile must be cleaned up')
    assert.equal(foundComp, null, 'Orphaned company shell with zero remaining leads must be cleaned up')
  })

  // 3. Shared records and curated CRM data are preserved, and dangling references are removed
  await t.test('3. Shared & Curated Data: preserved when referenced, and dangling scanId is cleared', async () => {
    // Retained scan
    const retainedScan = await ScanJob.create({
      type: 'website',
      target: 'https://retained.test',
      domain: 'retained.test',
      status: 'completed',
    })

    const retainedPage = await ScanPage.create({
      scanId: retainedScan._id,
      url: 'https://retained.test/team',
      normalizedUrl: 'https://retained.test/team',
      source: 'seed',
      processingStatus: 'fetched',
    })

    // Retained scan candidate that references shared-email
    await CandidateRecord.create({
      scanJobId: retainedScan._id,
      pageId: retainedPage._id,
      candidateKey: 'cand-shared-retained',
      candidateType: 'person',
      fields: { full_name: 'Shared Guy', email: 'shared@enterprise.test' },
      sourceUrl: 'https://retained.test/team',
      extractedAt: new Date(),
      parserVersion: 'v1',
    })

    // Scan to be deleted
    const scanToDelete = await ScanJob.create({
      type: 'website',
      target: 'https://to-delete.test',
      domain: 'to-delete.test',
      status: 'completed',
    })

    // Company shared across both: has leads from to-delete and retained
    const sharedCompany = await CompanyProfile.create({
      name: 'Enterprise Corp',
      domain: 'enterprise.test',
      scanId: scanToDelete._id,
      totalLeads: 2,
    })

    // Lead 1: shared with retained scan via email
    const sharedLead = await Lead.create({
      name: 'Shared Guy',
      email: 'shared@enterprise.test',
      companyId: sharedCompany._id,
      scanId: scanToDelete._id,
      candidateKey: 'cand-shared-todelete',
      status: 'new',
    })

    // Lead 2: curated CRM lead (status: contacted)
    const curatedLead = await Lead.create({
      name: 'Curated Boss',
      email: 'curated@enterprise.test',
      companyId: sharedCompany._id,
      scanId: scanToDelete._id,
      candidateKey: 'cand-curated-1',
      status: 'contacted',
      notes: 'Spoke at conference',
    })

    // Execute deletion of scanToDelete
    const res = await fetch(`${base}/history/${scanToDelete._id}`, { method: 'DELETE' })
    assert.equal(res.status, 200)

    // Verify shared lead is PRESERVED
    const dbSharedLead = await Lead.findById(sharedLead._id)
    assert.ok(dbSharedLead, 'Shared lead must be preserved')
    assert.equal(dbSharedLead.scanId, undefined, 'Preserved shared lead must have dangling scanId unset')

    // Verify curated lead is PRESERVED
    const dbCuratedLead = await Lead.findById(curatedLead._id)
    assert.ok(dbCuratedLead, 'Curated lead (contacted with notes) must be preserved')
    assert.equal(dbCuratedLead.status, 'contacted')
    assert.equal(dbCuratedLead.notes, 'Spoke at conference')
    assert.equal(dbCuratedLead.scanId, undefined, 'Preserved curated lead must have dangling scanId unset')

    // Verify shared company is PRESERVED
    const dbSharedCompany = await CompanyProfile.findById(sharedCompany._id)
    assert.ok(dbSharedCompany, 'Shared company with remaining leads must be preserved')
    assert.equal(dbSharedCompany.scanId, undefined, 'Preserved company must have dangling scanId unset')
    assert.equal(dbSharedCompany.totalLeads, 2, 'Total leads must reflect remaining leads')
  })

  // 4. Clear All History: protects active scans, and completely resets all scan jobs and CRM data
  await t.test('4. Clear All History: protects active scans, and completely resets all scan jobs and CRM data', async () => {
    await Promise.all([
      ScanJob.deleteMany({}),
      ScanPage.deleteMany({}),
      CandidateRecord.deleteMany({}),
      Lead.deleteMany({}),
      PersonProfile.deleteMany({}),
      CompanyProfile.deleteMany({}),
    ])

    const jobCompleted = await ScanJob.create({ type: 'website', target: 'https://c1.test', status: 'completed' })
    const jobFailed = await ScanJob.create({ type: 'website', target: 'https://c2.test', status: 'failed' })
    const jobCancelled = await ScanJob.create({ type: 'website', target: 'https://c3.test', status: 'cancelled' })
    const jobActive = await ScanJob.create({ type: 'website', target: 'https://active.test', status: 'running' })

    const p1 = await ScanPage.create({ scanId: jobCompleted._id, url: 'https://c1.test', normalizedUrl: 'https://c1.test', source: 'seed' })
    await CandidateRecord.create({
      scanJobId: jobCompleted._id,
      pageId: p1._id,
      candidateKey: 'ck1',
      candidateType: 'person',
      fields: { full_name: 'Person C1' },
      sourceUrl: 'https://c1.test',
      extractedAt: new Date(),
      parserVersion: 'v1',
    })

    // Direct manual CRM lead with scanId: jobCompleted._id (no candidateKey)
    const directLead = await Lead.create({
      name: 'Direct CRM Lead',
      email: 'direct@crm.test',
      scanId: jobCompleted._id,
    })

    // Candidate lead from jobFailed
    const orphanFailedLead = await Lead.create({
      scanId: jobFailed._id,
      candidateKey: 'cand-failed-orphan',
      status: 'new',
    })

    // Call Clear History while active job is present -> must return 409 Conflict
    const activeRes = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(activeRes.status, 409, 'Must protect active scans with 409 Conflict')
    const activeData = await activeRes.json()
    assert.match(activeData.error, /Cannot clear history while scans are actively running or queued/i)

    // Verify nothing was deleted while active scan was running
    assert.equal(await ScanJob.countDocuments({}), 4)
    assert.equal(await Lead.countDocuments({}), 2)

    // Remove active job so clear history can proceed
    await ScanJob.findByIdAndDelete(jobActive._id)

    // Call Clear History now that active scan is gone
    const res = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
    assert.equal(data.deletedCount, 3, 'Must delete 3 inactive scan jobs (completed, failed, cancelled)')

    // Check all scan jobs are deleted
    assert.equal(await ScanJob.findById(jobCompleted._id), null)
    assert.equal(await ScanJob.findById(jobFailed._id), null)
    assert.equal(await ScanJob.findById(jobCancelled._id), null)
    assert.equal(await ScanJob.countDocuments({}), 0)

    // Check all leads and scan data are completely wiped
    assert.equal(await Lead.findById(orphanFailedLead._id), null, 'Orphaned candidate lead must be deleted')
    assert.equal(await Lead.findById(directLead._id), null, 'All CRM leads must be wiped on Clear All History')
    assert.equal(await Lead.countDocuments({}), 0)
    assert.equal(await ScanPage.countDocuments({}), 0)
    assert.equal(await CandidateRecord.countDocuments({}), 0)
  })

  // 5. Validation and safety checks
  await t.test('5. Safety: handles invalid IDs, 404 nonexistent, and 409 active scan protection', async () => {
    // Invalid ID
    const resInvalid = await fetch(`${base}/history/not-an-id`, { method: 'DELETE' })
    assert.equal(resInvalid.status, 400)

    // Nonexistent ID
    const fakeId = new mongoose.Types.ObjectId()
    const resNotFound = await fetch(`${base}/history/${fakeId}`, { method: 'DELETE' })
    assert.equal(resNotFound.status, 404)

    // Active scan protection (running)
    const activeScan = await ScanJob.create({ type: 'website', target: 'https://running-guard.test', status: 'running' })
    const resActive = await fetch(`${base}/history/${activeScan._id}`, { method: 'DELETE' })
    assert.equal(resActive.status, 409)

    // Queued scan protection
    const queuedScan = await ScanJob.create({ type: 'website', target: 'https://queued-guard.test', status: 'queued' })
    const resQueued = await fetch(`${base}/history/${queuedScan._id}`, { method: 'DELETE' })
    assert.equal(resQueued.status, 409)
  })
})
