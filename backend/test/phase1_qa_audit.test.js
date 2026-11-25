import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { ScanJob, ScanPage, CandidateRecord, Lead, PersonProfile, CompanyProfile } from '../src/models/index.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'
import { generateCsv } from '../src/utils/csv.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

const AUDIT_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_audit_test'

test('LeadIntel Phase 1 Comprehensive QA Audit Test Suite', async (t) => {
  const apiPort = await freePort()
  let apiServer

  await mongoose.connect(AUDIT_DB_URI)

  const clearAll = async () => {
    await Promise.all([
      ScanJob.deleteMany({}),
      ScanPage.deleteMany({}),
      CandidateRecord.deleteMany({}),
      Lead.deleteMany({}),
      PersonProfile.deleteMany({}),
      CompanyProfile.deleteMany({}),
    ])
  }

  await clearAll()

  const apiEnv = {
    ...process.env,
    NODE_ENV: 'test',
    MONGODB_URI: AUDIT_DB_URI,
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
  assert.equal(healthy, true, 'Audit test backend failed to start and connect to test MongoDB')

  t.after(async () => {
    if (apiServer) apiServer.kill('SIGKILL')
    await clearAll()
    await mongoose.disconnect()
  })

  // ==========================================
  // SECTION 1: SECURITY & INPUT VALIDATION
  // ==========================================

  await t.test('Security: CSV Formula Injection (CWE-1236) Vulnerability Check', async () => {
    // Audit check: Verify whether generateCsv and CSV export sanitize leading formula triggers (=, +, -, @)
    const formulaLead = await Lead.create({
      name: '=cmd|\' /C calc\'!A0',
      title: '@SUM(A1:A10)',
      company: '-2+3+cmd',
      email: '+12345@example.com',
      notes: '=HYPERLINK("http://attacker.com","Click Here")',
      discoveredAt: new Date(),
    })

    const res = await fetch(`${base}/leads/export`)
    assert.equal(res.status, 200)
    const csvContent = await res.text()

    // Inspect whether formula characters appear at the start of cells unescaped
    const lines = csvContent.split('\r\n')
    assert.ok(lines.length >= 2, 'CSV must contain header and at least one row')

    const dataRow = lines[1]
    const hasRawFormulaTrigger = dataRow.includes('="=cmd') || dataRow.includes('=-2+3') || dataRow.includes('=@SUM') || dataRow.startsWith('=cmd')
    assert.equal(hasRawFormulaTrigger, false, 'Exported CSV must not contain unneutralized formula triggers')

    // Document whether CSV generator sanitizes formula injection
    const columns = [
      { key: 'name', label: 'Name' },
      { key: 'company', label: 'Company' },
    ]
    const directCsv = generateCsv(columns, [{ name: '=1+2', company: '@SUM' }])
    const isSanitized = directCsv.includes("'\t=1+2") || directCsv.includes("'=1+2") || directCsv.includes('"\t=1+2"')
    
    // Verify that generateCsv prepends single quote to neutralize formula triggers
    assert.equal(isSanitized, true, 'CSV generator must sanitize formula characters (=, @, +, -)')
  })

  await t.test('Security & Robustness: Invalid MongoDB ObjectID Handling', async () => {
    const invalidIds = ['invalid-id', '123', 'null', 'undefined', '[object Object]']

    for (const badId of invalidIds) {
      // 1. History
      const hGet = await fetch(`${base}/history/${badId}`)
      assert.equal(hGet.status, 400, `GET /history/${badId} should return 400 Bad Request, got ${hGet.status}`)
      const hDel = await fetch(`${base}/history/${badId}`, { method: 'DELETE' })
      assert.equal(hDel.status, 400, `DELETE /history/${badId} should return 400 Bad Request, got ${hDel.status}`)

      // 2. Leads
      const lGet = await fetch(`${base}/leads/${badId}`)
      assert.equal(lGet.status, 400, `GET /leads/${badId} should return 400 Bad Request, got ${lGet.status}`)
      const lPut = await fetch(`${base}/leads/${badId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'test' }),
      })
      assert.equal(lPut.status, 400, `PUT /leads/${badId} should return 400 Bad Request, got ${lPut.status}`)
      const lDel = await fetch(`${base}/leads/${badId}`, { method: 'DELETE' })
      assert.equal(lDel.status, 400, `DELETE /leads/${badId} should return 400 Bad Request, got ${lDel.status}`)

      // 3. Companies
      const cGet = await fetch(`${base}/companies/${badId}`)
      assert.equal(cGet.status, 400, `GET /companies/${badId} should return 400 Bad Request, got ${cGet.status}`)
      const cLeads = await fetch(`${base}/companies/${badId}/leads`)
      assert.equal(cLeads.status, 400, `GET /companies/${badId}/leads should return 400 Bad Request, got ${cLeads.status}`)
      const cExp = await fetch(`${base}/companies/${badId}/export`)
      assert.equal(cExp.status, 400, `GET /companies/${badId}/export should return 400 Bad Request, got ${cExp.status}`)
      const cDel = await fetch(`${base}/companies/${badId}`, { method: 'DELETE' })
      assert.equal(cDel.status, 400, `DELETE /companies/${badId} should return 400 Bad Request, got ${cDel.status}`)
    }

    // 4. Company Merge with invalid IDs
    const m1 = await fetch(`${base}/companies/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCompanyId: 'invalid', sourceCompanyId: 'invalid' }),
    })
    assert.equal(m1.status, 400, 'Company merge with invalid IDs must return 400')

    // 5. Valid ObjectID but non-existent document
    const nonExistent = new mongoose.Types.ObjectId().toString()
    const h404 = await fetch(`${base}/history/${nonExistent}`)
    assert.equal(h404.status, 404, 'Non-existent history session should return 404')
    const l404 = await fetch(`${base}/leads/${nonExistent}`)
    assert.equal(l404.status, 404, 'Non-existent lead should return 404')
    const c404 = await fetch(`${base}/companies/${nonExistent}`)
    assert.equal(c404.status, 404, 'Non-existent company should return 404')
  })

  await t.test('Security & Robustness: ReDoS and Regex Special Characters in Query Parameters', async () => {
    // Test regex metacharacters that cause syntax errors if not escaped: ( [ * + ? \ $ ^ { } |
    const evilInputs = ['(', '[', '*', '+', '?', '\\', '(((a*)*)*)*)x', 'hello(world']

    for (const evil of evilInputs) {
      // 1. /api/history?search=
      const resH = await fetch(`${base}/history?search=${encodeURIComponent(evil)}`)
      assert.equal(resH.status, 200, `History search with regex string "${evil}" failed with ${resH.status}`)

      // 2. /api/leads?search=
      const resL = await fetch(`${base}/leads?search=${encodeURIComponent(evil)}`)
      assert.equal(resL.status, 200, `Leads search with regex string "${evil}" failed with ${resL.status}`)

      // 3. /api/leads?sourceUrl=
      const resLSource = await fetch(`${base}/leads?sourceUrl=${encodeURIComponent(evil)}`)
      assert.equal(resLSource.status, 200, `Leads sourceUrl with regex string "${evil}" failed with ${resLSource.status}`)

      // 4. /api/leads?company=
      const resLComp = await fetch(`${base}/leads?company=${encodeURIComponent(evil)}`)
      assert.equal(resLComp.status, 200, `Leads company with regex string "${evil}" failed with ${resLComp.status}`)

      // 5. /api/companies?search=
      const resC = await fetch(`${base}/companies?search=${encodeURIComponent(evil)}`)
      assert.equal(resC.status, 200, `Companies search with regex string "${evil}" failed with ${resC.status}`)
    }
  })

  await t.test('Boundary & Input Validation: Pagination and Limit Clamping', async () => {
    // 1. History pagination clamping
    const h1 = await fetch(`${base}/history?page=-5&limit=-10`).then(r => r.json())
    assert.equal(h1.page, 1, 'Negative page must be clamped to 1')
    assert.equal(h1.limit, 1, 'Negative limit must be clamped to at least 1')

    const h2 = await fetch(`${base}/history?page=abc&limit=xyz`).then(r => r.json())
    assert.equal(h2.page, 1, 'NaN page must default to 1')
    assert.equal(h2.limit, 20, 'NaN limit must default to 20')

    const h3 = await fetch(`${base}/history?limit=1000000`).then(r => r.json())
    assert.equal(h3.limit, 200, 'History limit must be capped at 200 to prevent DoS')

    // 2. Leads pagination clamping
    const l1 = await fetch(`${base}/leads?paginated=true&page=-1&limit=0`).then(r => r.json())
    assert.equal(l1.page, 1, 'Negative page must be clamped to 1')
    // When limit=0 is provided, JavaScript evaluates 0 || 50 -> 50!
    assert.equal(l1.limit, 50, 'Falsy limit=0 defaults to 50 due to (Number(limit) || 50) evaluation')

    const l2 = await fetch(`${base}/leads?paginated=true&limit=99999`).then(r => r.json())
    assert.equal(l2.limit, 500, 'Leads limit must be capped at 500')

    // 3. Companies pagination clamping
    const c1 = await fetch(`${base}/companies?paginated=true&page=0&limit=-5`).then(r => r.json())
    assert.equal(c1.page, 1, 'Page 0 must clamp to 1')
    assert.equal(c1.limit, 1, 'Negative limit must clamp to 1')

    const c2 = await fetch(`${base}/companies?paginated=true&limit=10000`).then(r => r.json())
    assert.equal(c2.limit, 200, 'Companies limit must be capped at 200')
  })

  await t.test('Security & Robustness: Arbitrary Field Sorting in sortBy Query Parameter', async () => {
    // Test passing arbitrary non-existent or internal fields
    const res1 = await fetch(`${base}/history?sortBy=nonExistentField&sortOrder=asc`)
    assert.equal(res1.status, 200, 'Arbitrary sortField should not crash server')

    const res2 = await fetch(`${base}/leads?paginated=true&sortBy=__v&sortOrder=desc`)
    assert.equal(res2.status, 200, 'Sorting by __v should not crash server')
  })

  // ==========================================
  // SECTION 2: CLEAR HISTORY & DATA ISOLATION
  // ==========================================

  await t.test('Data Integrity: Clear History and Inactive Crawl Deletion Boundaries', async () => {
    await clearAll()

    // Create 5 jobs with distinct statuses
    const jQueued = await ScanJob.create({ target: 'https://site-queued.org', status: 'queued', type: 'website' })
    const jRunning = await ScanJob.create({ target: 'https://site-running.org', status: 'running', type: 'website' })
    const jCompleted = await ScanJob.create({ target: 'https://site-completed.org', status: 'completed', type: 'website' })
    const jFailed = await ScanJob.create({ target: 'https://site-failed.org', status: 'failed', type: 'website' })
    const jCancelled = await ScanJob.create({ target: 'https://site-cancelled.org', status: 'cancelled', type: 'website' })

    const allJobIds = [jQueued._id, jRunning._id, jCompleted._id, jFailed._id, jCancelled._id]

    // Create pages and candidates for all 5 jobs
    for (const jid of allJobIds) {
      const page = await ScanPage.create({
        scanId: jid,
        url: `https://site.org/page-${jid}`,
        normalizedUrl: `https://site.org/page-${jid}`,
        processingStatus: 'fetched',
        httpStatus: 200,
        source: 'seed',
      })
      await CandidateRecord.create({
        scanJobId: jid,
        pageId: page._id,
        candidateKey: `cand-${jid}`,
        candidateType: 'person',
        extractionStatus: 'candidate',
        sourceUrl: `https://site.org/page-${jid}`,
        fields: { full_name: `Person ${jid}` },
        extractedAt: new Date(),
        parserVersion: '1.0.0',
      })
    }

    // Create persistent business entities: Lead and CompanyProfile
    const preservedCompany = await CompanyProfile.create({
      name: 'Preserved Enterprise Corp',
      domain: 'preserved.org',
      website: 'https://preserved.org',
    })
    const preservedLead = await Lead.create({
      name: 'Alice Preserved',
      email: 'alice@preserved.org',
      company: 'Preserved Enterprise Corp',
      companyId: preservedCompany._id,
      scanId: jCompleted._id,
      candidateKey: `cand-${jCompleted._id}`,
    })

    // 1. Attempt individual deletion of active jobs -> MUST be rejected with 409
    const delRunning = await fetch(`${base}/history/${jRunning._id}`, { method: 'DELETE' })
    assert.equal(delRunning.status, 409, 'Deleting a running job must return 409 Conflict')
    const runningBody = await delRunning.json()
    assert.match(runningBody.error, /active or queued/i)

    const delQueued = await fetch(`${base}/history/${jQueued._id}`, { method: 'DELETE' })
    assert.equal(delQueued.status, 409, 'Deleting a queued job must return 409 Conflict')

    // 2. Perform bulk Clear History while active jobs exist -> MUST be rejected with 409 Conflict
    const clearBlockedRes = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(clearBlockedRes.status, 409, 'Bulk Clear History must be rejected with 409 when active jobs exist')
    const clearBlockedData = await clearBlockedRes.json()
    assert.match(clearBlockedData.error, /Cannot clear history while scans are actively running or queued/i)

    // 3. Remove active jobs to allow Clear All History to proceed
    await ScanJob.deleteMany({ status: { $in: ['queued', 'running'] } })
    await ScanPage.deleteMany({ scanId: { $in: [jQueued._id, jRunning._id] } })
    await CandidateRecord.deleteMany({ scanJobId: { $in: [jQueued._id, jRunning._id] } })

    // 4. Perform bulk Clear History: DELETE /api/history
    const clearRes = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(clearRes.status, 200)
    const clearData = await clearRes.json()
    assert.equal(clearData.success, true)
    assert.equal(clearData.deletedCount, 3, 'Should delete completed, failed, and cancelled jobs (count: 3)')

    // 5. Verify all ScanJobs and pages are purged
    assert.equal(await ScanJob.countDocuments({}), 0, 'All scan jobs must be purged')
    assert.equal(await ScanPage.countDocuments({}), 0, 'All pages must be purged')
    assert.equal(await CandidateRecord.countDocuments({}), 0, 'All candidates must be purged')

    // 6. Verify Complete CRM Reset on Clear All History
    assert.equal(await Lead.countDocuments({}), 0, 'All leads must be wiped on Clear All History')
    assert.equal(await CompanyProfile.countDocuments({}), 0, 'All company profiles must be wiped on Clear All History')
  })

  // ==========================================
  // SECTION 3: 3-TIER LEAD DEDUPLICATION & ENRICHMENT
  // ==========================================

  await t.test('Deduplication & Data Integrity: 3-Tier Resolution & Enrichment Edge Cases', async () => {
    await clearAll()

    const scanA = await ScanJob.create({ target: 'https://alpha-corp.io', status: 'completed', type: 'website' })
    const scanB = await ScanJob.create({ target: 'https://alpha-corp.io/careers', status: 'completed', type: 'website' })

    const pA = await ScanPage.create({
      scanId: scanA._id,
      url: 'https://alpha-corp.io/team',
      normalizedUrl: 'https://alpha-corp.io/team',
      processingStatus: 'fetched',
      source: 'seed',
    })
    const pB = await ScanPage.create({
      scanId: scanB._id,
      url: 'https://alpha-corp.io/leadership',
      normalizedUrl: 'https://alpha-corp.io/leadership',
      processingStatus: 'fetched',
      source: 'seed',
    })

    // --- Tier 1: LinkedIn URL resolution with variations ---
    // Record 1: Has canonical LinkedIn with trailing slash
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'cand-li-1',
        candidateType: 'person',
        sourceUrl: 'https://alpha-corp.io/team',
        fields: {
          full_name: 'Bob Vance',
          designation: 'VP Sales',
          company: 'Alpha Corp',
          linkedin_url: 'https://www.linkedin.com/in/bobvance/',
        },
      },
    })

    const initialBob = await Lead.findOne({ name: 'Bob Vance' })
    assert.ok(initialBob)
    assert.equal(initialBob.title, 'VP Sales')
    assert.equal(initialBob.phone, undefined)

    // Record 2: Discovered on scan B with query params, HTTP instead of HTTPS, and new phone number
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-li-2',
        candidateType: 'person',
        sourceUrl: 'https://alpha-corp.io/leadership',
        fields: {
          full_name: 'Bob Vance',
          designation: 'VP of Sales', // different wording
          company: 'Alpha Corp',
          linkedin_url: 'https://www.linkedin.com/in/bobvance?ref=feed',
          phone: '+1 555 987 6543', // newly enriched phone!
        },
      },
    })

    const bobLeads = await Lead.find({ name: 'Bob Vance' })
    assert.equal(bobLeads.length, 1, 'Tier 1 LinkedIn resolution must deduplicate without creating duplicate lead')
    assert.equal(bobLeads[0].phone, '+1 555 987 6543', 'Missing phone must be enriched onto existing lead')
    assert.equal(bobLeads[0].title, 'VP Sales', 'Original title must not be overwritten if already present')

    // --- Tier 2: Work Email case-insensitivity ---
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'cand-email-1',
        candidateType: 'person',
        sourceUrl: 'https://alpha-corp.io/team',
        fields: {
          full_name: 'Carol Danvers',
          email: 'carol.danvers@alphacorp.io',
          company: 'Alpha Corp',
        },
      },
    })

    // Second discovery with mixed uppercase email
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-email-2',
        candidateType: 'person',
        sourceUrl: 'https://alpha-corp.io/leadership',
        fields: {
          full_name: 'Carol Danvers',
          email: 'Carol.Danvers@AlphaCorp.IO',
          phone: '+1 212 555 0100',
        },
      },
    })

    const carolLeads = await Lead.find({ email: /carol\.danvers/i })
    assert.equal(carolLeads.length, 1, 'Tier 2 Email resolution must deduplicate case-insensitively')
    assert.equal(carolLeads[0].phone, '+1 212 555 0100')

    // --- Tier 3: Normalized Full Name + Company ---
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'cand-name-1',
        candidateType: 'person',
        sourceUrl: 'https://alpha-corp.io/team',
        fields: {
          full_name: 'David Miller',
          company: 'Alpha Corp',
          designation: 'Lead Architect',
        },
      },
    })

    // Edge case: Slight casing in company and name
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-name-2',
        candidateType: 'person',
        sourceUrl: 'https://alpha-corp.io/leadership',
        fields: {
          full_name: 'david miller',
          company: 'alpha corp',
          email: 'david.miller@alphacorp.io',
        },
      },
    })

    const davidLeads = await Lead.find({ name: /david miller/i })
    assert.equal(davidLeads.length, 1, 'Tier 3 Name+Company resolution must deduplicate case-insensitively')
    assert.equal(davidLeads[0].email, 'david.miller@alphacorp.io')
    assert.equal(davidLeads[0].title, 'Lead Architect')
  })

  // ==========================================
  // SECTION 4: COMPANY DIRECTORY, PROFILES & MERGE
  // ==========================================

  await t.test('Company Management: Profile Aggregation, Merge Edge Cases & Deletion Integrity', async () => {
    await clearAll()

    // 1. Create Target Company (Starlight Systems)
    const targetComp = await CompanyProfile.create({
      name: 'Starlight Systems Inc',
      domain: 'starlight.com',
      website: 'https://starlight.com',
      totalLeads: 2,
    })

    // 2. Create Source Company (Starlight Software - duplicate)
    const sourceComp = await CompanyProfile.create({
      name: 'Starlight Software',
      domain: 'starlightsoftware.io',
      website: 'https://starlightsoftware.io',
      industry: 'Cloud Software',
      phone: '+1 800 555 1234',
      totalLeads: 3,
    })

    // 3. Assign Leads
    const lead1 = await Lead.create({ name: 'User One', companyId: targetComp._id, company: targetComp.name, email: 'u1@starlight.com' })
    const lead2 = await Lead.create({ name: 'User Two', companyId: targetComp._id, company: targetComp.name })
    const lead3 = await Lead.create({ name: 'User Three', companyId: sourceComp._id, company: sourceComp.name, phone: '+1 555 3333' })
    const lead4 = await Lead.create({ name: 'User Four', companyId: sourceComp._id, company: sourceComp.name, linkedinUrl: 'https://linkedin.com/in/u4' })
    const lead5 = await Lead.create({ name: 'User Five', companyId: sourceComp._id, company: sourceComp.name })

    // Verify GET /api/companies/:id dynamic counts
    const compDetails = await fetch(`${base}/companies/${targetComp._id}`).then(r => r.json())
    assert.equal(compDetails.totalLeads, 2)
    assert.equal(compDetails.emailCount, 1)

    // Merge Edge Case 1: Self-merge attempt -> MUST return 400
    const selfMerge = await fetch(`${base}/companies/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCompanyId: targetComp._id.toString(), sourceCompanyId: targetComp._id.toString() }),
    })
    assert.equal(selfMerge.status, 400)
    const selfBody = await selfMerge.json()
    assert.match(selfBody.error, /cannot merge a company into itself/i)

    // Merge Edge Case 2: Non-existent target or source
    const fakeId = new mongoose.Types.ObjectId().toString()
    const fakeMerge = await fetch(`${base}/companies/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCompanyId: targetComp._id.toString(), sourceCompanyId: fakeId }),
    })
    assert.equal(fakeMerge.status, 404)

    // Valid Merge Execution
    const mergeRes = await fetch(`${base}/companies/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCompanyId: targetComp._id.toString(), sourceCompanyId: sourceComp._id.toString() }),
    })
    assert.equal(mergeRes.status, 200)
    const mergeData = await mergeRes.json()
    assert.equal(mergeData.success, true)
    assert.equal(mergeData.reassignedLeadsCount, 3)

    // Verify Source company is deleted from DB
    const checkSource = await CompanyProfile.findById(sourceComp._id)
    assert.equal(checkSource, null, 'Source company must be deleted after merge')

    // Verify Target company merged metadata
    const updatedTarget = await CompanyProfile.findById(targetComp._id)
    assert.equal(updatedTarget.industry, 'Cloud Software', 'Industry from source must be merged into target')
    assert.equal(updatedTarget.phone, '+1 800 555 1234', 'Phone from source must be merged into target')
    assert.equal(updatedTarget.website, 'https://starlight.com', 'Target existing website must be preserved')
    assert.equal(updatedTarget.totalLeads, 5, 'Target totalLeads must now be 5')

    // Verify all 5 leads are now linked to Target Company
    const recheckedLeads = await Lead.find({ companyId: targetComp._id })
    assert.equal(recheckedLeads.length, 5)

    // Test Company Deletion: DELETE /api/companies/:id
    // Crucial check: Deleting company profile MUST unlink leads without deleting them
    const delCompRes = await fetch(`${base}/companies/${targetComp._id}`, { method: 'DELETE' })
    assert.equal(delCompRes.status, 200)

    const checkTarget = await CompanyProfile.findById(targetComp._id)
    assert.equal(checkTarget, null, 'Target company should be deleted')

    // Check all 5 leads: Must still exist in database
    const survivingLeads = await Lead.find({ _id: { $in: [lead1._id, lead2._id, lead3._id, lead4._id, lead5._id] } })
    assert.equal(survivingLeads.length, 5, 'All 5 leads must survive company deletion')
    for (const lead of survivingLeads) {
      assert.equal(Boolean(lead.companyId), false, 'Lead companyId must be unlinked ($unset)')
      assert.ok(lead.name, 'Lead name preserved')
    }
  })

  // ==========================================
  // SECTION 5: PERFORMANCE & IN-MEMORY BOTTLENECK AUDIT
  // ==========================================

  await t.test('Performance & Scalability Audit: getEnrichedCompanies Memory & Query Profiling', async () => {
    await clearAll()

    // Seed 100 test companies and 200 leads
    const comps = []
    for (let i = 0; i < 100; i++) {
      comps.push({
        name: `Company Bench ${i}`,
        domain: `bench-${i}.com`,
        website: `https://bench-${i}.com`,
      })
    }
    const createdComps = await CompanyProfile.insertMany(comps)

    const leads = []
    for (let i = 0; i < 200; i++) {
      const c = createdComps[i % 100]
      leads.push({
        name: `Lead ${i}`,
        companyId: c._id,
        company: c.name,
        email: `lead${i}@bench.com`,
      })
    }
    await Lead.insertMany(leads)

    const start = performance.now()
    const res = await fetch(`${base}/companies?page=1&limit=10&paginated=true`)
    const elapsed = performance.now() - start
    assert.equal(res.status, 200)
    const data = await res.json()

    assert.equal(data.total, 100)
    assert.equal(data.items.length, 10)
    assert.ok(elapsed < 2000, `100 companies enriched query took ${elapsed.toFixed(1)}ms`)
  })
})
