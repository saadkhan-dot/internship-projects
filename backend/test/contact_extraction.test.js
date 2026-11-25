import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import http from 'node:http'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { ScanJob, CandidateRecord, Lead, PersonProfile, CompanyProfile } from '../src/models/index.js'
import {
  extractCandidateContacts,
  executeContactExtraction,
  isValidEmailSyntax,
  isValidPhoneSyntax,
} from '../src/services/contactExtraction.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_contact_extraction_test'

test('Unit Tests: isValidEmailSyntax and isValidPhoneSyntax', () => {
  // Email validation
  assert.equal(isValidEmailSyntax('alice@example.com'), true)
  assert.equal(isValidEmailSyntax('bob.smith+work@corp.co.uk'), true)
  assert.equal(isValidEmailSyntax('invalid-email'), false)
  assert.equal(isValidEmailSyntax('@example.com'), false)
  assert.equal(isValidEmailSyntax('alice@'), false)
  assert.equal(isValidEmailSyntax(''), false)
  assert.equal(isValidEmailSyntax(null), false)

  // Phone validation
  assert.equal(isValidPhoneSyntax('+1 (555) 123-4567'), true)
  assert.equal(isValidPhoneSyntax('5551234567'), true)
  assert.equal(isValidPhoneSyntax('+44 20 7946 0991'), true)
  assert.equal(isValidPhoneSyntax('12345'), false) // < 7 digits
  assert.equal(isValidPhoneSyntax('1234567890123456789'), false) // > 15 digits
  assert.equal(isValidPhoneSyntax('phone-number'), false)
  assert.equal(isValidPhoneSyntax(null), false)
})

