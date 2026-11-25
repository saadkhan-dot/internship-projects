import test from 'node:test'
import assert from 'node:assert/strict'
import { sameHost } from '../src/discovery/url.js'
import { extractCandidates } from '../src/extraction/candidateExtractor.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'

test('1. sameHost matches apex domain and www subdomain correctly', () => {
  assert.equal(sameHost('https://www.example.com', 'https://example.com'), true)
  assert.equal(sameHost('https://example.com/team', 'https://www.example.com'), true)
  assert.equal(sameHost('http://www.sub.example.com', 'http://www.sub.example.com'), true)
  assert.equal(sameHost('https://other.com', 'https://example.com'), false)
})

test('2. Profile card segmentation extracts multiple team members with roles and contacts', () => {
  const teamHtml = `
    <html><body>
      <main>
        <h1>Our Team</h1>
        <div class="team-grid">
          <div class="member-card">
            <h3>Sarah Connor</h3>
            <p class="role">Chief Executive Officer</p>
            <a href="mailto:sarah@acme.com">sarah@acme.com</a>
            <a href="https://www.linkedin.com/in/sarah-connor">LinkedIn</a>
          </div>
          <div class="member-card">
            <h3>John Reese</h3>
            <p class="role">Chief Technology Officer</p>
            <a href="mailto:john@acme.com">john@acme.com</a>
            <a href="https://www.linkedin.com/in/john-reese">LinkedIn</a>
          </div>
          <div class="member-card">
            <h3>Harold Finch</h3>
            <p class="role">Head of Engineering</p>
            <a href="mailto:harold@acme.com">harold@acme.com</a>
            <a href="https://www.linkedin.com/in/harold-finch">LinkedIn</a>
          </div>
        </div>
      </main>
    </body></html>
  `
  const { candidates } = extractCandidates(teamHtml, { sourceUrl: 'https://acme.com/team' })
  const people = candidates.filter(c => c.candidateType === 'person')

  assert.equal(people.length, 3, 'Should extract exactly 3 person candidates')

  const sarah = people.find(p => p.fields.full_name === 'Sarah Connor')
  assert.ok(sarah, 'Sarah Connor should be extracted')
  assert.equal(sarah.fields.designation, 'Chief Executive Officer')
  assert.equal(sarah.fields.email, 'sarah@acme.com')
  assert.equal(sarah.fields.linkedin_url, 'https://linkedin.com/in/sarah-connor')

  const john = people.find(p => p.fields.full_name === 'John Reese')
  assert.ok(john, 'John Reese should be extracted')
  assert.equal(john.fields.designation, 'Chief Technology Officer')
  assert.equal(john.fields.email, 'john@acme.com')
  assert.equal(john.fields.linkedin_url, 'https://linkedin.com/in/john-reese')

  const harold = people.find(p => p.fields.full_name === 'Harold Finch')
  assert.ok(harold, 'Harold Finch should be extracted')
  assert.equal(harold.fields.designation, 'Head of Engineering')
  assert.equal(harold.fields.email, 'harold@acme.com')
  assert.equal(harold.fields.linkedin_url, 'https://linkedin.com/in/harold-finch')

  // Unknown fragments should be 0 because all contacts belong to recognized people
  const unknowns = candidates.filter(c => c.candidateType === 'unknown')
  assert.equal(unknowns.length, 0, 'No orphaned unknown candidates should remain')
})

test('3. CRM model sync populates Lead and PersonProfile collections', async () => {
  const records = new Map()
  const leads = new Map()
  const people = new Map()

  const mockCandidateModel = {
    findOne: async ({ scanJobId, candidateKey }) => records.get(`${scanJobId}|${candidateKey}`) || null,
    updateOne: async (filter, update, options) => {
      const key = `${filter.scanJobId || filter._id}|${filter.candidateKey || ''}`
      if (options?.upsert) {
        records.set(key, { _id: 'cand-1', ...update.$setOnInsert })
        return { upsertedCount: 1 }
      }
      return { modifiedCount: 1 }
    }
  }

  const mockPageModel = {
    findOne: () => ({ select: async () => ({ _id: 'page-1' }) })
  }

  const mockLeadModel = {
    updateOne: async (filter, update) => {
      const key = `${filter.scanId}|${filter.candidateKey}`
      leads.set(key, { ...update.$set, ...update.$setOnInsert })
      return { upsertedCount: 1 }
    },
    countDocuments: async () => leads.size
  }

  const mockPersonModel = {
    updateOne: async (filter, update) => {
      const key = `${filter.scanId}|${filter.candidateKey}`
      people.set(key, { ...update.$set, ...update.$setOnInsert })
      return { upsertedCount: 1 }
    }
  }

  const mockScanJobModel = {
    updateOne: async () => ({ modifiedCount: 1 })
  }

  const candidate = {
    candidateKey: 'sarah-connor-key',
    candidateType: 'person',
    fields: {
      full_name: 'Sarah Connor',
      designation: 'CEO',
      email: 'sarah@acme.com',
      phone: '+14155550199',
      linkedin_url: 'https://linkedin.com/in/sarah-connor',
      company: 'Acme Corp'
    },
    provenance: [],
    sourceUrl: 'https://acme.com/team',
    extractedAt: new Date()
  }

  await persistCandidate({
    CandidateRecordModel: mockCandidateModel,
    ScanPageModel: mockPageModel,
    LeadModel: mockLeadModel,
    PersonProfileModel: mockPersonModel,
    CompanyProfileModel: {},
    ScanJobModel: mockScanJobModel,
    scanJobId: 'scan-123',
    candidate
  })

  // Verify Lead was created
  assert.equal(leads.size, 1, 'Lead should be created in CRM')
  const lead = leads.get('scan-123|sarah-connor-key')
  assert.equal(lead.name, 'Sarah Connor')
  assert.equal(lead.email, 'sarah@acme.com')
  assert.equal(lead.title, 'CEO')
  assert.equal(lead.company, 'Acme Corp')
  assert.equal(lead.status, 'new')

  // Verify PersonProfile was created
  assert.equal(people.size, 1, 'PersonProfile should be created in CRM')
  const person = people.get('scan-123|sarah-connor-key')
  assert.equal(person.name, 'Sarah Connor')
  assert.equal(person.title, 'CEO')
  assert.equal(person.organization, 'Acme Corp')
})
