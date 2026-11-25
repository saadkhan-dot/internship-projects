import test from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { parseHtmlPage } from '../src/extraction/pageParser.js'
import { extractCandidates } from '../src/extraction/candidateExtractor.js'
import { detectDirectoryPage } from '../src/extraction/directoryDetector.js'
import { extractPersonnelTables } from '../src/extraction/tableExtractor.js'
import { discoverPaginationUrls, extractPageNumber } from '../src/discovery/pagination.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'

test('Phase 4 — Directory Detection: Genuine staff directory is detected', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head><title>Staff Directory | Acme Corp</title></head>
      <body>
        <h1>Staff Directory</h1>
        <div class="team-grid">
          <div class="member-card">
            <h3>Sarah Connor</h3>
            <p class="role">Operations Manager</p>
            <a href="mailto:sconnor@acme.com">sconnor@acme.com</a>
            <a href="tel:+15551234567">(555) 123-4567</a>
          </div>
          <div class="member-card">
            <h3>John Reese</h3>
            <p class="role">Security Director</p>
            <a href="mailto:jreese@acme.com">jreese@acme.com</a>
          </div>
          <div class="member-card">
            <h3>Harold Finch</h3>
            <p class="role">Chief Systems Architect</p>
            <a href="mailto:hfinch@acme.com">hfinch@acme.com</a>
          </div>
        </div>
      </body>
    </html>
  `
  const { parsed, candidates } = extractCandidates(html, { sourceUrl: 'https://acme.com/staff-directory' })
  assert.equal(candidates.length, 3)
  assert.ok(parsed.directory)
  assert.equal(parsed.directory.isDirectory, true)
  assert.equal(parsed.directory.directoryType, 'staff')
  assert.ok(parsed.directory.confidence >= 5)
})

test('Phase 4 — Directory Detection: Faculty directory is detected', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head><title>Department of Computer Science - Faculty Directory</title></head>
      <body>
        <h1>Faculty Directory</h1>
        <table>
          <thead>
            <tr><th>Name</th><th>Title</th><th>Email</th><th>Phone</th></tr>
          </thead>
          <tbody>
            <tr><td>Dr. Alan Turing</td><td>Professor</td><td>turing@cs.univ.edu</td><td>+1 (555) 987-6543</td></tr>
            <tr><td>Dr. Grace Hopper</td><td>Associate Professor</td><td>hopper@cs.univ.edu</td><td>+1 (555) 987-6544</td></tr>
            <tr><td>Dr. Claude Shannon</td><td>Lecturer</td><td>shannon@cs.univ.edu</td><td>+1 (555) 987-6545</td></tr>
          </tbody>
        </table>
      </body>
    </html>
  `
  const { parsed, candidates } = extractCandidates(html, { sourceUrl: 'https://univ.edu/cs/faculty' })
  assert.equal(candidates.length, 3)
  assert.ok(parsed.directory.isDirectory)
  assert.equal(parsed.directory.directoryType, 'faculty')
  assert.equal(parsed.directory.hasPersonnelTable, true)
})

