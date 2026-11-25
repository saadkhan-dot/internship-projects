import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { ScanJob, ScanPage, CandidateRecord, Lead, PersonProfile, CompanyProfile } from '../src/models/index.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'
import { extractCandidates } from '../src/extraction/candidateExtractor.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_profile_discovery_test'

test('Level 1 Profile Discovery: CRM Isolation, Confidence Scoring, Shortlisting & APIs', async (t) => {
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

  // 1. CRM Isolation: persistCandidate with syncCrm: false creates CandidateRecord but NO CRM leads/profiles
  await t.test('1. CRM Isolation: Level 1 discovery does not create Lead, PersonProfile, or CompanyProfile', async () => {
    const scan = await ScanJob.create({
      target: 'https://example.com',
      domain: 'example.com',
      type: 'website',
      status: 'running'
    })

    const sourceUrl = 'https://example.com/team'
    const page = await ScanPage.create({
      scanId: scan._id,
      url: sourceUrl,
      normalizedUrl: sourceUrl,
      source: 'seed',
      processingStatus: 'fetched'
    })

    const candidateData = {
      candidateKey: 'sarah-connor',
      candidateType: 'person',
      sourceUrl,
      sourceDomain: 'example.com',
      parserVersion: 'v1',
      extractedAt: new Date(),
      fields: {
        full_name: 'Sarah Connor',
        designation: 'VP Engineering',
        email: 'sarah@example.com',
        phone: '+14155550100',
        company: 'Example Corp',
        source_url: 'https://example.com/team/sarah',
        score: 3
      },
      confidenceScore: 3,
      shortlisted: false,
      provenance: []
    }

    const result = await persistCandidate({
      candidate: candidateData,
      scanJobId: scan._id,
      syncCrm: false,
      ScanPageModel: ScanPage,
      CandidateRecordModel: CandidateRecord,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob
    })

    assert.equal(result, true, 'Candidate should be inserted')

    // Verify CandidateRecord exists
    const storedCand = await CandidateRecord.findOne({ scanJobId: scan._id, candidateKey: 'sarah-connor' })
    assert.ok(storedCand, 'CandidateRecord must exist')
    assert.equal(storedCand.confidenceScore, 3)
    assert.equal(storedCand.shortlisted, false)
    assert.equal(storedCand.fields.full_name, 'Sarah Connor')

    // Verify CRM collections are strictly untouched
    const leadCount = await Lead.countDocuments({ scanId: scan._id })
    const personCount = await PersonProfile.countDocuments({ scanId: scan._id })
    const companyCount = await CompanyProfile.countDocuments({})

    assert.equal(leadCount, 0, 'Zero Lead records must be created under Level 1 discovery')
    assert.equal(personCount, 0, 'Zero PersonProfile records must be created under Level 1 discovery')
    assert.equal(companyCount, 0, 'Zero CompanyProfile records must be created under Level 1 discovery')
  })

  // 2. Score Persistence & Extraction
  await t.test('2. Confidence score is computed and persisted correctly during extraction and updates', async () => {
    const scan = await ScanJob.create({
      target: 'https://acme.org',
      domain: 'acme.org',
      type: 'website',
      status: 'completed'
    })

    const teamUrl = 'https://acme.org/team'
    await ScanPage.create({
      scanId: scan._id,
      url: teamUrl,
      normalizedUrl: teamUrl,
      source: 'seed',
      processingStatus: 'fetched'
    })

    // Team directory HTML
    const html = `
      <html><body>
        <div class="team">
          <div class="member">
            <h3>Alice Smith</h3>
            <p>Chief Executive Officer</p>
            <a href="https://acme.org/team/alice">Bio</a>
            <a href="https://linkedin.com/in/alice-smith">LinkedIn</a>
          </div>
          <div class="member">
            <h3>Bob Jones</h3>
            <p>Developer</p>
          </div>
        </div>
      </body></html>
    `
    const { candidates } = extractCandidates(html, { sourceUrl: teamUrl })
    const alice = candidates.find(c => c.fields.full_name === 'Alice Smith')
    const bob = candidates.find(c => c.fields.full_name === 'Bob Jones')

    assert.ok(alice, 'Alice should be extracted')
    assert.ok(bob, 'Bob should be extracted')
    assert.ok(alice.confidenceScore >= 2, `Alice with bio link and linkedin should have confidenceScore >= 2 (got ${alice.confidenceScore})`)
    assert.ok(bob.confidenceScore >= 1, `Bob with title should have confidenceScore >= 1 (got ${bob.confidenceScore})`)

    // Persist both candidates
    await persistCandidate({
      candidate: alice,
      scanJobId: scan._id,
      syncCrm: false,
      ScanPageModel: ScanPage,
      CandidateRecordModel: CandidateRecord,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob
    })

    await persistCandidate({
      candidate: bob,
      scanJobId: scan._id,
      syncCrm: false,
      ScanPageModel: ScanPage,
      CandidateRecordModel: CandidateRecord,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob
    })

    const aliceRecord = await CandidateRecord.findOne({ scanJobId: scan._id, candidateKey: alice.candidateKey })
    const bobRecord = await CandidateRecord.findOne({ scanJobId: scan._id, candidateKey: bob.candidateKey })

    assert.equal(aliceRecord.confidenceScore, alice.confidenceScore)
    assert.equal(bobRecord.confidenceScore, bob.confidenceScore)
    assert.equal(aliceRecord.shortlisted, false)
    assert.equal(bobRecord.shortlisted, false)

    // Score merging: if updated with higher score, higher score is retained
    const aliceHigher = { ...alice, confidenceScore: 3, fields: { ...alice.fields, score: 3 } }
    await persistCandidate({
      candidate: aliceHigher,
      scanJobId: scan._id,
      syncCrm: false,
      ScanPageModel: ScanPage,
      CandidateRecordModel: CandidateRecord,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob
    })
    const aliceUpdated = await CandidateRecord.findOne({ scanJobId: scan._id, candidateKey: alice.candidateKey })
    assert.equal(aliceUpdated.confidenceScore, 3, 'Higher confidence score must be retained on merge')
  })

  // 3. API GET /api/scans/:id/profiles
  await t.test('3. GET /api/scans/:id/profiles returns ranked person profiles with filtering and pagination', async () => {
    const scan = await ScanJob.create({
      target: 'https://corp.test',
      domain: 'corp.test',
      type: 'website',
      status: 'completed'
    })

    const page = await ScanPage.create({
      scanId: scan._id,
      url: 'https://corp.test/team',
      normalizedUrl: 'https://corp.test/team',
      source: 'seed',
      processingStatus: 'fetched'
    })

    // Seed 4 candidates: 3 persons (varying scores, 1 shortlisted), 1 company
    await CandidateRecord.create({
      scanJobId: scan._id,
      pageId: page._id,
      candidateKey: 'p1',
      candidateType: 'person',
      fields: { full_name: 'Charlie Brown', designation: 'Architect', company: 'Corp Test' },
      sourceUrl: 'https://corp.test/charlie',
      confidenceScore: 3,
      shortlisted: false,
      extractedAt: new Date(),
      parserVersion: 'v1'
    })

    await CandidateRecord.create({
      scanJobId: scan._id,
      pageId: page._id,
      candidateKey: 'p2',
      candidateType: 'person',
      fields: { full_name: 'Diana Prince', designation: 'Security Director', company: 'Corp Test' },
      sourceUrl: 'https://corp.test/diana',
      confidenceScore: 2,
      shortlisted: true,
      extractedAt: new Date(),
      parserVersion: 'v1'
    })

    await CandidateRecord.create({
      scanJobId: scan._id,
      pageId: page._id,
      candidateKey: 'p3',
      candidateType: 'person',
      fields: { full_name: 'Evan Wright', designation: 'Junior Analyst', company: 'Corp Test' },
      sourceUrl: 'https://corp.test/evan',
      confidenceScore: 1,
      shortlisted: false,
      extractedAt: new Date(),
      parserVersion: 'v1'
    })

    // Non-person candidate: should be excluded from /profiles
    await CandidateRecord.create({
      scanJobId: scan._id,
      pageId: page._id,
      candidateKey: 'c1',
      candidateType: 'company',
      fields: { name: 'Corp Test Inc', company: 'Corp Test Inc' },
      sourceUrl: 'https://corp.test/about',
      confidenceScore: 3,
      shortlisted: false,
      extractedAt: new Date(),
      parserVersion: 'v1'
    })

    // Fetch all profiles for scan
    const resAll = await fetch(`${base}/scans/${scan._id}/profiles`)
    assert.equal(resAll.status, 200)
    const dataAll = await resAll.json()

    assert.equal(dataAll.total, 3, 'Total should only include person candidates (3)')
    assert.equal(dataAll.items.length, 3)
    // Check descending confidence score order: Charlie (3) -> Diana (2) -> Evan (1)
    assert.equal(dataAll.items[0].name, 'Charlie Brown')
    assert.equal(dataAll.items[0].confidenceScore, 3)
    assert.equal(dataAll.items[1].name, 'Diana Prince')
    assert.equal(dataAll.items[1].confidenceScore, 2)
    assert.equal(dataAll.items[2].name, 'Evan Wright')
    assert.equal(dataAll.items[2].confidenceScore, 1)

    // Check shortlisted filter: shortlisted=true
    const resShort = await fetch(`${base}/scans/${scan._id}/profiles?shortlisted=true`)
    assert.equal(resShort.status, 200)
    const dataShort = await resShort.json()
    assert.equal(dataShort.total, 1)
    assert.equal(dataShort.items[0].name, 'Diana Prince')
    assert.equal(dataShort.items[0].shortlisted, true)

    // Check search query: q=Director
    const resSearch = await fetch(`${base}/scans/${scan._id}/profiles?q=Director`)
    assert.equal(resSearch.status, 200)
    const dataSearch = await resSearch.json()
    assert.equal(dataSearch.total, 1)
    assert.equal(dataSearch.items[0].name, 'Diana Prince')

    // Check search query by name: q=charlie
    const resSearchName = await fetch(`${base}/scans/${scan._id}/profiles?q=charlie`)
    assert.equal(resSearchName.status, 200)
    const dataSearchName = await resSearchName.json()
    assert.equal(dataSearchName.total, 1)
    assert.equal(dataSearchName.items[0].name, 'Charlie Brown')

    // Check pagination: limit=1&skip=1
    const resPage = await fetch(`${base}/scans/${scan._id}/profiles?limit=1&skip=1`)
    assert.equal(resPage.status, 200)
    const dataPage = await resPage.json()
    assert.equal(dataPage.total, 3)
    assert.equal(dataPage.items.length, 1)
    assert.equal(dataPage.items[0].name, 'Diana Prince')
  })

  // 4. API PATCH /api/scans/:id/profiles/:candidateId/shortlist
  await t.test('4. PATCH /api/scans/:id/profiles/:candidateId/shortlist updates shortlist state and validates input', async () => {
    const scanA = await ScanJob.create({
      target: 'https://scana.test',
      domain: 'scana.test',
      type: 'website',
      status: 'completed'
    })

    const scanB = await ScanJob.create({
      target: 'https://scanb.test',
      domain: 'scanb.test',
      type: 'website',
      status: 'completed'
    })

    const pageA = await ScanPage.create({
      scanId: scanA._id,
      url: 'https://scana.test/team',
      normalizedUrl: 'https://scana.test/team',
      source: 'seed',
      processingStatus: 'fetched'
    })

    const candA = await CandidateRecord.create({
      scanJobId: scanA._id,
      pageId: pageA._id,
      candidateKey: 'candA',
      candidateType: 'person',
      fields: { full_name: 'Candidate A', designation: 'Engineer' },
      sourceUrl: 'https://scana.test/team',
      confidenceScore: 2,
      shortlisted: false,
      extractedAt: new Date(),
      parserVersion: 'v1'
    })

    const nonPerson = await CandidateRecord.create({
      scanJobId: scanA._id,
      pageId: pageA._id,
      candidateKey: 'candCompany',
      candidateType: 'company',
      fields: { name: 'Company A' },
      sourceUrl: 'https://scana.test/about',
      confidenceScore: 2,
      shortlisted: false,
      extractedAt: new Date(),
      parserVersion: 'v1'
    })

    // Shortlist candidate A: true
    const res1 = await fetch(`${base}/scans/${scanA._id}/profiles/${candA._id}/shortlist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortlisted: true })
    })
    assert.equal(res1.status, 200)
    const data1 = await res1.json()
    assert.equal(data1.id, String(candA._id))
    assert.equal(data1.shortlisted, true)

    // Verify DB update
    const dbCand1 = await CandidateRecord.findById(candA._id)
    assert.equal(dbCand1.shortlisted, true)

    // Un-shortlist candidate A: false
    const res2 = await fetch(`${base}/scans/${scanA._id}/profiles/${candA._id}/shortlist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortlisted: false })
    })
    assert.equal(res2.status, 200)
    const data2 = await res2.json()
    assert.equal(data2.shortlisted, false)

    const dbCand2 = await CandidateRecord.findById(candA._id)
    assert.equal(dbCand2.shortlisted, false)

    // Validation: missing / invalid shortlisted type (non-boolean)
    const resInvalidType = await fetch(`${base}/scans/${scanA._id}/profiles/${candA._id}/shortlist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortlisted: 'true' })
    })
    assert.equal(resInvalidType.status, 400)
    const dataInvalid = await resInvalidType.json()
    assert.ok(dataInvalid.error.includes('boolean'))

    // Validation: candidate does not belong to scanB
    const resWrongScan = await fetch(`${base}/scans/${scanB._id}/profiles/${candA._id}/shortlist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortlisted: true })
    })
    assert.equal(resWrongScan.status, 404)

    // Validation: cannot shortlist non-person candidate
    const resNonPerson = await fetch(`${base}/scans/${scanA._id}/profiles/${nonPerson._id}/shortlist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortlisted: true })
    })
    assert.equal(resNonPerson.status, 400)
    const dataNonPerson = await resNonPerson.json()
    assert.ok(dataNonPerson.error.includes('person candidates'))

    // Validation: invalid ObjectId
    const resInvalidId = await fetch(`${base}/scans/invalid-id/profiles/${candA._id}/shortlist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortlisted: true })
    })
    assert.equal(resInvalidId.status, 400)
  })
})
