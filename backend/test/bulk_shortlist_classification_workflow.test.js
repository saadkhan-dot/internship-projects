import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { Lead, PersonProfile, CompanyProfile, ScanJob, ScanPage, CandidateRecord } from '../src/models/index.js'
import { isCandidateVerified, getCandidateClassification } from '../src/services/contactExtraction.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const mockProvenance = (fieldName, value, sourceUrl = 'https://ex.test/') => ({
  fieldName,
  value,
  evidence: String(value),
  sourceUrl,
  method: 'pattern_match',
  extractedAt: new Date(),
  ruleVersion: 'deterministic-1',
})

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_bulk_workflow_test'

test('LeadIntel: Bulk Shortlisting & Verified/Unverified Workflow Test Suite', async (t) => {
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
    LEADINTEL_ALLOW_LOCAL_FIXTURES: 'true',
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
  assert.ok(healthy, 'Backend server must boot and connect to MongoDB')

  t.after(async () => {
    if (apiServer) {
      apiServer.kill('SIGTERM')
      await wait(100)
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

  // ========================================================
  // 1. UNIT TESTS: Classification Rules
  // ========================================================

  await t.test('1. Unit: isCandidateVerified correctly identifies Verified vs Unverified candidates', () => {
    // Verified: valid email + email provenance
    const verifiedEmail = {
      extractionStatus: 'completed',
      fields: { full_name: 'Alice Cooper', email: 'alice@rock.test' },
      provenance: [{ fieldName: 'email', value: 'alice@rock.test', evidence: 'alice@rock.test', sourceUrl: 'https://ex.test/bio' }],
    }
    assert.equal(isCandidateVerified(verifiedEmail), true)
    assert.equal(getCandidateClassification(verifiedEmail), 'verified')

    // Verified: valid phone + phone provenance
    const verifiedPhone = {
      extractionStatus: 'completed',
      fields: { full_name: 'Bob Marley', phone: '+1 555-123-4567' },
      provenance: [{ fieldName: 'phone', value: '+1 555-123-4567', evidence: '+1 555-123-4567', sourceUrl: 'https://ex.test/bio' }],
    }
    assert.equal(isCandidateVerified(verifiedPhone), true)
    assert.equal(getCandidateClassification(verifiedPhone), 'verified')

    // Unverified: No contact info at all
    const noContact = {
      extractionStatus: 'completed',
      fields: { full_name: 'Charlie Chaplin' },
      provenance: [],
    }
    assert.equal(isCandidateVerified(noContact), false)
    assert.equal(getCandidateClassification(noContact), 'unverified')

    // Unverified: Invalid email syntax
    const invalidEmail = {
      extractionStatus: 'completed',
      fields: { full_name: 'Dave Grohl', email: 'not-an-email' },
      provenance: [{ fieldName: 'email', value: 'not-an-email', evidence: 'not-an-email' }],
    }
    assert.equal(isCandidateVerified(invalidEmail), false)

    // Unverified: Invalid phone syntax (< 7 digits)
    const invalidPhone = {
      extractionStatus: 'completed',
      fields: { full_name: 'Emma Stone', phone: '123' },
      provenance: [{ fieldName: 'phone', value: '123', evidence: '123' }],
    }
    assert.equal(isCandidateVerified(invalidPhone), false)

    // Unverified: Valid email but no supporting evidence in provenance
    const missingEvidence = {
      extractionStatus: 'completed',
      fields: { full_name: 'Frank Sinatra', email: 'frank@music.test' },
      provenance: [],
    }
    assert.equal(isCandidateVerified(missingEvidence), false)

    // Unverified: Extraction failed
    const failedCandidate = {
      extractionStatus: 'failed',
      fields: { full_name: 'Grace Hopper', email: 'grace@navy.test' },
      provenance: [{ fieldName: 'email', value: 'grace@navy.test', evidence: 'grace@navy.test' }],
    }
    assert.equal(isCandidateVerified(failedCandidate), false)
  })

  // ========================================================
  // 2. INTEGRATION TESTS: Bulk Shortlisting
  // ========================================================

  await t.test('2. Bulk Shortlisting: Shortlist All and Remove All from current scan', async () => {
    const scanA = await ScanJob.create({ target: 'https://scan-a.test', status: 'completed' })
    const scanB = await ScanJob.create({ target: 'https://scan-b.test', status: 'completed' })
    const pageA = await ScanPage.create({ scanId: scanA._id, url: 'https://scan-a.test/', normalizedUrl: 'https://scan-a.test/', source: 'seed' })
    const pageB = await ScanPage.create({ scanId: scanB._id, url: 'https://scan-b.test/', normalizedUrl: 'https://scan-b.test/', source: 'seed' })

    const c1 = await CandidateRecord.create({
      scanJobId: scanA._id, pageId: pageA._id, candidateKey: 'key-a1', candidateType: 'person',
      fields: { full_name: 'Candidate A1' }, shortlisted: false, sourceUrl: 'https://scan-a.test/', extractedAt: new Date(), parserVersion: 'v1',
    })
    const c2 = await CandidateRecord.create({
      scanJobId: scanA._id, pageId: pageA._id, candidateKey: 'key-a2', candidateType: 'person',
      fields: { full_name: 'Candidate A2' }, shortlisted: false, sourceUrl: 'https://scan-a.test/', extractedAt: new Date(), parserVersion: 'v1',
    })
    const cB = await CandidateRecord.create({
      scanJobId: scanB._id, pageId: pageB._id, candidateKey: 'key-b1', candidateType: 'person',
      fields: { full_name: 'Candidate B1' }, shortlisted: false, sourceUrl: 'https://scan-b.test/', extractedAt: new Date(), parserVersion: 'v1',
    })

    // 1. Shortlist All for Scan A
    const resShortlist = await fetch(`${base}/scans/${scanA._id}/profiles/shortlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortlistAll: true }),
    })
    assert.equal(resShortlist.status, 200)
    const dataShortlist = await resShortlist.json()
    assert.equal(dataShortlist.success, true)
    assert.equal(dataShortlist.shortlisted, true)
    assert.equal(dataShortlist.totalShortlisted, 2)

    // Check database state
    const c1Reload = await CandidateRecord.findById(c1._id)
    const c2Reload = await CandidateRecord.findById(c2._id)
    const cBReload = await CandidateRecord.findById(cB._id)
    assert.equal(c1Reload.shortlisted, true)
    assert.equal(c2Reload.shortlisted, true)
    // Scan B candidate MUST remain false (scan isolation)
    assert.equal(cBReload.shortlisted, false)

    // 2. Remove All from shortlist for Scan A
    const resRemove = await fetch(`${base}/scans/${scanA._id}/profiles/shortlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeAll: true }),
    })
    assert.equal(resRemove.status, 200)
    const dataRemove = await resRemove.json()
    assert.equal(dataRemove.success, true)
    assert.equal(dataRemove.shortlisted, false)
    assert.equal(dataRemove.totalShortlisted, 0)

    const c1After = await CandidateRecord.findById(c1._id)
    assert.equal(c1After.shortlisted, false)
  })

  // ========================================================
  // 3. INTEGRATION TESTS: Bulk Contact Extraction
  // ========================================================

  await t.test('3. Bulk Extraction of all shortlisted candidates with automatic classification', async () => {
    const scan = await ScanJob.create({ target: 'https://extract-test.org', status: 'completed' })
    const page = await ScanPage.create({ scanId: scan._id, url: 'https://extract-test.org/', normalizedUrl: 'https://extract-test.org/', source: 'seed' })

    // Candidate 1: Shortlisted, has email in fields -> Will become Verified
    const cand1 = await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'ext-1', candidateType: 'person',
      fields: { full_name: 'Dr. Ada Lovelace', email: 'ada@computing.org' },
      shortlisted: true,
      provenance: [mockProvenance('email', 'ada@computing.org', 'https://extract-test.org/')],
      sourceUrl: 'https://extract-test.org/', extractedAt: new Date(), parserVersion: 'v1',
    })

    // Candidate 2: Shortlisted, no email/phone -> Will become Unverified
    const cand2 = await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'ext-2', candidateType: 'person',
      fields: { full_name: 'Charles Babbage' },
      shortlisted: true,
      provenance: [],
      sourceUrl: 'https://extract-test.org/', extractedAt: new Date(), parserVersion: 'v1',
    })

    // Candidate 3: NOT shortlisted -> Must NOT be extracted
    const cand3 = await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'ext-3', candidateType: 'person',
      fields: { full_name: 'Alan Turing' },
      shortlisted: false,
      provenance: [],
      sourceUrl: 'https://extract-test.org/', extractedAt: new Date(), parserVersion: 'v1',
    })

    // Run bulk extraction on all shortlisted candidates
    const resExtract = await fetch(`${base}/scans/${scan._id}/extract-contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allShortlisted: true }),
    })
    assert.equal(resExtract.status, 200)
    const dataExtract = await resExtract.json()
    assert.equal(dataExtract.total, 2, 'Only the 2 shortlisted candidates should be extracted')

    // Verify classification
    const c1After = await CandidateRecord.findById(cand1._id)
    const c2After = await CandidateRecord.findById(cand2._id)
    const c3After = await CandidateRecord.findById(cand3._id)

    assert.equal(c1After.classification, 'verified')
    assert.equal(c2After.classification, 'unverified')
    assert.equal(c3After.extractionStatus, 'candidate', 'Non-shortlisted candidate remains unextracted')
  })

  // ========================================================
  // 4. INTEGRATION TESTS: Category Filtering and Counts
  // ========================================================

  await t.test('4. Category Tabs: Counts and filtering for Verified, Unverified, Extracted, and Shortlisted', async () => {
    const scan = await ScanJob.create({ target: 'https://category-test.org', status: 'completed' })
    const page = await ScanPage.create({ scanId: scan._id, url: 'https://category-test.org/', normalizedUrl: 'https://category-test.org/', source: 'seed' })

    // Verified candidate
    await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'cat-1', candidateType: 'person',
      fields: { full_name: 'Verified Person', email: 'v@cat.test' },
      classification: 'verified', shortlisted: true, extractionStatus: 'completed',
      provenance: [mockProvenance('email', 'v@cat.test', 'https://category-test.org/')],
      sourceUrl: 'https://category-test.org/', extractedAt: new Date(), parserVersion: 'v1',
    })

    // Unverified candidate
    await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'cat-2', candidateType: 'person',
      fields: { full_name: 'Unverified Person' },
      classification: 'unverified', shortlisted: true, extractionStatus: 'needs_review',
      provenance: [],
      sourceUrl: 'https://category-test.org/', extractedAt: new Date(), parserVersion: 'v1',
    })

    // 1. Fetch profiles without category filter -> Returns all + counts
    const resAll = await fetch(`${base}/scans/${scan._id}/profiles`)
    assert.equal(resAll.status, 200)
    const dataAll = await resAll.json()
    assert.equal(dataAll.total, 2)
    assert.ok(dataAll.counts, 'Must include category counts')
    assert.equal(dataAll.counts.all, 2)
    assert.equal(dataAll.counts.shortlisted, 2)
    assert.equal(dataAll.counts.verified, 1)
    assert.equal(dataAll.counts.unverified, 1)

    // 2. Fetch category=verified
    const resVerified = await fetch(`${base}/scans/${scan._id}/profiles?category=verified`)
    const dataVerified = await resVerified.json()
    assert.equal(dataVerified.total, 1)
    assert.equal(dataVerified.items[0].name, 'Verified Person')
    assert.equal(dataVerified.items[0].classification, 'verified')

    // 3. Fetch category=unverified
    const resUnverified = await fetch(`${base}/scans/${scan._id}/profiles?category=unverified`)
    const dataUnverified = await resUnverified.json()
    assert.equal(dataUnverified.total, 1)
    assert.equal(dataUnverified.items[0].name, 'Unverified Person')
    assert.equal(dataUnverified.items[0].classification, 'unverified')
  })

  // ========================================================
  // 5. INTEGRATION TESTS: CRM Promotion Selection
  // ========================================================

  await t.test('5. CRM Promotion Selection: Promote Verified, Unverified, Both, and Selected', async () => {
    await Lead.deleteMany({})
    await PersonProfile.deleteMany({})

    const scan = await ScanJob.create({ target: 'https://promo-test.org', status: 'completed' })
    const page = await ScanPage.create({ scanId: scan._id, url: 'https://promo-test.org/', normalizedUrl: 'https://promo-test.org/', source: 'seed' })

    const candVerified = await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'p-1', candidateType: 'person',
      fields: { full_name: 'Verified Engineer', email: 'verified@eng.org', company: 'Acme Corp' },
      classification: 'verified', shortlisted: true, extractionStatus: 'completed',
      provenance: [mockProvenance('email', 'verified@eng.org', 'https://promo-test.org/')],
      sourceUrl: 'https://promo-test.org/', extractedAt: new Date(), parserVersion: 'v1',
    })

    const candUnverified = await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'p-2', candidateType: 'person',
      fields: { full_name: 'Unverified Designer', company: 'Acme Corp' },
      classification: 'unverified', shortlisted: true, extractionStatus: 'needs_review',
      provenance: [],
      sourceUrl: 'https://promo-test.org/', extractedAt: new Date(), parserVersion: 'v1',
    })

    // 1. Promote Verified only
    const resPromoteVerified = await fetch(`${base}/scans/${scan._id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'verified' }),
    })
    assert.equal(resPromoteVerified.status, 200)
    const dataPV = await resPromoteVerified.json()
    assert.equal(dataPV.promoted, 1)

    // Check that Verified Engineer is now a Lead, but Unverified Designer is NOT
    const leadVerified = await Lead.findOne({ email: 'verified@eng.org' })
    assert.ok(leadVerified, 'Verified Engineer must be created in CRM')
    const leadUnverified = await Lead.findOne({ name: 'Unverified Designer' })
    assert.equal(leadUnverified, null, 'Unverified Designer must NOT be promoted yet')

    // 2. Idempotency: Repeating promote category='verified' creates 0 new leads
    const resRepeat = await fetch(`${base}/scans/${scan._id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'verified' }),
    })
    const dataRepeat = await resRepeat.json()
    assert.equal(dataRepeat.promoted, 0)
    assert.equal(dataRepeat.alreadyPromoted, 1)

    // 3. Promote Unverified
    const resPromoteUnverified = await fetch(`${base}/scans/${scan._id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'unverified' }),
    })
    assert.equal(resPromoteUnverified.status, 200)
    const dataPU = await resPromoteUnverified.json()
    assert.equal(dataPU.promoted, 1)

    const leadUnverifiedAfter = await Lead.findOne({ name: 'Unverified Designer' })
    assert.ok(leadUnverifiedAfter, 'Unverified Designer should now be promoted to CRM')

    // 4. Scan Ownership check: Cannot promote candidates from another scan
    const otherScan = await ScanJob.create({ target: 'https://other.org', status: 'completed' })
    const resForbidden = await fetch(`${base}/scans/${otherScan._id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateIds: [candVerified._id.toString()] }),
    })
    assert.equal(resForbidden.status, 400)
  })

  await t.test('6. Promote Both and Individual Candidate Selection', async () => {
    await Lead.deleteMany({})
    const scan = await ScanJob.create({ target: 'https://both-test.org', status: 'completed' })
    const page = await ScanPage.create({ scanId: scan._id, url: 'https://both-test.org/', normalizedUrl: 'https://both-test.org/', source: 'seed' })

    const cand1 = await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'b-1', candidateType: 'person',
      fields: { full_name: 'Person One', email: 'p1@both.test' },
      classification: 'verified', shortlisted: true,
      provenance: [mockProvenance('email', 'p1@both.test')],
      sourceUrl: 'https://both-test.org/', extractedAt: new Date(), parserVersion: 'v1',
    })
    const cand2 = await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'b-2', candidateType: 'person',
      fields: { full_name: 'Person Two' },
      classification: 'unverified', shortlisted: true,
      provenance: [],
      sourceUrl: 'https://both-test.org/', extractedAt: new Date(), parserVersion: 'v1',
    })

    // Individual promotion via candidateIds
    const resIndiv = await fetch(`${base}/scans/${scan._id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateIds: [cand1._id.toString()] }),
    })
    assert.equal(resIndiv.status, 200)
    const dataIndiv = await resIndiv.json()
    assert.equal(dataIndiv.promoted, 1)
    assert.equal(await Lead.countDocuments({ scanId: scan._id }), 1)

    // Promote Both: promotes remaining candidate 2 and safely recognizes candidate 1 as already promoted
    const resBoth = await fetch(`${base}/scans/${scan._id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'both' }),
    })
    assert.equal(resBoth.status, 200)
    const dataBoth = await resBoth.json()
    assert.equal(dataBoth.promoted, 1)
    assert.equal(dataBoth.alreadyPromoted, 1)
    assert.equal(await Lead.countDocuments({ scanId: scan._id }), 2)
  })

  await t.test('7. Failed Extraction Classification, Retry, and Existing CRM Data Preservation', async () => {
    const scan = await ScanJob.create({ target: 'https://retry-preserv.org', status: 'completed' })
    const page = await ScanPage.create({ scanId: scan._id, url: 'https://retry-preserv.org/', normalizedUrl: 'https://retry-preserv.org/', source: 'seed' })

    // Existing high-quality lead in CRM
    const existingLead = await Lead.create({
      name: 'Dr. Jane Goodall',
      email: 'jane@primates.org',
      phone: '+1 555-987-6543',
      notes: 'Important conservation partner with multi-year engagement.',
      status: 'qualified',
    })

    // Candidate initially failed extraction
    const candFailed = await CandidateRecord.create({
      scanJobId: scan._id, pageId: page._id, candidateKey: 'fail-1', candidateType: 'person',
      fields: { full_name: 'Dr. Jane Goodall', email: 'jane@primates.org', extractionError: 'Temporary network timeout' },
      extractionStatus: 'failed',
      classification: 'unverified',
      shortlisted: true,
      provenance: [],
      sourceUrl: 'https://retry-preserv.org/', extractedAt: new Date(), parserVersion: 'v1',
    })

    assert.equal(isCandidateVerified(candFailed), false, 'Failed extraction candidate must be unverified')

    // Retry extraction
    candFailed.extractionStatus = 'completed'
    delete candFailed.fields.extractionError
    candFailed.provenance = [mockProvenance('email', 'jane@primates.org', 'https://retry-preserv.org/bio')]
    candFailed.classification = isCandidateVerified(candFailed) ? 'verified' : 'unverified'
    await candFailed.save()

    assert.equal(candFailed.classification, 'verified', 'Retried candidate with valid email and provenance becomes verified')

    // Promote verified retried candidate: must reuse existing lead and preserve existing notes and phone
    const resPromote = await fetch(`${base}/scans/${scan._id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'verified' }),
    })
    assert.equal(resPromote.status, 200)
    const dataP = await resPromote.json()
    assert.equal(dataP.reused, 1)

    const preservedLead = await Lead.findById(existingLead._id)
    assert.equal(preservedLead.notes, 'Important conservation partner with multi-year engagement.', 'Existing notes must not be overwritten')
    assert.equal(preservedLead.phone, '+1 555-987-6543', 'Existing phone must not be overwritten')
    assert.equal(preservedLead.status, 'qualified', 'Existing status must not be degraded')
  })
})