test('Phase 4 — Directory Detection: Generic team page without person records is not falsely classified', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head><title>Our Team Culture | InnovateCorp</title></head>
      <body>
        <h1>Our Team</h1>
        <p>At InnovateCorp, our team believes in values, synergy, and dedication to excellence.</p>
        <p>We work collaboratively across international hubs to deliver modern solutions.</p>
      </body>
    </html>
  `
  const { parsed, candidates } = extractCandidates(html, { sourceUrl: 'https://innovatecorp.com/team-culture' })
  assert.equal(candidates.length, 0)
  assert.equal(parsed.directory.isDirectory, false)
})

test('Phase 4 — Directory Detection: Navigation menus and job postings are NOT classified as directories', () => {
  const navHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Welcome | Acme Corp</title></head>
      <body>
        <nav>
          <a href="/about">About Us</a>
          <a href="/our-team">Our Team</a>
          <a href="/staff">Staff Directory</a>
          <a href="/contact">Contact</a>
        </nav>
        <main>
          <h1>Company Overview</h1>
          <p>We provide enterprise services.</p>
        </main>
      </body>
    </html>
  `
  const navParsed = extractCandidates(navHtml, { sourceUrl: 'https://acme.com/' }).parsed
  assert.equal(navParsed.directory.isDirectory, false)

  const jobsHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Careers & Open Positions</title></head>
      <body>
        <h1>Join Our Team</h1>
        <p>Explore open positions and apply now.</p>
        <div class="job-card">
          <h2>Senior Backend Engineer</h2>
          <p>Salary: $150k - $180k. Full-time position. Responsibilities and requirements listed below.</p>
          <button>Apply Now</button>
        </div>
      </body>
    </html>
  `
  const jobsParsed = extractCandidates(jobsHtml, { sourceUrl: 'https://acme.com/careers' }).parsed
  assert.equal(jobsParsed.directory.isDirectory, false)
})

test('Phase 4 — Table Extraction: Extracts name, designation, email, phone, and profile link', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <body>
        <table class="personnel-list">
          <thead>
            <tr>
              <th>Employee Name</th>
              <th>Job Title</th>
              <th>Department</th>
              <th>Email Address</th>
              <th>Phone</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><a href="/staff/elena-rostova">Elena Rostova</a></td>
              <td>Lead Scientist</td>
              <td>Biotechnology</td>
              <td><a href="mailto:elena.rostova@bio.org">elena.rostova@bio.org</a></td>
              <td>+1 (415) 555-0199</td>
              <td><a href="/staff/elena-rostova">View Bio</a></td>
            </tr>
            <tr>
              <td>Marcus Brody</td>
              <td>Museum Curator</td>
              <td>Archaeology</td>
              <td>mbrody@marshall.edu</td>
              <td>(555) 012-3456</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://bio.org/staff' })
  assert.equal(candidates.length, 2)

  const elena = candidates.find(c => c.fields.full_name === 'Elena Rostova')
  assert.ok(elena)
  assert.equal(elena.fields.designation, 'Lead Scientist')
  assert.equal(elena.fields.company, 'Biotechnology')
  assert.equal(elena.fields.email, 'elena.rostova@bio.org')
  assert.equal(elena.fields.phone, '+1 (415) 555-0199')
  assert.equal(elena.fields.profile_url, 'https://bio.org/staff/elena-rostova')

  const marcus = candidates.find(c => c.fields.full_name === 'Marcus Brody')
  assert.ok(marcus)
  assert.equal(marcus.fields.designation, 'Museum Curator')
  assert.equal(marcus.fields.company, 'Archaeology')
  assert.equal(marcus.fields.email, 'mbrody@marshall.edu')
  assert.equal(marcus.fields.phone, '(555) 012-3456')
})

test('Phase 4 — Table Extraction: Variable column ordering and missing fields handled safely', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <body>
        <table>
          <thead>
            <tr>
              <th>Contact Phone</th>
              <th>Email</th>
              <th>Title</th>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>+1 202 555 0184</td>
              <td>dmitri@defense.gov</td>
              <td>Advisory Member</td>
              <td>Dmitri Shostakovich</td>
            </tr>
            <tr>
              <td>—</td>
              <td>clara@defense.gov</td>
              <td>Director</td>
              <td>Clara Schumann</td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://defense.gov/members' })
  assert.equal(candidates.length, 2)

  const dmitri = candidates.find(c => c.fields.full_name === 'Dmitri Shostakovich')
  assert.ok(dmitri)
  assert.equal(dmitri.fields.designation, 'Advisory Member')
  assert.equal(dmitri.fields.email, 'dmitri@defense.gov')
  assert.equal(dmitri.fields.phone, '+1 202 555 0184')

  const clara = candidates.find(c => c.fields.full_name === 'Clara Schumann')
  assert.ok(clara)
  assert.equal(clara.fields.designation, 'Director')
  assert.equal(clara.fields.email, 'clara@defense.gov')
  assert.equal(clara.fields.phone, null)
})

test('Phase 4 — Table Extraction: Headers, totals, footnotes, and documentation tables ignored', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <body>
        <table class="pricing-table">
          <thead>
            <tr><th>Tier</th><th>Price</th><th>Users</th></tr>
          </thead>
          <tbody>
            <tr><td>Standard</td><td>$29/mo</td><td>Up to 5</td></tr>
            <tr><td>Enterprise</td><td>$99/mo</td><td>Unlimited</td></tr>
            <tr><td>Total</td><td>—</td><td>—</td></tr>
          </tbody>
        </table>
      </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://service.com/pricing' })
  assert.equal(candidates.length, 0)
})

test('Phase 4 — Pagination: Discovers rel="next", Next link, and numbered pagination', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <link rel="next" href="/directory?page=2" />
      </head>
      <body>
        <div class="pagination">
          <span class="current">1</span>
          <a href="/directory?page=2">2</a>
          <a href="/directory?page=3">3</a>
          <a class="next" href="/directory?page=2" aria-label="Next Page">Next »</a>
        </div>
      </body>
    </html>
  `
  const $ = cheerio.load(html)
  const pagination = discoverPaginationUrls($, 'https://company.com/directory', 'https://company.com')
  assert.ok(pagination.length > 0)
  assert.equal(pagination[0], 'https://company.com/directory?page=2')
})

