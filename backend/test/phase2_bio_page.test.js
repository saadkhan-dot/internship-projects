import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCandidates } from '../src/extraction/candidateExtractor.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'

test('Test A — Basic individual profile extraction', () => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>John Doe - CTO - TechCorp</title></head>
    <body>
      <div class="profile-container">
        <h1>John Doe</h1>
        <p class="role">Chief Technology Officer</p>
        <p class="bio">John Doe oversees technical strategy and infrastructure.</p>
        <div class="contacts">
          <a href="mailto:john.doe@techcorp.example">Email John</a>
          <a href="tel:+15550199">+1 (555) 0199</a>
          <a href="https://www.linkedin.com/in/johndoe">LinkedIn Profile</a>
        </div>
      </div>
    </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://techcorp.example/team/john-doe' })
  const people = candidates.filter(c => c.candidateType === 'person')

  assert.equal(people.length, 1, 'Should extract exactly one person candidate')
  const person = people[0]
  assert.equal(person.fields.full_name, 'John Doe')
  assert.equal(person.fields.first_name, 'John')
  assert.equal(person.fields.last_name, 'Doe')
  assert.equal(person.fields.designation, 'Chief Technology Officer')
  assert.equal(person.fields.email, 'john.doe@techcorp.example')
  assert.ok(person.fields.phone && person.fields.phone.includes('5550199'))
  assert.equal(person.fields.linkedin_url, 'https://linkedin.com/in/johndoe')
  assert.equal(person.fields.source_url, 'https://techcorp.example/team/john-doe')
})

test('Test B — Individual profile without CSS classes', () => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Sarah Connor Profile</title></head>
    <body>
      <main>
        <h1>Sarah Connor</h1>
        <p>Security Director</p>
        <p>Sarah Connor has over twenty years of experience designing secure systems and crisis management protocols across global operations.</p>
        <div>
          <a href="mailto:sarah@resistance.org">sarah@resistance.org</a>
          <a href="tel:+14155550100">+1 415-555-0100</a>
          <a href="https://www.linkedin.com/in/sarahconnor">LinkedIn</a>
        </div>
      </main>
    </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://resistance.org/people/sarah-connor' })
  const people = candidates.filter(c => c.candidateType === 'person')

  assert.equal(people.length, 1, 'Should extract person from plain HTML without CSS classes')
  const person = people[0]
  assert.equal(person.fields.full_name, 'Sarah Connor')
  assert.equal(person.fields.designation, 'Security Director')
  assert.equal(person.fields.email, 'sarah@resistance.org')
  assert.ok(person.fields.phone && person.fields.phone.includes('5550100'))
  assert.equal(person.fields.linkedin_url, 'https://linkedin.com/in/sarahconnor')
})

test('Test C — Name-only page with no profile signals is rejected', () => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Harold Finch</title></head>
    <body>
      <main>
        <h1>Harold Finch</h1>
      </main>
    </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/harold-finch' })
  const people = candidates.filter(c => c.candidateType === 'person')

  assert.equal(people.length, 0, 'Name-only page with no profile signals must not produce a person candidate')
})

test('Test D — Contact page must not produce a false person candidate', () => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Contact Us - Acme Corp</title></head>
    <body>
      <main>
        <h1>Contact Us</h1>
        <p>Get in touch with our team for customer support and sales inquiries.</p>
        <p><strong>Email:</strong> <a href="mailto:info@acme.com">info@acme.com</a></p>
        <p><strong>Phone:</strong> <a href="tel:+18005550199">+1 800-555-0199</a></p>
      </main>
    </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://acme.com/contact' })
  const people = candidates.filter(c => c.candidateType === 'person')

  assert.equal(people.length, 0, 'Contact Us page must produce zero person candidates')
  assert.equal(candidates.some(c => c.fields?.full_name === 'Contact Us'), false)
})

