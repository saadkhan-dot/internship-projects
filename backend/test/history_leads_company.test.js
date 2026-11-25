import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { ScanJob, ScanPage, CandidateRecord, Lead, PersonProfile, CompanyProfile } from '../src/models/index.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_history_test'

test('Comprehensive History, Leads & Company Directory Test Suite', async (t) => {
  const apiPort = await freePort()
  let apiServer

  // Connect direct Mongoose connection for seeding and assertions
  await mongoose.connect(TEST_DB_URI)

  // Clear test DB collections
  await Promise.all([
    ScanJob.deleteMany({}),
    ScanPage.deleteMany({}),
    CandidateRecord.deleteMany({}),
    Lead.deleteMany({}),
    PersonProfile.deleteMany({}),
    CompanyProfile.deleteMany({}),
  ])

  // Spawn backend server
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

  // Wait for server health
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
  assert.equal(healthy, true, 'Backend test server should start and connect to MongoDB')

  t.after(async () => {
    if (apiServer) {
      apiServer.kill('SIGTERM')
    }
    await mongoose.disconnect()
  })

  await t.test('1. Crawl History: Session tracking, pagination, filtering, details & duration', async () => {
    const job1 = await ScanJob.create({
      type: 'website',
      target: 'https://alpha.example.com',
      status: 'completed',
      startedAt: new Date(Date.now() - 45000),
      endedAt: new Date(),
      pagesProcessed: 12,
      leadsFound: 4,
      progress: { urlsDiscovered: 20, pagesAttempted: 14, pagesFetched: 12, failedRequests: 2 },
      logs: [{ at: new Date(), message: 'Scan completed successfully' }],
    })

    const job2 = await ScanJob.create({
      type: 'website',
      target: 'https://beta.example.com',
      status: 'failed',
      startedAt: new Date(Date.now() - 10000),
      endedAt: new Date(),
      pagesProcessed: 1,
      leadsFound: 0,
      failureReason: 'Connection timed out',
      progress: { urlsDiscovered: 2, pagesAttempted: 1, pagesFetched: 0, failedRequests: 1 },
      logs: [{ at: new Date(), message: 'Connection timed out' }],
    })

    const job3 = await ScanJob.create({
      type: 'website',
      target: 'https://gamma.example.com',
      status: 'running',
      startedAt: new Date(Date.now() - 5000),
      progress: { urlsDiscovered: 5, pagesAttempted: 3, pagesFetched: 3, failedRequests: 0 },
      logs: [{ at: new Date(), message: 'Fetching pages' }],
    })

    // GET /api/history paginated
    const resAll = await fetch(`${base}/history?page=1&limit=10`)
    assert.equal(resAll.status, 200)
    const dataAll = await resAll.json()
    assert.equal(dataAll.total >= 3, true)
    assert.ok(dataAll.summary)
    assert.equal(dataAll.summary.completed >= 1, true)
    assert.equal(dataAll.summary.failed >= 1, true)
    assert.equal(dataAll.summary.running >= 1, true)

    // Verify duration calculation
    const alphaItem = dataAll.items.find(i => i._id === String(job1._id))
    assert.ok(alphaItem)
    assert.ok(alphaItem.durationFormatted)
    assert.equal(alphaItem.durationMs >= 40000, true)

    // Filter by status
    const resCompleted = await fetch(`${base}/history?status=completed`)
    const dataCompleted = await resCompleted.json()
    assert.ok(dataCompleted.items.every(i => i.status === 'completed'))

    // Search by target
    const resSearch = await fetch(`${base}/history?q=beta`)
    const dataSearch = await resSearch.json()
    assert.equal(dataSearch.items.length, 1)
    assert.equal(dataSearch.items[0].target, 'https://beta.example.com')

    // GET /api/history/:id
    const resDetail = await fetch(`${base}/history/${job1._id}`)
    assert.equal(resDetail.status, 200)
    const detail = await resDetail.json()
    assert.equal(detail.target, 'https://alpha.example.com')
    assert.ok(Array.isArray(detail.logs))

    // Active scan cannot be deleted (409 Conflict)
    const resDeleteActive = await fetch(`${base}/history/${job3._id}`, { method: 'DELETE' })
    assert.equal(resDeleteActive.status, 409)
  })

  await t.test('2. Clear History: Full CRM reset and active scan protection', async () => {
    await Promise.all([
      ScanJob.deleteMany({}),
      ScanPage.deleteMany({}),
      CandidateRecord.deleteMany({}),
      Lead.deleteMany({}),
      PersonProfile.deleteMany({}),
      CompanyProfile.deleteMany({}),
    ])

    // Create completed/failed/cancelled scan jobs
    const jobA = await ScanJob.create({ type: 'website', target: 'https://purge-a.com', status: 'completed' })
    const jobB = await ScanJob.create({ type: 'website', target: 'https://purge-b.com', status: 'failed' })
    const jobActive = await ScanJob.create({ type: 'website', target: 'https://stay-active.com', status: 'running' })

    // Create associated scan pages
    await ScanPage.create({
      scanId: jobA._id,
      url: 'https://purge-a.com/page1',
      normalizedUrl: 'https://purge-a.com/page1',
      source: 'seed',
    })

    // Create saved Lead, PersonProfile, and CompanyProfile
    const savedLead = await Lead.create({
      name: 'Sherlock Holmes',
      email: 'sherlock@bakerstreet.test',
      company: 'Baker St Investigations',
      title: 'Consulting Detective',
      status: 'qualified',
      scanId: jobA._id,
    })

    const savedPerson = await PersonProfile.create({
      name: 'John Watson',
      email: 'watson@bakerstreet.test',
      organization: 'Baker St Investigations',
      scanId: jobA._id,
    })

    const savedCompany = await CompanyProfile.create({
      name: 'Baker St Investigations',
      website: 'https://bakerstreet.test',
      domain: 'bakerstreet.test',
      scanId: jobA._id,
    })

    // Execute Clear History while active job is running -> MUST return 409 Conflict
    const activeRes = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(activeRes.status, 409, 'Must protect active scans with 409 Conflict')
    const activeData = await activeRes.json()
    assert.match(activeData.error, /Cannot clear history while scans are actively running or queued/i)

    // Remove active job so Clear All History can proceed
    await ScanJob.findByIdAndDelete(jobActive._id)

    // Execute Clear All History (DELETE /api/history)
    const clearRes = await fetch(`${base}/history`, { method: 'DELETE' })
    assert.equal(clearRes.status, 200)
    const clearData = await clearRes.json()
    assert.equal(clearData.success, true)

    // Verify all scan jobs are removed
    assert.equal(await ScanJob.countDocuments({}), 0, 'All scan jobs must be purged')

    // CRITICAL RESET CHECK:
    // All Lead, PersonProfile, and CompanyProfile records must be wiped to 0
    assert.equal(await Lead.countDocuments({}), 0, 'All leads must be wiped after Clear All History')
    assert.equal(await PersonProfile.countDocuments({}), 0, 'All people must be wiped after Clear All History')
    assert.equal(await CompanyProfile.countDocuments({}), 0, 'All companies must be wiped after Clear All History')
  })

  await t.test('3. Leads Directory: Multi-field search, contact filtering & single deletion', async () => {
    const comp = await CompanyProfile.create({ name: 'Acme Labs', domain: 'acmelabs.test' })

    const l1 = await Lead.create({
      name: 'Alice Smith',
      email: 'alice@acmelabs.test',
      company: 'Acme Labs',
      companyId: comp._id,
      title: 'Principal Scientist',
      phone: '+1 555 0101',
      linkedinUrl: 'https://linkedin.com/in/alicesmith',
      status: 'new',
    })

    const l2 = await Lead.create({
      name: 'Bob Jones',
      email: 'bob@other.test',
      company: 'Other Corp',
      title: 'Software Engineer',
      phone: null,
      linkedinUrl: null,
      status: 'contacted',
    })

    const l3 = await Lead.create({
      name: 'Charlie Brown',
      email: null,
      company: 'Acme Labs',
      companyId: comp._id,
      title: 'Lab Manager',
      phone: '+1 555 0103',
      linkedinUrl: null,
      status: 'new',
    })

    // Search by name
    const resSearch = await fetch(`${base}/leads?q=Alice`)
    const dataSearch = await resSearch.json()
    assert.equal(dataSearch.some(l => l.name === 'Alice Smith'), true)
    assert.equal(dataSearch.some(l => l.name === 'Bob Jones'), false)

    // Filter hasEmail=true
    const resEmail = await fetch(`${base}/leads?hasEmail=true`)
    const dataEmail = await resEmail.json()
    assert.equal(dataEmail.some(l => l.name === 'Alice Smith'), true)
    assert.equal(dataEmail.some(l => l.name === 'Charlie Brown'), false)

    // Filter hasPhone=true
    const resPhone = await fetch(`${base}/leads?hasPhone=true`)
    const dataPhone = await resPhone.json()
    assert.equal(dataPhone.some(l => l.name === 'Bob Jones'), false)
    assert.equal(dataPhone.some(l => l.name === 'Charlie Brown'), true)

    // Filter hasLinkedIn=true
    const resLinkedIn = await fetch(`${base}/leads?hasLinkedIn=true`)
    const dataLinkedIn = await resLinkedIn.json()
    assert.equal(dataLinkedIn.some(l => l.name === 'Alice Smith'), true)
    assert.equal(dataLinkedIn.some(l => l.name === 'Charlie Brown'), false)

    // Filter by companyId
    const resComp = await fetch(`${base}/leads?companyId=${comp._id}`)
    const dataComp = await resComp.json()
    assert.equal(dataComp.length, 2)
    assert.equal(dataComp.some(l => l.name === 'Bob Jones'), false)

    // Single lead delete
    const resDel = await fetch(`${base}/leads/${l2._id}`, { method: 'DELETE' })
    assert.equal(resDel.status, 200)
    const checkDel = await Lead.findById(l2._id)
    assert.equal(checkDel, null)
  })

  await t.test('4. CSV Export: RFC-4180 compliance, header order, and character escaping', async () => {
    // Create a lead with commas, quotes, and newlines to test RFC-4180
    await Lead.create({
      name: 'Dana "The Architect" Scully',
      title: 'Special Agent, FBI',
      company: 'FBI & Associates, Inc.',
      email: 'dana.scully@fbi.gov',
      phone: '+1 202 555 0199',
      linkedinUrl: 'https://linkedin.com/in/danascully',
      sourceUrl: 'https://fbi.gov/team/scully',
      discoveredAt: new Date('2026-01-15T12:00:00Z'),
    })

    const exportRes = await fetch(`${base}/leads/export?q=Scully`)
    assert.equal(exportRes.status, 200)
    assert.equal(exportRes.headers.get('content-type'), 'text/csv; charset=utf-8')
    assert.ok(exportRes.headers.get('content-disposition')?.includes('attachment; filename='))

    const csvText = await exportRes.text()
    const lines = csvText.split('\r\n')

    // RFC-4180 Header Check
    assert.equal(lines[0], 'Full Name,Designation,Company,Email,Phone,LinkedIn,Lead Status,Source Website,Profile URL,Date Discovered,Biography,Notes')

    // Escaped Cell Checks
    // Double quotes must be doubled: "The Architect" -> ""The Architect""
    assert.ok(csvText.includes('"Dana ""The Architect"" Scully"'), 'Quotes must be doubled per RFC-4180')
    // Commas must be enclosed in double quotes: Special Agent, FBI -> "Special Agent, FBI"
    assert.ok(csvText.includes('"Special Agent, FBI"'), 'Commas must be enclosed in quotes per RFC-4180')
    assert.ok(csvText.includes('"FBI & Associates, Inc."'))
  })

  await t.test('5. Companies Directory: Aggregated lead coverage, intra-company leads & deletion', async () => {
    const techCorp = await CompanyProfile.create({
      name: 'TechCorp International',
      website: 'https://techcorp.com',
      domain: 'techcorp.com',
      industry: 'Software',
    })

    // Add leads linked to techCorp
    await Lead.create({
      name: 'Carol Danvers',
      email: 'carol@techcorp.com',
      phone: '+1 415 555 1111',
      linkedinUrl: 'https://linkedin.com/in/caroldanvers',
      company: 'TechCorp International',
      companyId: techCorp._id,
    })

    await Lead.create({
      name: 'Peter Parker',
      email: 'peter@techcorp.com',
      phone: null,
      linkedinUrl: null,
      company: 'TechCorp International',
      companyId: techCorp._id,
    })

    // GET /api/companies
    const resComps = await fetch(`${base}/companies?q=TechCorp`)
    assert.equal(resComps.status, 200)
    const comps = await resComps.json()
    assert.equal(comps.length, 1)
    const c = comps[0]
    assert.equal(c.totalLeads, 2)
    assert.equal(c.emailCount, 2)
    assert.equal(c.phoneCount, 1)
    assert.equal(c.linkedInCount, 1)

    // GET /api/companies/:id
    const resDetail = await fetch(`${base}/companies/${techCorp._id}`)
    assert.equal(resDetail.status, 200)
    const compDetail = await resDetail.json()
    assert.equal(compDetail.totalLeads, 2)
    assert.equal(compDetail.domain, 'techcorp.com')

    // GET /api/companies/:id/leads
    const resCompLeads = await fetch(`${base}/companies/${techCorp._id}/leads`)
    assert.equal(resCompLeads.status, 200)
    const compLeads = await resCompLeads.json()
    assert.equal(compLeads.length, 2)

    // GET /api/companies/:id/export
    const resExport = await fetch(`${base}/companies/${techCorp._id}/export`)
    assert.equal(resExport.status, 200)
    const compCsv = await resExport.text()
    assert.ok(compCsv.includes('Carol Danvers'))
    assert.ok(compCsv.includes('Peter Parker'))

    // DELETE /api/companies/:id preserves associated leads by detaching companyId
    const resDel = await fetch(`${base}/companies/${techCorp._id}`, { method: 'DELETE' })
    assert.equal(resDel.status, 200)

    const checkCompany = await CompanyProfile.findById(techCorp._id)
    assert.equal(checkCompany, null, 'Company should be deleted')

    // Verify leads are still present
    const carolLead = await Lead.findOne({ name: 'Carol Danvers' })
    assert.ok(carolLead, 'Lead must remain preserved after company profile deletion')
    assert.equal(Boolean(carolLead.companyId), false, 'Lead companyId should be safely detached')
  })

  await t.test('6. Company Merge: Consolidates duplicates, reassigns leads & merges metadata', async () => {
    const targetComp = await CompanyProfile.create({
      name: 'Global Dynamics LLC',
      website: 'https://globaldynamics.com',
      domain: 'globaldynamics.com',
      contacts: ['info@globaldynamics.com'],
    })

    const sourceComp = await CompanyProfile.create({
      name: 'Global Dynamics (Duplicate Branch)',
      website: null,
      domain: 'gd-branch.com',
      industry: 'Advanced Robotics',
      description: 'Research and development facility',
      contacts: ['branch@gd-branch.com', 'info@globaldynamics.com'],
    })

    // Add leads linked to sourceComp
    const lead1 = await Lead.create({
      name: 'Fargo North',
      email: 'fargo@gd.test',
      company: 'Global Dynamics (Duplicate Branch)',
      companyId: sourceComp._id,
    })

    const lead2 = await Lead.create({
      name: 'Henry Deacon',
      email: 'henry@gd.test',
      company: 'Global Dynamics (Duplicate Branch)',
      companyId: sourceComp._id,
    })

    // Merge sourceComp into targetComp
    const mergeRes = await fetch(`${base}/companies/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCompanyId: targetComp._id, sourceCompanyId: sourceComp._id }),
    })
    assert.equal(mergeRes.status, 200)
    const mergeData = await mergeRes.json()
    assert.equal(mergeData.success, true)
    assert.equal(mergeData.reassignedLeadsCount, 2)

    // Verify source company is deleted
    const checkSource = await CompanyProfile.findById(sourceComp._id)
    assert.equal(checkSource, null, 'Source company must be deleted')

    // Verify target company received merged metadata
    const checkTarget = await CompanyProfile.findById(targetComp._id)
    assert.ok(checkTarget)
    assert.equal(checkTarget.industry, 'Advanced Robotics')
    assert.equal(checkTarget.description, 'Research and development facility')
    assert.equal(checkTarget.contacts.length, 2)
    assert.equal(checkTarget.totalLeads, 2)

    // Verify leads reassigned to target company
    const updatedLead1 = await Lead.findById(lead1._id)
    const updatedLead2 = await Lead.findById(lead2._id)
    assert.equal(String(updatedLead1.companyId), String(targetComp._id))
    assert.equal(updatedLead1.company, 'Global Dynamics LLC')
    assert.equal(String(updatedLead2.companyId), String(targetComp._id))
    assert.equal(updatedLead2.company, 'Global Dynamics LLC')
  })

  await t.test('7. Lead Multi-Tier Deduplication & Field Enrichment Across Repeated Scans', async () => {
    const scan1 = await ScanJob.create({ type: 'website', target: 'https://dedupe-test.org', status: 'completed' })
    const scan2 = await ScanJob.create({ type: 'website', target: 'https://dedupe-test.org', status: 'completed' })

    const page1 = await ScanPage.create({
      scanId: scan1._id,
      url: 'https://dedupe-test.org/staff',
      normalizedUrl: 'https://dedupe-test.org/staff',
      source: 'seed',
    })
    const page2 = await ScanPage.create({
      scanId: scan2._id,
      url: 'https://dedupe-test.org/team',
      normalizedUrl: 'https://dedupe-test.org/team',
      source: 'seed',
    })

    // First scan: discovers Bruce Banner with name and email only
    const candidateScan1 = {
      candidateKey: 'bruce-banner-k1',
      candidateType: 'person',
      fields: {
        full_name: 'Bruce Banner',
        email: 'bbanner@avengers.test',
        company: 'Avengers Initiative',
        designation: 'Research Scientist',
      },
      provenance: [],
      sourceUrl: 'https://dedupe-test.org/staff',
      extractedAt: new Date(),
    }

    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan1._id,
      candidate: candidateScan1,
    })

    // Verify lead was created
    const initialLead = await Lead.findOne({ email: 'bbanner@avengers.test' })
    assert.ok(initialLead)
    assert.equal(Boolean(initialLead.phone), false)
    assert.equal(Boolean(initialLead.linkedinUrl), false)

    // Second scan: discovers same person with matching email AND newly discovered phone & LinkedIn URL
    const candidateScan2 = {
      candidateKey: 'bruce-banner-k2',
      candidateType: 'person',
      fields: {
        full_name: 'Bruce Banner',
        email: 'bbanner@avengers.test', // Tier 2 match
        phone: '+1 212 555 0144',       // New field to enrich
        linkedin_url: 'https://linkedin.com/in/bruce-banner', // New field to enrich
        company: 'Avengers Initiative',
      },
      provenance: [],
      sourceUrl: 'https://dedupe-test.org/team',
      extractedAt: new Date(),
    }

    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan2._id,
      candidate: candidateScan2,
    })

    // Verify: No duplicate lead was created; existing lead was enriched!
    const totalMatchingLeads = await Lead.countDocuments({ email: 'bbanner@avengers.test' })
    assert.equal(totalMatchingLeads, 1, 'Multi-tier deduplication must prevent duplicate lead creation')

    const enrichedLead = await Lead.findOne({ email: 'bbanner@avengers.test' })
    assert.equal(enrichedLead._id.toString(), initialLead._id.toString(), 'Original lead record should be enriched')
    assert.equal(enrichedLead.phone, '+1 212 555 0144', 'Missing phone must be enriched')
    assert.equal(enrichedLead.linkedinUrl, 'https://linkedin.com/in/bruce-banner', 'Missing LinkedIn URL must be enriched')
    assert.equal(enrichedLead.title, 'Research Scientist', 'Original designation must be preserved')
  })
})