test('Phase 4 — Pagination: Prevents pagination loops and backward navigation to page 1', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <body>
        <div class="pagination">
          <a href="/directory?page=1" class="prev">« Previous</a>
          <span class="current">2</span>
          <a href="/directory?page=3" class="next">Next »</a>
        </div>
      </body>
    </html>
  `
  const $ = cheerio.load(html)
  const pagination = discoverPaginationUrls($, 'https://company.com/directory?page=2', 'https://company.com')
  assert.ok(pagination.includes('https://company.com/directory?page=3'))
  // Page 1 should NOT be included as a forward pagination URL from Page 2
  assert.ok(!pagination.includes('https://company.com/directory?page=1'))
})

test('Phase 4 — Pagination: Numbered path-based pagination is extracted correctly', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <body>
        <nav role="navigation" aria-label="pagination">
          <ul class="page-numbers">
            <li><span class="page-numbers current">1</span></li>
            <li><a class="page-numbers" href="/team/page/2/">2</a></li>
            <li><a class="next page-numbers" href="/team/page/2/">Next</a></li>
          </ul>
        </nav>
      </body>
    </html>
  `
  const $ = cheerio.load(html)
  const pagination = discoverPaginationUrls($, 'https://agency.com/team', 'https://agency.com')
  assert.ok(pagination.length > 0)
  assert.equal(pagination[0], 'https://agency.com/team/page/2')
})

test('Phase 4 — Profile Links & Merging: Directory record merges with bio page data', async () => {
  // Step 1: Directory page has name, title, and profile link, but NO email or bio
  const directoryHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <h1>Leadership</h1>
        <div class="team-card">
          <h3><a href="/leadership/alex-chen">Alex Chen</a></h3>
          <p class="role">Chief Technology Officer</p>
        </div>
      </body>
    </html>
  `
  const dirResult = extractCandidates(directoryHtml, { sourceUrl: 'https://techcorp.com/leadership' })
  assert.equal(dirResult.candidates.length, 1)
  const dirCandidate = dirResult.candidates[0]
  assert.equal(dirCandidate.fields.full_name, 'Alex Chen')
  assert.equal(dirCandidate.fields.designation, 'Chief Technology Officer')
  assert.equal(dirCandidate.fields.profile_url, 'https://techcorp.com/leadership/alex-chen')
  assert.equal(dirCandidate.fields.email, null)

  // Step 2: Individual Bio page has name, email, phone, and biography paragraph
  const bioHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Alex Chen - Chief Technology Officer</title></head>
      <body>
        <h1>Alex Chen</h1>
        <h2>Chief Technology Officer</h2>
        <p>Alex has 15 years of distributed systems experience and leads engineering.</p>
        <p>Email: <a href="mailto:alex.chen@techcorp.com">alex.chen@techcorp.com</a></p>
        <p>Direct: <a href="tel:+14155550188">+1 (415) 555-0188</a></p>
      </body>
    </html>
  `
  const bioResult = extractCandidates(bioHtml, { sourceUrl: 'https://techcorp.com/leadership/alex-chen' })
  assert.equal(bioResult.candidates.length, 1)
  const bioCandidate = bioResult.candidates[0]
  assert.equal(bioCandidate.fields.full_name, 'Alex Chen')
  assert.equal(bioCandidate.fields.email, 'alex.chen@techcorp.com')
  assert.ok(bioCandidate.fields.phone && bioCandidate.fields.phone.includes('5550188'))

  // Step 3: Test persistence merging between directory record and bio page record
  const mockDb = new Map()
  const scanJobId = '654321654321654321654321'
  const pageId1 = '111111111111111111111111'
  const pageId2 = '222222222222222222222222'

  const mockScanPageModel = {
    findOne: async query => {
      if (query.normalizedUrl.includes('leadership/alex-chen')) return { _id: pageId2 }
      return { _id: pageId1 }
    }
  }

  const mockCandidateRecordModel = {
    findOne: async query => {
      for (const rec of mockDb.values()) {
        if (query.candidateKey && rec.candidateKey === query.candidateKey) return rec
        if (query['fields.profile_url'] && rec.fields?.profile_url === query['fields.profile_url']) return rec
        if (query['fields.full_name'] && rec.fields?.full_name?.toLowerCase() === query['fields.full_name'].toLowerCase()) return rec
      }
      return null
    },
    updateOne: async (filter, update, options) => {
      if (options?.upsert) {
        const id = 'cand-1'
        const rec = { ...update.$setOnInsert, _id: id }
        mockDb.set(id, rec)
        return { upsertedCount: 1 }
      }
      const existing = mockDb.get(filter._id)
      if (existing && update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
          if (k.startsWith('fields.')) {
            existing.fields[k.slice(7)] = v
          } else {
            existing[k] = v
          }
        }
      }
      return { modifiedCount: 1 }
    }
  }

  // Persist directory candidate first
  const inserted1 = await persistCandidate({
    CandidateRecordModel: mockCandidateRecordModel,
    ScanPageModel: mockScanPageModel,
    scanJobId,
    candidate: dirCandidate,
  })
  assert.equal(inserted1, true)
  assert.equal(mockDb.size, 1)

  // Persist bio page candidate second -> should merge without creating a duplicate record!
  const inserted2 = await persistCandidate({
    CandidateRecordModel: mockCandidateRecordModel,
    ScanPageModel: mockScanPageModel,
    scanJobId,
    candidate: bioCandidate,
  })
  assert.equal(inserted2, false) // merged, not inserted
  assert.equal(mockDb.size, 1) // still exactly 1 record!

  const merged = Array.from(mockDb.values())[0]
  assert.equal(merged.fields.full_name, 'Alex Chen')
  assert.equal(merged.fields.designation, 'Chief Technology Officer')
  assert.equal(merged.fields.email, 'alex.chen@techcorp.com')
  assert.ok(merged.fields.phone && merged.fields.phone.includes('5550188'))
  assert.equal(merged.sourceUrl, 'https://techcorp.com/leadership/alex-chen') // Updated to bio page
})