test('Test E — Biography paragraph is not classified as designation', () => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Nell Shamrell-Harrington</title></head>
    <body>
      <main>
        <h1>Nell Shamrell-Harrington</h1>
        <p>Nell Shamrell-Harrington is a senior technologist, community organizer, and open source advocate who has spent over a decade leading engineering initiatives across the tech sector.</p>
        <a href="mailto:nell@example.org">nell@example.org</a>
        <a href="https://www.linkedin.com/in/nellshamrell">LinkedIn</a>
      </main>
    </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.org/team/nell-shamrell-harrington' })
  const person = candidates.find(c => c.candidateType === 'person' && c.fields.full_name === 'Nell Shamrell-Harrington')

  assert.ok(person, 'Nell Shamrell-Harrington must be extracted')
  assert.equal(person.fields.designation, null, 'Bio narrative must not be assigned as designation')
  assert.equal(person.fields.email, 'nell@example.org')
  assert.equal(person.fields.linkedin_url, 'https://linkedin.com/in/nellshamrell')
})

test('Test F — LinkedIn company page is NOT assigned to person linkedin_url', () => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Alan Turing - Cryptanalyst</title></head>
    <body>
      <main>
        <h1>Alan Turing</h1>
        <p class="role">Chief Cryptanalyst</p>
        <a href="mailto:alan@bletchley.org">alan@bletchley.org</a>
        <a href="https://www.linkedin.com/company/bletchley-park">Bletchley Park on LinkedIn</a>
      </main>
    </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://bletchley.org/staff/alan-turing' })
  const person = candidates.find(c => c.candidateType === 'person' && c.fields.full_name === 'Alan Turing')

  assert.ok(person, 'Alan Turing must be extracted')
  assert.equal(person.fields.designation, 'Chief Cryptanalyst')
  assert.equal(person.fields.email, 'alan@bletchley.org')
  assert.equal(person.fields.linkedin_url, null, 'Company LinkedIn page must NEVER be assigned to person linkedin_url')
})

test('Test G — Structured profile (JSON-LD + DOM) consolidates without duplicates', () => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Ada Lovelace</title>
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Person",
          "name": "Ada Lovelace",
          "jobTitle": "Lead Analyst",
          "worksFor": { "@type": "Organization", "name": "Babbage Engines" }
        }
      </script>
    </head>
    <body>
      <main>
        <h1>Ada Lovelace</h1>
        <p class="role">Lead Analyst</p>
        <p class="bio">Ada Lovelace is a mathematician and analyst.</p>
        <a href="mailto:ada@babbage.org">Email Ada</a>
        <a href="https://www.linkedin.com/in/ada-lovelace">LinkedIn</a>
      </main>
    </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://babbage.org/team/ada-lovelace' })
  const people = candidates.filter(c => c.candidateType === 'person' && c.fields.full_name === 'Ada Lovelace')

  assert.equal(people.length, 1, 'Should consolidate JSON-LD and bio page DOM into exactly 1 candidate')
  const person = people[0]
  assert.equal(person.fields.full_name, 'Ada Lovelace')
  assert.equal(person.fields.designation, 'Lead Analyst')
  assert.equal(person.fields.company, 'Babbage Engines')
  assert.equal(person.fields.email, 'ada@babbage.org')
  assert.equal(person.fields.linkedin_url, 'https://linkedin.com/in/ada-lovelace')
})

test('Test H — Existing profile cards remain fully functional without regressions', () => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Our Leadership Team</title></head>
    <body>
      <h1>Our Team</h1>
      <div class="team-grid">
        <div class="member-card">
          <h3>Alice Walker</h3>
          <p class="role">VP Product</p>
          <a href="mailto:alice@example.com">alice@example.com</a>
        </div>
        <div class="member-card">
          <h3>Bob Vance</h3>
          <p class="role">Sales Director</p>
          <a href="mailto:bob@example.com">bob@example.com</a>
        </div>
      </div>
    </body>
    </html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/team' })
  const people = candidates.filter(c => c.candidateType === 'person')

  assert.equal(people.length, 2, 'Should extract exactly 2 members from profile cards')
  assert.ok(people.some(p => p.fields.full_name === 'Alice Walker' && p.fields.designation === 'VP Product'))
  assert.ok(people.some(p => p.fields.full_name === 'Bob Vance' && p.fields.designation === 'Sales Director'))
})

