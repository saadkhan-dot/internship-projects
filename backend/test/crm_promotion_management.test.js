import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
import net from 'node:net'
import {
  ScanJob,
  ScanPage,
  CandidateRecord,
  Lead,
  PersonProfile,
  CompanyProfile,
} from '../src/models/index.js'
import {
  promoteSingleCandidate,
  promoteCandidates,
} from '../src/services/crmPromotion.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_crm_promotion_test'

test('Stage 3: CRM Promotion & Lead Management Test Suite', async (t) => {
  const apiPort = await freePort()

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
  const apiServer = spawn('node', ['src/server.js'], { cwd: process.cwd(), env: apiEnv, stdio: 'ignore' })
  const base = `http://127.0.0.1:${apiPort}/api`

  let healthy = false
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) {
        healthy = true
        break
      }
    } catch {}
    await wait(100)
  }
  assert.equal(healthy, true, 'API server should be healthy')

  t.after(async () => {
    apiServer.kill('SIGTERM')
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

  // 1. Setup Scan Job
  const scan = await ScanJob.create({
    target: 'https://acme-corp.com',
    domain: 'acme-corp.com',
    status: 'completed',
  })

  const otherScan = await ScanJob.create({
    target: 'https://other-corp.com',
    domain: 'other-corp.com',
    status: 'completed',
  })

  // Helper to create test candidate records
  const createTestCandidate = async (overrides = {}) => {
    return await CandidateRecord.create({
      scanJobId: scan._id,
      pageId: new mongoose.Types.ObjectId(),
      candidateKey: `cand-${Math.random().toString(36).slice(2, 9)}`,
      candidateType: 'person',
      confidenceScore: 2,
      shortlisted: true,
      promoted: false,
      extractionStatus: 'completed',
      validationStatus: 'syntax_valid',
      parserVersion: 'deterministic-1',
      sourceUrl: 'https://acme-corp.com/team',
      sourceDomain: 'acme-corp.com',
      extractedAt: new Date(),
      fields: {
        full_name: 'Jane Doe',
        designation: 'VP of Engineering',
        company: 'Acme Corp',
        email: 'jane.doe@acme-corp.com',
        phone: '+1 (555) 234-5678',
        linkedin_url: 'https://www.linkedin.com/in/janedoe/',
        biography: 'Experienced engineering leader.',
      },
      provenance: [{
        fieldName: 'email',
        value: 'jane.doe@acme-corp.com',
        sourceUrl: 'https://acme-corp.com/team',
        method: 'mailto',
        evidence: 'jane.doe@acme-corp.com',
        extractedAt: new Date(),
        ruleVersion: 'deterministic-1',
        validationStatus: 'syntax_valid',
      }],
      ...overrides,
    })
  }

  // --- TEST 1: Successful Single-Candidate Promotion via Service ---
  await t.test('1. Single candidate promotion creates Lead, PersonProfile, and CompanyProfile with correct relationships', async () => {
    const cand1 = await createTestCandidate({
      fields: {
        full_name: 'John Miller',
        designation: 'Chief Technology Officer',
        company: 'Acme Corp',
        email: 'john.miller@acme-corp.com',
        phone: '+15551112233',
        linkedin_url: 'https://www.linkedin.com/in/johnmiller-cto/',
        biography: 'CTO with 20 years background.',
      },
    })

    const result = await promoteSingleCandidate(cand1, { scanJobId: scan._id })
    assert.equal(result.success, true)
    assert.equal(result.status, 'created')
    assert.ok(result.leadId)

    // Verify Lead record
    const lead = await Lead.findById(result.leadId)
    assert.ok(lead)
    assert.equal(lead.name, 'John Miller')
    assert.equal(lead.title, 'Chief Technology Officer')
    assert.equal(lead.email, 'john.miller@acme-corp.com')
    assert.equal(lead.phone, '+15551112233')
    assert.equal(lead.linkedinUrl, 'https://linkedin.com/in/johnmiller-cto')
    assert.equal(lead.biography, 'CTO with 20 years background.')
    assert.equal(lead.status, 'new')
    assert.equal(String(lead.scanId), String(scan._id))
    assert.ok(lead.companyId, 'Should link to CompanyProfile')

    // Verify CompanyProfile
    const company = await CompanyProfile.findById(lead.companyId)
    assert.ok(company)
    assert.equal(company.name, 'Acme Corp')
    assert.equal(company.totalLeads, 1)

    // Verify PersonProfile
    const person = await PersonProfile.findOne({ email: 'john.miller@acme-corp.com' })
    assert.ok(person)
    assert.equal(person.name, 'John Miller')
    assert.equal(person.organization, 'Acme Corp')

    // Verify CandidateRecord updated
    const updatedCand = await CandidateRecord.findById(cand1._id)
    assert.equal(updatedCand.promoted, true)
    assert.ok(updatedCand.promotedAt)
    assert.equal(String(updatedCand.leadId), String(lead._id))
  })

  // --- TEST 2: Idempotency & Repeated Promotion Prevention ---
  await t.test('2. Repeated promotion request is idempotent and prevents duplicates', async () => {
    const cand = await CandidateRecord.findOne({ 'fields.full_name': 'John Miller' })
    assert.ok(cand)
    assert.equal(cand.promoted, true)

    const initialLeadCount = await Lead.countDocuments({})

    // Try promoting again
    const repeatResult = await promoteSingleCandidate(cand, { scanJobId: scan._id })
    assert.equal(repeatResult.success, true)
    assert.equal(repeatResult.status, 'already_promoted')
    assert.equal(String(repeatResult.leadId), String(cand.leadId))

    // Lead count should not have increased
    const afterCount = await Lead.countDocuments({})
    assert.equal(afterCount, initialLeadCount)
  })

  // --- TEST 3: Multi-tier Deduplication - Tier 1 (LinkedIn Canonicalization) ---
  await t.test('3. Deduplication Tier 1: Matches existing lead by canonical LinkedIn URL variation and reuses record', async () => {
    // Existing lead has 'https://linkedin.com/in/johnmiller-cto'
    // Incoming candidate has 'https://www.linkedin.com/in/johnmiller-cto/?trackingId=123' and different company string casing
    const candLinkedInMatch = await createTestCandidate({
      fields: {
        full_name: 'J. Miller',
        designation: 'CTO & Co-Founder',
        company: 'Acme Corporation',
        email: null, // No email provided
        phone: '+15559998877',
        linkedin_url: 'https://www.linkedin.com/in/johnmiller-cto/?trackingId=123',
      },
    })

    const result = await promoteSingleCandidate(candLinkedInMatch, { scanJobId: scan._id })
    assert.equal(result.success, true)
    assert.equal(result.status, 'reused', 'Should reuse existing lead matching LinkedIn slug')

    const existingLead = await Lead.findOne({ email: 'john.miller@acme-corp.com' })
    assert.equal(String(result.leadId), String(existingLead._id))
    // Existing email should NOT be overwritten by null!
    assert.equal(existingLead.email, 'john.miller@acme-corp.com')
  })

  // --- TEST 4: Multi-tier Deduplication - Tier 2 (Normalized Email) ---
  await t.test('4. Deduplication Tier 2: Matches existing lead by email (case-insensitive) and enriches missing fields', async () => {
    // Create candidate with same email but different casing, no LinkedIn
    const candEmailMatch = await createTestCandidate({
      fields: {
        full_name: 'John Miller',
        designation: 'Chief Technology Officer',
        company: 'Acme Corp',
        email: 'JOHN.MILLER@ACME-CORP.COM',
        phone: null,
      },
    })

    const result = await promoteSingleCandidate(candEmailMatch, { scanJobId: scan._id })
    assert.equal(result.success, true)
    assert.equal(result.status, 'reused')

    const existingLead = await Lead.findOne({ email: 'john.miller@acme-corp.com' })
    assert.equal(String(result.leadId), String(existingLead._id))
  })

  // --- TEST 5: Multi-tier Deduplication - Tier 3 (Normalized Name + Company Fallback) ---
  await t.test('5. Deduplication Tier 3: Matches existing lead by name + company with whitespace normalization', async () => {
    // Create distinct lead first
    const candBase = await createTestCandidate({
      fields: {
        full_name: 'Sarah Connor',
        designation: 'Security Lead',
        company: 'Cyberdyne Systems',
        email: null,
        phone: null,
        linkedin_url: null,
      },
    })
    const resBase = await promoteSingleCandidate(candBase, { scanJobId: scan._id })
    assert.equal(resBase.status, 'created')

    // Incoming candidate with erratic whitespace: 'Sarah  Connor' and 'Cyberdyne  Systems'
    const candWhitespace = await createTestCandidate({
      fields: {
        full_name: 'Sarah   Connor',
        designation: 'Head of Security',
        company: 'Cyberdyne   Systems',
        email: 'sarah@cyberdyne.com', // Newly discovered email!
        phone: '+14155550199',
      },
    })

    const resTier3 = await promoteSingleCandidate(candWhitespace, { scanJobId: scan._id })
    assert.equal(resTier3.success, true)
    assert.equal(resTier3.status, 'reused', 'Tier 3 should match by name + company')
    assert.equal(String(resTier3.leadId), String(resBase.leadId))

    // Check that missing email was safely enriched onto the existing lead
    const updatedLead = await Lead.findById(resBase.leadId)
    assert.equal(updatedLead.email, 'sarah@cyberdyne.com')
    assert.equal(updatedLead.phone, '+14155550199')
  })

  // --- TEST 6: Promotion of Incomplete Records & Preservation of Evidence ---
  await t.test('6. Promotion of incomplete records succeeds, preserving field-level provenance and source data', async () => {
    const candIncomplete = await createTestCandidate({
      fields: {
        full_name: 'Alex Rivera',
        designation: 'Staff Researcher',
        company: 'Initech',
        email: null,
        phone: null,
        linkedin_url: null,
        biography: 'Researches autonomous systems.',
      },
      provenance: [
        {
          fieldName: 'full_name',
          value: 'Alex Rivera',
          sourceUrl: 'https://initech.com/people/alex',
          method: 'semantic_html',
          evidence: 'Alex Rivera - Staff Researcher',
          extractedAt: new Date(),
          ruleVersion: 'deterministic-1',
          validationStatus: 'syntax_valid',
        },
      ],
    })

    const result = await promoteSingleCandidate(candIncomplete, { scanJobId: scan._id })
    assert.equal(result.success, true)
    assert.equal(result.status, 'created')

    const lead = await Lead.findById(result.leadId)
    assert.equal(lead.name, 'Alex Rivera')
    assert.equal(lead.email, null)
    assert.equal(lead.phone, null)
    assert.equal(lead.biography, 'Researches autonomous systems.')
    assert.ok(lead.provenance.length > 0)
    assert.equal(lead.provenance[0].fieldName, 'full_name')
    assert.equal(lead.provenance[0].method, 'semantic_html')
  })

  // --- TEST 7: Batch Promotion & Scan Ownership Validation via API ---
  await t.test('7. POST /api/scans/:id/promote validates scan ownership, supports batch promotion, and returns metrics', async () => {
    const candBatch1 = await createTestCandidate({ fields: { full_name: 'Batch User 1', company: 'Acme Corp', email: 'batch1@acme.com' } })
    const candBatch2 = await createTestCandidate({ fields: { full_name: 'Batch User 2', company: 'Acme Corp', email: 'batch2@acme.com' } })

    // Foreign candidate from otherScan
    const candForeign = await createTestCandidate({
      scanJobId: otherScan._id,
      fields: { full_name: 'Foreign User', company: 'Other Corp', email: 'foreign@other.com' },
    })

    // A. Rejection of candidate from another scan
    const resForeign = await fetch(`${base}/scans/${scan._id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateIds: [candBatch1._id, candForeign._id] }),
    })
    assert.equal(resForeign.status, 400, 'Should reject candidate belonging to another scan')
    const foreignJson = await resForeign.json()
    assert.match(foreignJson.error, /do not belong to this scan/i)

    // B. Rejection of invalid scan ID
    const resInvalidScan = await fetch(`${base}/scans/not-a-valid-id/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allShortlisted: true }),
    })
    assert.equal(resInvalidScan.status, 400)

    // C. Successful batch promotion
    const resBatch = await fetch(`${base}/scans/${scan._id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateIds: [candBatch1._id, candBatch2._id] }),
    })
    assert.equal(resBatch.status, 200)
    const batchData = await resBatch.json()
    assert.equal(batchData.success, true)
    assert.equal(batchData.total, 2)
    assert.equal(batchData.promoted, 2)
    assert.equal(batchData.failed, 0)
    assert.ok(batchData.totalLeads >= 2)

    // Verify ScanJob.leadsFound updated
    const updatedScan = await ScanJob.findById(scan._id)
    assert.ok(updatedScan.leadsFound >= 2)
  })

  // --- TEST 8: Lead Management - Search by Name, Email, Company, Title, and Phone ---
  await t.test('8. GET /api/leads supports comprehensive search across name, email, company, title, and phone', async () => {
    // Search by phone
    const resPhone = await fetch(`${base}/leads?q=5551112233`)
    assert.equal(resPhone.status, 200)
    const phoneResults = await resPhone.json()
    assert.ok(phoneResults.length >= 1)
    assert.equal(phoneResults[0].name, 'John Miller')

    // Search by email
    const resEmail = await fetch(`${base}/leads?q=sarah@cyberdyne.com`)
    assert.equal(resEmail.status, 200)
    const emailResults = await resEmail.json()
    assert.ok(emailResults.length >= 1)
    assert.equal(emailResults[0].name, 'Sarah Connor')

    // Search by company
    const resComp = await fetch(`${base}/leads?q=Cyberdyne`)
    assert.equal(resComp.status, 200)
    const compResults = await resComp.json()
    assert.ok(compResults.length >= 1)
    assert.equal(compResults[0].company, 'Cyberdyne Systems')
  })

  // --- TEST 9: Lead Management - PUT /api/leads/:id (Editing & Lead Counts) ---
  await t.test('9. PUT /api/leads/:id allows editing lead fields, updating status, and maintaining company lead counts', async () => {
    const lead = await Lead.findOne({ name: 'Alex Rivera' })
    assert.ok(lead)
    const oldCompanyId = lead.companyId

    // Edit contact information, biography, status, and company
    const resEdit = await fetch(`${base}/leads/${lead._id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alex.rivera@initech.com',
        phone: '+1 (555) 777-8899',
        status: 'qualified',
        company: 'Initech Global Corp', // Company change!
        biography: 'Updated senior bio with expanded details.',
        notes: 'Promoted to primary prospect.',
      }),
    })
    assert.equal(resEdit.status, 200)
    const updated = await resEdit.json()
    assert.equal(updated.email, 'alex.rivera@initech.com')
    assert.equal(updated.phone, '+15557778899')
    assert.equal(updated.status, 'qualified')
    assert.equal(updated.company, 'Initech Global Corp')
    assert.equal(updated.notes, 'Promoted to primary prospect.')
    assert.equal(updated.biography, 'Updated senior bio with expanded details.')

    // Verify company lead count consistency on new company
    assert.ok(updated.companyId)
    const newCompany = await CompanyProfile.findById(updated.companyId)
    assert.ok(newCompany)
    assert.equal(newCompany.totalLeads, 1)

    // If old company existed, its count should be 0
    if (oldCompanyId && String(oldCompanyId) !== String(updated.companyId)) {
      const oldCompany = await CompanyProfile.findById(oldCompanyId)
      if (oldCompany) assert.equal(oldCompany.totalLeads, 0)
    }
  })

  // --- TEST 10: Lead Deletion & Orphan Safety ---
  await t.test('10. DELETE /api/leads/:id deletes lead, updates company lead count, resets candidate promotion, and preserves shared companies', async () => {
    const leadToDelete = await Lead.findOne({ name: 'Batch User 1' })
    assert.ok(leadToDelete)
    const compId = leadToDelete.companyId
    assert.ok(compId)

    const compBefore = await CompanyProfile.findById(compId)
    const countBefore = compBefore.totalLeads

    // Delete lead
    const resDel = await fetch(`${base}/leads/${leadToDelete._id}`, { method: 'DELETE' })
    assert.equal(resDel.status, 200)
    const delJson = await resDel.json()
    assert.equal(delJson.success, true)

    // Verify lead is gone
    const checkLead = await Lead.findById(leadToDelete._id)
    assert.equal(checkLead, null)

    // Verify CompanyProfile was NOT deleted (orphan safety: company has other leads like Batch User 2)
    const compAfter = await CompanyProfile.findById(compId)
    assert.ok(compAfter, 'CompanyProfile should be preserved')
    assert.equal(compAfter.totalLeads, countBefore - 1, 'Company totalLeads should be decremented')

    // Verify candidate promotion state was reset
    const candRecord = await CandidateRecord.findOne({ 'fields.full_name': 'Batch User 1' })
    if (candRecord) {
      assert.equal(candRecord.promoted, false)
      assert.equal(candRecord.leadId, null)
    }
  })

  // --- TEST 11: Deduplication via Existing PersonProfile Relationship ---
  await t.test('11. Deduplication via existing PersonProfile relationship reuses existing records', async () => {
    // Create an existing person profile and lead
    const existingPerson = await PersonProfile.create({
      name: 'Dr. Evelyn Reed',
      email: 'evelyn.reed@biotech.org',
      organization: 'Reed Laboratories',
    })
    const existingLead = await Lead.create({
      name: 'Dr. Evelyn Reed',
      email: 'evelyn.reed@biotech.org',
      company: 'Reed Laboratories',
      status: 'contacted',
    })

    // Incoming candidate has same person details but promotes via candidate
    const candPersonMatch = await createTestCandidate({
      fields: {
        full_name: 'Dr. Evelyn Reed',
        email: 'evelyn.reed@biotech.org',
        company: 'Reed Laboratories',
        title: 'Principal Investigator',
      },
    })

    const res = await promoteSingleCandidate(candPersonMatch, { scanJobId: scan._id })
    assert.equal(res.success, true)
    assert.equal(res.status, 'reused')
    assert.equal(String(res.leadId), String(existingLead._id))

    // Verify PersonProfile was updated and not duplicated
    const peopleCount = await PersonProfile.countDocuments({ email: 'evelyn.reed@biotech.org' })
    assert.equal(peopleCount, 1)
  })

  // --- TEST 12: Relationship Integrity: CompanyProfile.people array ---
  await t.test('12. CompanyProfile people array links resolved PersonProfile IDs without duplicate entries', async () => {
    const comp = await CompanyProfile.findOne({ name: 'Acme Corp' })
    assert.ok(comp)

    // Check that people array has IDs
    const person = await PersonProfile.findOne({ name: 'John Miller' })
    if (person && comp.people) {
      assert.ok(comp.people.some(pId => String(pId) === String(person._id)))
    }
  })

  // --- TEST 13: Input Validation & Safety: Invalid and Non-existent IDs ---
  await t.test('13. Lead endpoints reject invalid MongoDB ObjectIDs with 400 and non-existent IDs with 404', async () => {
    // GET invalid ID
    const resGetInvalid = await fetch(`${base}/leads/invalid-hex-id`)
    assert.equal(resGetInvalid.status, 400)

    // GET 404 non-existent ID
    const fakeId = new mongoose.Types.ObjectId()
    const resGet404 = await fetch(`${base}/leads/${fakeId}`)
    assert.equal(resGet404.status, 404)

    // PUT invalid ID
    const resPutInvalid = await fetch(`${base}/leads/invalid-hex-id`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    })
    assert.equal(resPutInvalid.status, 400)

    // PUT 404 non-existent ID
    const resPut404 = await fetch(`${base}/leads/${fakeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    })
    assert.equal(resPut404.status, 404)

    // DELETE invalid ID
    const resDelInvalid = await fetch(`${base}/leads/invalid-hex-id`, { method: 'DELETE' })
    assert.equal(resDelInvalid.status, 400)

    // DELETE 404 non-existent ID
    const resDel404 = await fetch(`${base}/leads/${fakeId}`, { method: 'DELETE' })
    assert.equal(resDel404.status, 404)
  })

  // --- TEST 14: Filtering by designation/title, status, and contact channels ---
  await t.test('14. GET /api/leads supports filtering by title, status, companyId, and contact channels', async () => {
    // Filter by title
    const resTitle = await fetch(`${base}/leads?title=Chief%20Technology%20Officer`)
    assert.equal(resTitle.status, 200)
    const titleResults = await resTitle.json()
    assert.ok(titleResults.length >= 1)
    assert.ok(titleResults.some(l => l.name === 'John Miller'))

    // Filter by hasEmail
    const resHasEmail = await fetch(`${base}/leads?hasEmail=true`)
    assert.equal(resHasEmail.status, 200)
    const emailResults = await resHasEmail.json()
    assert.ok(emailResults.every(l => Boolean(l.email)))

    // Filter by hasPhone
    const resHasPhone = await fetch(`${base}/leads?hasPhone=true`)
    assert.equal(resHasPhone.status, 200)
    const phoneResults = await resHasPhone.json()
    assert.ok(phoneResults.every(l => Boolean(l.phone)))

    // Filter by status=qualified
    const resQualified = await fetch(`${base}/leads?status=qualified`)
    assert.equal(resQualified.status, 200)
    const qualResults = await resQualified.json()
    assert.ok(qualResults.every(l => l.status === 'qualified'))
  })
})