test('Phase 4 — Deduplication: Similar names of different people are not merged', async () => {
  const person1 = {
    candidateType: 'person',
    candidateKey: 'key-1',
    sourceUrl: 'https://firm.com/team/john-smith-finance',
    fields: { full_name: 'John Smith', designation: 'Financial Analyst', email: 'jsmith.finance@firm.com', profile_url: 'https://firm.com/team/john-smith-finance' },
    provenance: []
  }

  const person2 = {
    candidateType: 'person',
    candidateKey: 'key-2',
    sourceUrl: 'https://firm.com/team/john-smith-legal',
    fields: { full_name: 'John Smith', designation: 'Legal Counsel', email: 'jsmith.legal@firm.com', profile_url: 'https://firm.com/team/john-smith-legal' },
    provenance: []
  }

  const mockDb = new Map()
  const mockScanPageModel = { findOne: async () => ({ _id: 'page-1' }) }
  const mockCandidateRecordModel = {
    findOne: async query => {
      for (const rec of mockDb.values()) {
        if (query.candidateKey && rec.candidateKey === query.candidateKey) return rec
        if (query['fields.profile_url'] && rec.fields?.profile_url === query['fields.profile_url']) return rec
        if (query['fields.full_name'] && rec.fields?.full_name === query['fields.full_name']) {
          // If query has email/profile restrictions, check compatibility
          return rec
        }
      }
      return null
    },
    updateOne: async (filter, update, options) => {
      if (options?.upsert) {
        const id = `cand-${mockDb.size + 1}`
        mockDb.set(id, { ...update.$setOnInsert, _id: id })
        return { upsertedCount: 1 }
      }
      return { modifiedCount: 1 }
    }
  }

  const inserted1 = await persistCandidate({
    CandidateRecordModel: mockCandidateRecordModel,
    ScanPageModel: mockScanPageModel,
    scanJobId: 'job-1',
    candidate: person1
  })

  const inserted2 = await persistCandidate({
    CandidateRecordModel: mockCandidateRecordModel,
    ScanPageModel: mockScanPageModel,
    scanJobId: 'job-1',
    candidate: person2
  })

  // Because emails and profile URLs are distinct and conflict, both must be inserted as separate individuals
  assert.equal(inserted1, true)
  assert.equal(inserted2, true)
  assert.equal(mockDb.size, 2)
})
