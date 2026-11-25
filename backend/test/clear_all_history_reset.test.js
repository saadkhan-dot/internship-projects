import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { ScanJob, ScanPage, CandidateRecord, Lead, PersonProfile, CompanyProfile } from '../src/models/index.js'
import { resetAllHistoryAndCrmData } from '../src/services/historyCleanup.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_clear_all_history_test'

test('Clear All History & Full CRM Reset Test Suite', async (t) => {
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
    await mongoose.connection.close()
  })

  // 1-6. Verify Clear All History wipes all ScanJobs, ScanPages, CandidateRecords, Leads, PersonProfiles, CompanyProfiles
  await t.test('1-6. Clear All History removes all ScanJobs, ScanPages, Candidates, Leads, People, and Companies', async () => {
    // Populate rich dataset across all collections
    const job1 = await ScanJob.create({ type: 'website', target: 'https://alpha.test', status: 'completed' })
    const job2 = await ScanJob.create({ type: 'website', target: 'https://beta.test', status: 'failed' })
    const job3 = await ScanJob.create({ type: 'website', target: 'https://gamma.test', status: 'cancelled' })

    const page1 = await ScanPage.create({ scanId: job1._id, url: 'https://alpha.test/about', normalizedUrl: 'https://alpha.test/about', source: 'seed' })
    const page2 = await ScanPage.create({ scanId: job2._id, url: 'https://beta.test/contact', normalizedUrl: 'https://beta.test/contact', source: 'seed' })

    await CandidateRecord.create({
      scanJobId: job1._id,
      pageId: page1._id,
      candidateKey: 'cand-alpha-1',
      candidateType: 'person',
      fields: { full_name: 'Alice Alpha', email: 'alice@alpha.test' },
      sourceUrl: 'https://alpha.test/about',
      extractedAt: new Date(),
      parserVersion: 'v1',
    })
    await CandidateRecord.create({
      scanJobId: job2._id,
      pageId: page2._id,
      candidateKey: 'cand-beta-1',
      candidateType: 'person',
      fields: { full_name: 'Bob Beta', email: 'bob@beta.test' },
      sourceUrl: 'https://beta.test/contact',
      extractedAt: new Date(),
      parserVersion: 'v1',
    })

    const comp1 = await CompanyProfile.create({
      name: 'Alpha Technologies',
      domain: 'alpha.test',
      website: 'https://alpha.test',
      scanId: job1._id,
    })
    const comp2 = await CompanyProfile.create({
      name: 'Beta Global',
      domain: 'beta.test',
      website: 'https://beta.test',
    })

    const person1 = await PersonProfile.create({
      name: 'Alice Alpha',
      email: 'alice@alpha.test',
      scanId: job1._id,
    })
    const person2 = await PersonProfile.create({
      name: 'Bob Beta',
      email: 'bob@beta.test',
    })

    // Curated lead
    await Lead.create({
      name: 'Alice Alpha',
      email: 'alice@alpha.test',
      company: 'Alpha Technologies',
      companyId: comp1._id,
      scanId: job1._id,
      status: 'contacted',
      notes: 'High priority lead',
    })
    // Promoted candidate lead
    await Lead.create({
      name: 'Bob Beta',
      email: 'bob@beta.test',
      company: 'Beta Global',
      companyId: comp2._id,
      candidateKey: 'cand-beta-1',
      status: 'new',
    })

    // Sanity check before clear
    assert.equal(await ScanJob.countDocuments({}), 3)
    assert.equal(await ScanPage.countDocuments({}), 2)
    assert.equal(await CandidateRecord.countDocuments({}), 2)
    assert.equal(await Lead.countDocuments({}), 2)
    assert.equal(await PersonProfile.countDocuments({}), 2)
    assert.equal(await CompanyProfile.countDocuments({}), 2)

    // Call Clear All History
    const res = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
    assert.equal(data.deletedCount, 3)
    assert.equal(data.cleanup.deletedScans, 3)
    assert.equal(data.cleanup.deletedPages, 2)
    assert.equal(data.cleanup.deletedCandidates, 2)
    assert.equal(data.cleanup.deletedLeads, 2)
    assert.equal(data.cleanup.deletedPeople, 2)
    assert.equal(data.cleanup.deletedCompanies, 2)

    // Verify all collections are strictly 0
    assert.equal(await ScanJob.countDocuments({}), 0, '1. All ScanJobs must be removed')
    assert.equal(await ScanPage.countDocuments({}), 0, '2. All ScanPages must be removed')
    assert.equal(await CandidateRecord.countDocuments({}), 0, '3. All CandidateRecords must be removed')
    assert.equal(await Lead.countDocuments({}), 0, '4. All Leads must be removed')
    assert.equal(await PersonProfile.countDocuments({}), 0, '5. All PersonProfiles must be removed')
    assert.equal(await CompanyProfile.countDocuments({}), 0, '6. All CompanyProfiles must be removed')
  })

  // 7. Dashboard metrics become zero
  await t.test('7. Dashboard metrics return zero across all categories after clear', async () => {
    const dashRes = await fetch(`${base}/dashboard`)
    assert.equal(dashRes.status, 200)
    const dashData = await dashRes.json()

    assert.equal(dashData.totalLeads, 0, 'Dashboard totalLeads must be 0')
    assert.equal(dashData.people, 0, 'Dashboard people must be 0')
    assert.equal(dashData.companies, 0, 'Dashboard companies must be 0')
    assert.equal(dashData.completedScans, 0, 'Dashboard completedScans must be 0')
    assert.deepEqual(dashData.recentScans, [], 'Dashboard recentScans must be empty')
  })

  // 8. Active scan protection works correctly
  await t.test('8. Active scan protection: rejects Clear All History with 409 Conflict when active scan exists', async () => {
    // Create an active (running) scan
    const activeJob = await ScanJob.create({
      type: 'website',
      target: 'https://active-protection.test',
      status: 'running',
    })
    const compJob = await ScanJob.create({
      type: 'website',
      target: 'https://completed-other.test',
      status: 'completed',
    })

    const leadProtected = await Lead.create({
      name: 'Protected Lead',
      email: 'protected@test.test',
      status: 'new',
    })

    // Attempt Clear All History
    const clearRes = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(clearRes.status, 409, 'Must return 409 Conflict when scans are running or queued')
    const clearData = await clearRes.json()
    assert.match(clearData.error, /Cannot clear history while scans are actively running or queued/i)
    assert.equal(clearData.activeCount, 1)

    // Verify database was NOT wiped
    assert.equal(await ScanJob.countDocuments({}), 2, 'No ScanJobs should be deleted during 409 rejection')
    assert.equal(await Lead.countDocuments({}), 1, 'No Leads should be deleted during 409 rejection')

    // Clean up active job for next tests
    await ScanJob.deleteMany({})
    await Lead.deleteMany({})
  })

  // 9. Individual scan deletion does NOT wipe the entire CRM
  await t.test('9. Individual scan deletion (/api/history/:id) does NOT wipe unrelated or shared CRM data', async () => {
    const retainedJob = await ScanJob.create({ type: 'website', target: 'https://retained.test', status: 'completed' })
    const targetJob = await ScanJob.create({ type: 'website', target: 'https://target-delete.test', status: 'completed' })

    const pRetained = await ScanPage.create({ scanId: retainedJob._id, url: 'https://retained.test', normalizedUrl: 'https://retained.test', source: 'seed' })
    await CandidateRecord.create({
      scanJobId: retainedJob._id,
      pageId: pRetained._id,
      candidateKey: 'cand-retained-1',
      candidateType: 'person',
      fields: { full_name: 'Retained Guy' },
      sourceUrl: 'https://retained.test',
      extractedAt: new Date(),
      parserVersion: 'v1',
    })

    const comp = await CompanyProfile.create({
      name: 'Shared Enterprise',
      domain: 'shared.test',
      scanId: targetJob._id,
    })

    const leadPreserved = await Lead.create({
      name: 'Important Person',
      email: 'important@shared.test',
      companyId: comp._id,
      scanId: targetJob._id,
      status: 'contacted',
      notes: 'Customer relationship preserved',
    })

    // Delete single scan
    const res = await fetch(`${base}/history/${targetJob._id}`, { method: 'DELETE' })
    assert.equal(res.status, 200)

    // Verify only targetJob is deleted, retainedJob still exists
    assert.equal(await ScanJob.findById(targetJob._id), null)
    assert.ok(await ScanJob.findById(retainedJob._id))

    // Verify CRM records are PRESERVED by single scan cleanup
    const dbLead = await Lead.findById(leadPreserved._id)
    assert.ok(dbLead, 'Single scan deletion must NOT delete curated/legitimate CRM leads')
    assert.equal(dbLead.scanId, undefined, 'Preserved lead has dangling scanId unset')

    const dbComp = await CompanyProfile.findById(comp._id)
    assert.ok(dbComp, 'Single scan deletion must NOT delete shared company profiles')

    // Clean up
    await Promise.all([
      ScanJob.deleteMany({}),
      ScanPage.deleteMany({}),
      CandidateRecord.deleteMany({}),
      Lead.deleteMany({}),
      PersonProfile.deleteMany({}),
      CompanyProfile.deleteMany({}),
    ])
  })

  // 10. Repeated Clear All History requests are safe (idempotent)
  await t.test('10. Repeated Clear All History requests are safe and idempotent', async () => {
    // First call on empty DB
    const res1 = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(res1.status, 200)
    const data1 = await res1.json()
    assert.equal(data1.success, true)
    assert.equal(data1.deletedCount, 0)
    assert.equal(data1.cleanup.deletedScans, 0)
    assert.equal(data1.cleanup.deletedLeads, 0)

    // Second call immediately after
    const res2 = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(res2.status, 200)
    const data2 = await res2.json()
    assert.equal(data2.success, true)
    assert.equal(data2.deletedCount, 0)
    assert.equal(data2.cleanup.deletedScans, 0)
  })

  // 11. Cleanup failures do not return false success
  await t.test('11. Cleanup failures do not return false success', async () => {
    const mockFailingModels = {
      ScanJobModel: {
        countDocuments: async () => 0,
        deleteMany: async () => { throw new Error('Database write error on ScanJob') },
      },
      ScanPageModel: ScanPage,
      CandidateRecordModel: CandidateRecord,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
    }

    await assert.rejects(
      async () => {
        await resetAllHistoryAndCrmData(mockFailingModels)
      },
      /Database write error on ScanJob/,
      'Cleanup service must re-throw database failure rather than falsely returning success'
    )
  })

  // 12. A new scan can be created normally after clearing everything
  await t.test('12. A new scan can be created normally after clearing everything', async () => {
    // Create new scan via API
    const createRes = await fetch(`${base}/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'website',
        target: 'https://post-clear-test.org',
        options: { maxPages: 10, maxDepth: 2 },
      }),
    })

    assert.equal(createRes.status, 201)
    const createData = await createRes.json()
    assert.ok(createData._id)
    assert.match(createData.target, /https:\/\/post-clear-test\.org/i)

    // Verify it exists in database
    const dbJob = await ScanJob.findById(createData._id)
    assert.ok(dbJob)
    assert.match(dbJob.target, /https:\/\/post-clear-test\.org/i)

    // Clean up created scan
    await ScanJob.deleteMany({})
  })
})