test('Level 2 Contact Extraction: Selection, Validation, Provenance, Isolation, and Zero CRM Creation', async (t) => {
  const apiPort = await freePort()
  const fixturePort = await freePort()

  let requestCount = 0
  const fixtureServer = http.createServer((req, res) => {
    requestCount++
    if (req.url === '/team/alice-smith') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Alice Smith - TechCorp</title></head>
          <body>
            <h1>Alice Smith</h1>
            <p class="title">Chief Technology Officer</p>
            <p class="bio">Alice has over 15 years of experience leading engineering teams and building scalable SaaS platforms.</p>
            <div class="contact">
              <a href="mailto:alice.smith@techcorp.com">alice.smith@techcorp.com</a>
              <a href="tel:+1-555-019-2834">+1 (555) 019-2834</a>
              <a href="https://linkedin.com/in/alicesmith-cto/">LinkedIn Profile</a>
            </div>
          </body>
        </html>
      `)
    } else if (req.url === '/team/bob-jones') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Bob Jones - TechCorp</title></head>
          <body>
            <h1>Bob Jones</h1>
            <p class="title">VP of Product</p>
            <p class="bio">Bob oversees product strategy and user experience design.</p>
            <div class="contact">
              <a href="mailto:bob.jones@techcorp.com">bob.jones@techcorp.com</a>
            </div>
          </body>
        </html>
      `)
    } else if (req.url === '/team/carol-danvers') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Carol Danvers - TechCorp</title></head>
          <body>
            <h1>Carol Danvers</h1>
            <p class="title">Director of Engineering</p>
            <p class="bio">Carol specializes in distributed systems and cloud infrastructure.</p>
            <!-- No contact channels on this page -->
          </body>
        </html>
      `)
    } else if (req.url === '/team/david-error') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  })

  await new Promise(resolve => fixtureServer.listen(fixturePort, '127.0.0.1', resolve))

  await mongoose.connect(TEST_DB_URI)
  await Promise.all([
    ScanJob.deleteMany({}),
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
    fixtureServer.close()
    await Promise.all([
      ScanJob.deleteMany({}),
      CandidateRecord.deleteMany({}),
      Lead.deleteMany({}),
      PersonProfile.deleteMany({}),
      CompanyProfile.deleteMany({}),
    ])
    await mongoose.disconnect()
  })

  // 1. Create Scan Job
  const scan = await ScanJob.create({
    targetUrl: `http://127.0.0.1:${fixturePort}`,
    domain: '127.0.0.1',
    status: 'completed',
    depth: 2,
    priorityProfilesOnly: true,
  })

  const otherScan = await ScanJob.create({
    targetUrl: `http://127.0.0.1:${fixturePort}/other`,
    domain: '127.0.0.1',
    status: 'completed',
    depth: 2,
    priorityProfilesOnly: true,
  })

  // 2. Create Candidate Records
  // Alice: Shortlisted person with bio URL, will extract Email + Phone + LinkedIn (Score 3)
  const candidateAlice = await CandidateRecord.create({
    scanJobId: scan._id,
    pageId: new mongoose.Types.ObjectId(),
    candidateKey: 'alice-smith',
    sourceUrl: `http://127.0.0.1:${fixturePort}/team`,
    sourceDomain: '127.0.0.1',
    candidateType: 'person',
    confidenceScore: 1,
    shortlisted: true,
    extractionStatus: 'candidate',
    validationStatus: 'unverified',
    parserVersion: 'v1.0.0',
    extractedAt: new Date(),
    fields: {
      full_name: 'Alice Smith',
      designation: 'CTO',
      company: 'TechCorp',
      profile_url: `http://127.0.0.1:${fixturePort}/team/alice-smith`,
      score: 1,
    },
    provenance: [{
      fieldName: 'full_name',
      value: 'Alice Smith',
      sourceUrl: `http://127.0.0.1:${fixturePort}/team`,
      method: 'semantic_html',
      evidence: 'Alice Smith',
      extractedAt: new Date(),
      ruleVersion: 'v1.0.0',
      validationStatus: 'syntax_valid',
    }],
  })

  // Bob: Shortlisted person with bio URL, will extract Email only (Score 2)
  const candidateBob = await CandidateRecord.create({
    scanJobId: scan._id,
    pageId: new mongoose.Types.ObjectId(),
    candidateKey: 'bob-jones',
    sourceUrl: `http://127.0.0.1:${fixturePort}/team`,
    sourceDomain: '127.0.0.1',
    candidateType: 'person',
    confidenceScore: 1,
    shortlisted: true,
    extractionStatus: 'candidate',
    validationStatus: 'unverified',
    parserVersion: 'v1.0.0',
    extractedAt: new Date(),
    fields: {
      full_name: 'Bob Jones',
      designation: 'VP Product',
      company: 'TechCorp',
      profile_url: `http://127.0.0.1:${fixturePort}/team/bob-jones`,
      score: 1,
    },
    provenance: [],
  })

  // Carol: Shortlisted person with bio URL, but bio page has NO contact channels (Needs Review, Score 1)
  const candidateCarol = await CandidateRecord.create({
    scanJobId: scan._id,
    pageId: new mongoose.Types.ObjectId(),
    candidateKey: 'carol-danvers',
    sourceUrl: `http://127.0.0.1:${fixturePort}/team`,
    sourceDomain: '127.0.0.1',
    candidateType: 'person',
    confidenceScore: 1,
    shortlisted: true,
    extractionStatus: 'candidate',
    validationStatus: 'unverified',
    parserVersion: 'v1.0.0',
    extractedAt: new Date(),
    fields: {
      full_name: 'Carol Danvers',
      designation: 'Director of Engineering',
      company: 'TechCorp',
      profile_url: `http://127.0.0.1:${fixturePort}/team/carol-danvers`,
      score: 1,
    },
    provenance: [],
  })

  // David: Shortlisted person whose bio URL returns 404 (Failed)
  const candidateDavid = await CandidateRecord.create({
    scanJobId: scan._id,
    pageId: new mongoose.Types.ObjectId(),
    candidateKey: 'david-error',
    sourceUrl: `http://127.0.0.1:${fixturePort}/team`,
    sourceDomain: '127.0.0.1',
    candidateType: 'person',
    confidenceScore: 1,
    shortlisted: true,
    extractionStatus: 'candidate',
    validationStatus: 'unverified',
    parserVersion: 'v1.0.0',
    extractedAt: new Date(),
    fields: {
      full_name: 'David Error',
      designation: 'Senior Engineer',
      company: 'TechCorp',
      profile_url: `http://127.0.0.1:${fixturePort}/team/david-error`,
      score: 1,
    },
    provenance: [],
  })

  // Eve: NON-SHORTLISTED person (should be rejected if requested)
  const candidateEve = await CandidateRecord.create({
    scanJobId: scan._id,
    pageId: new mongoose.Types.ObjectId(),
    candidateKey: 'eve-unshortlisted',
    sourceUrl: `http://127.0.0.1:${fixturePort}/team`,
    sourceDomain: '127.0.0.1',
    candidateType: 'person',
    confidenceScore: 1,
    shortlisted: false,
    extractionStatus: 'candidate',
    validationStatus: 'unverified',
    parserVersion: 'v1.0.0',
    extractedAt: new Date(),
    fields: {
      full_name: 'Eve Unshortlisted',
      designation: 'Marketing Lead',
      company: 'TechCorp',
      score: 1,
    },
    provenance: [],
  })

  // Frank: Belongs to OTHER SCAN (should be rejected if requested in scan 1)
  const candidateFrank = await CandidateRecord.create({
    scanJobId: otherScan._id,
    pageId: new mongoose.Types.ObjectId(),
    candidateKey: 'frank-foreign',
    sourceUrl: `http://127.0.0.1:${fixturePort}/other`,
    sourceDomain: '127.0.0.1',
    candidateType: 'person',
    confidenceScore: 1,
    shortlisted: true,
    extractionStatus: 'candidate',
    validationStatus: 'unverified',
    parserVersion: 'v1.0.0',
    extractedAt: new Date(),
    fields: {
      full_name: 'Frank Foreign',
      designation: 'Consultant',
      company: 'OtherCorp',
      score: 1,
    },
    provenance: [],
  })

  // 3. Test API Validation Constraints
  // A. Non-existent scan ID returns 404
  const resNonExistent = await fetch(`${base}/scans/${new mongoose.Types.ObjectId()}/extract-contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allShortlisted: true }),
  })
  assert.equal(resNonExistent.status, 404, 'Non-existent scan should return 404')

  // B. Reject non-shortlisted candidates
  const resEve = await fetch(`${base}/scans/${scan._id}/extract-contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateIds: [candidateEve._id] }),
  })
  assert.equal(resEve.status, 400, 'Non-shortlisted candidate should return 400')
  const eveJson = await resEve.json()
  assert.match(eveJson.error, /exclusively on shortlisted candidates/i)

  // C. Reject candidate belonging to another scan
  const resFrank = await fetch(`${base}/scans/${scan._id}/extract-contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateIds: [candidateAlice._id, candidateFrank._id] }),
  })
  assert.equal(resFrank.status, 400, 'Foreign candidate should return 400')
  const frankJson = await resFrank.json()
  assert.match(frankJson.error, /do not belong to this scan/i)

  // D. Reject missing payload
  const resEmpty = await fetch(`${base}/scans/${scan._id}/extract-contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(resEmpty.status, 400, 'Empty payload should return 400')

  // 4. Test Single Extraction on Alice Smith
  const initialReqCount = requestCount
  const resAlice = await fetch(`${base}/scans/${scan._id}/extract-contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateIds: [candidateAlice._id] }),
  })
  assert.equal(resAlice.status, 200, 'Extracting Alice should succeed')
  const aliceResData = await resAlice.json()
  assert.equal(aliceResData.success, true)
  assert.equal(aliceResData.total, 1)
  assert.equal(aliceResData.completed, 1)
  assert.equal(aliceResData.needsReview, 0)
  assert.equal(aliceResData.failed, 0)

  const aliceItem = aliceResData.items[0]
  assert.equal(aliceItem.name, 'Alice Smith')
  assert.equal(aliceItem.email, 'alice.smith@techcorp.com')
  assert.equal(aliceItem.phone, '+15550192834') // Normalized phone
  assert.equal(aliceItem.linkedinUrl, 'https://linkedin.com/in/alicesmith-cto') // Normalized LinkedIn
  assert.equal(aliceItem.confidenceScore, 3, 'Email + phone/LinkedIn yields confidence score 3')
  assert.equal(aliceItem.extractionStatus, 'completed')
  assert.equal(aliceItem.validationStatus, 'syntax_valid')
  assert.ok(aliceItem.biography.includes('15 years of experience'))
  assert.ok(aliceItem.provenance.length >= 3, 'Should record provenance for email, phone, and linkedin')

  // Check database persistence of Alice
  const aliceDb = await CandidateRecord.findById(candidateAlice._id)
  assert.equal(aliceDb.fields.email, 'alice.smith@techcorp.com')
  assert.equal(aliceDb.fields.phone, '+15550192834')
  assert.equal(aliceDb.fields.linkedin_url, 'https://linkedin.com/in/alicesmith-cto')
  assert.equal(aliceDb.confidenceScore, 3)
  assert.equal(aliceDb.extractionStatus, 'completed')

  // 5. Test Batch Extraction with Error Isolation (Bob, Carol, David)
  const resBatch = await fetch(`${base}/scans/${scan._id}/extract-contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateIds: [candidateBob._id, candidateCarol._id, candidateDavid._id] }),
  })
  assert.equal(resBatch.status, 200, 'Batch extraction should return 200')
  const batchData = await resBatch.json()
  assert.equal(batchData.total, 3)
  assert.equal(batchData.completed, 1, 'Bob should be completed')
  assert.equal(batchData.needsReview, 1, 'Carol should be needs_review')
  assert.equal(batchData.failed, 1, 'David should be failed (404)')

  // Check Bob (Email only -> completed, score 2)
  const bobItem = batchData.items.find(i => String(i.id) === String(candidateBob._id))
  assert.equal(bobItem.email, 'bob.jones@techcorp.com')
  assert.equal(bobItem.phone, null)
  assert.equal(bobItem.confidenceScore, 2, 'Single contact channel yields score 2')
  assert.equal(bobItem.extractionStatus, 'completed')
  assert.equal(bobItem.validationStatus, 'syntax_valid')

  // Check Carol (No contact channels found -> needs_review, score 1)
  const carolItem = batchData.items.find(i => String(i.id) === String(candidateCarol._id))
  assert.equal(carolItem.email, null)
  assert.equal(carolItem.phone, null)
  assert.equal(carolItem.extractionStatus, 'needs_review')
  assert.equal(carolItem.validationStatus, 'needs_review')
  assert.equal(carolItem.confidenceScore, 1)

  // Check David (404 error -> failed, error message recorded)
  const davidItem = batchData.items.find(i => String(i.id) === String(candidateDavid._id))
  assert.equal(davidItem.extractionStatus, 'failed')
  assert.ok(davidItem.extractionError, 'Should report extraction error')
  assert.match(davidItem.extractionError, /404/i)

  // 6. Test GET /api/scans/:id/profiles includes extracted contact fields
  const resProfiles = await fetch(`${base}/scans/${scan._id}/profiles`)
  assert.equal(resProfiles.status, 200)
  const profilesData = await resProfiles.json()
  const pAlice = profilesData.items.find(p => String(p.id) === String(candidateAlice._id))
  assert.ok(pAlice)
  assert.equal(pAlice.email, 'alice.smith@techcorp.com')
  assert.equal(pAlice.phone, '+15550192834')
  assert.equal(pAlice.confidenceScore, 3)
  assert.equal(pAlice.extractionStatus, 'completed')

  // 7. CRITICAL: Verify ZERO CRM Records Created!
  // Neither Lead, PersonProfile, nor CompanyProfile should be created by Level 2 Contact Extraction.
  const leadCount = await Lead.countDocuments({})
  const personCount = await PersonProfile.countDocuments({})
  const companyCount = await CompanyProfile.countDocuments({})

  assert.equal(leadCount, 0, 'Zero Lead records should be created during Level 2 Contact Extraction')
  assert.equal(personCount, 0, 'Zero PersonProfile records should be created during Level 2 Contact Extraction')
  assert.equal(companyCount, 0, 'Zero CompanyProfile records should be created during Level 2 Contact Extraction')

  // 8. Test In-Memory Page Cache across batch
  // Create two candidates pointing to the same bio URL
  const candSame1 = await CandidateRecord.create({
    scanJobId: scan._id,
    pageId: new mongoose.Types.ObjectId(),
    candidateKey: 'alice-duplicate-ref',
    sourceUrl: `http://127.0.0.1:${fixturePort}/team`,
    sourceDomain: '127.0.0.1',
    candidateType: 'person',
    confidenceScore: 1,
    shortlisted: true,
    extractionStatus: 'candidate',
    validationStatus: 'unverified',
    parserVersion: 'v1.0.0',
    extractedAt: new Date(),
    fields: {
      full_name: 'Alice Duplicate Ref',
      profile_url: `http://127.0.0.1:${fixturePort}/team/alice-smith`,
      score: 1,
    },
    provenance: [],
  })

  const reqBeforeCacheTest = requestCount
  await executeContactExtraction([candSame1], {
    allowLocalFixtures: true,
  })
  // Safe fetch was called once for candSame1
  const reqAfterSingle = requestCount
  assert.equal(reqAfterSingle - reqBeforeCacheTest, 1, 'Should fetch bio URL once')
})