test('Test I — Two different people with similar names are not merged', () => {
  const html1 = `
    <html><body>
      <main>
        <h1>John Smith</h1>
        <p class="role">Senior Developer</p>
        <a href="mailto:john.smith@domain-a.com">john.smith@domain-a.com</a>
      </main>
    </body></html>
  `
  const html2 = `
    <html><body>
      <main>
        <h1>John Smith</h1>
        <p class="role">Marketing Manager</p>
        <a href="mailto:john.smith@domain-b.com">john.smith@domain-b.com</a>
      </main>
    </body></html>
  `
  const result1 = extractCandidates(html1, { sourceUrl: 'https://domain-a.com/team/john-smith' })
  const result2 = extractCandidates(html2, { sourceUrl: 'https://domain-b.com/team/john-smith' })

  const person1 = result1.candidates.find(c => c.candidateType === 'person')
  const person2 = result2.candidates.find(c => c.candidateType === 'person')

  assert.ok(person1 && person2)
  assert.notEqual(person1.candidateKey, person2.candidateKey, 'Different people with distinct emails must have distinct candidateKeys')
  assert.equal(person1.fields.email, 'john.smith@domain-a.com')
  assert.equal(person2.fields.email, 'john.smith@domain-b.com')
})

test('Test J — Persistence integration synchronizes bio page candidate into PersonProfile and Lead', async () => {
  const html = `
    <html><body>
      <main>
        <h1>Harold Finch</h1>
        <p class="role">Chief Architect</p>
        <a href="mailto:finch@iff.org">finch@iff.org</a>
        <a href="tel:+12125550188">+1 212-555-0188</a>
        <a href="https://www.linkedin.com/in/haroldfinch">LinkedIn</a>
      </main>
    </body></html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://iff.org/staff/harold-finch' })
  const candidate = candidates.find(c => c.candidateType === 'person')
  assert.ok(candidate)

  // Test persistence sync using mock models
  const scanJobId = '507f1f77bcf86cd799439011'
  let persistedPage = { _id: '507f1f77bcf86cd799439012' }
  let storedCandidateRecord = null
  let storedPersonProfile = null
  let storedLead = null

  const MockScanPageModel = {
    findOne: () => ({ select: async () => persistedPage }),
  }

  const MockCandidateRecordModel = {
    findOne: async () => storedCandidateRecord,
    updateOne: async (query, update) => {
      if (update.$setOnInsert) storedCandidateRecord = { ...update.$setOnInsert, _id: 'cand-1' }
      return { upsertedCount: 1 }
    },
  }

  const MockPersonProfileModel = {
    updateOne: async (query, update) => {
      storedPersonProfile = { ...query, ...update.$set }
      return { acknowledged: true }
    },
  }

  const MockLeadModel = {
    updateOne: async (query, update) => {
      storedLead = { ...query, ...update.$set, status: update.$setOnInsert?.status || 'new' }
      return { acknowledged: true }
    },
    countDocuments: async () => 1,
  }

  const MockScanJobModel = {
    updateOne: async () => ({ acknowledged: true }),
  }

  const inserted = await persistCandidate({
    CandidateRecordModel: MockCandidateRecordModel,
    ScanPageModel: MockScanPageModel,
    LeadModel: MockLeadModel,
    PersonProfileModel: MockPersonProfileModel,
    CompanyProfileModel: {},
    ScanJobModel: MockScanJobModel,
    scanJobId,
    candidate,
  })

  assert.equal(inserted, true, 'Candidate should be inserted')
  assert.ok(storedPersonProfile, 'PersonProfile should be created')
  assert.equal(storedPersonProfile.name, 'Harold Finch')
  assert.equal(storedPersonProfile.title, 'Chief Architect')
  assert.equal(storedPersonProfile.email, 'finch@iff.org')

  assert.ok(storedLead, 'Lead should be created')
  assert.equal(storedLead.name, 'Harold Finch')
  assert.equal(storedLead.title, 'Chief Architect')
  assert.equal(storedLead.email, 'finch@iff.org')
  assert.equal(storedLead.status, 'new')
  assert.equal(storedLead.sourceUrl, 'https://iff.org/staff/harold-finch')
})
