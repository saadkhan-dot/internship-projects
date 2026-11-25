import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { cleanText, makeWhitespaceFlexibleRegex } from '../src/extraction/normalization.js'
import { ScanJob, ScanPage, CandidateRecord, Lead, PersonProfile, CompanyProfile } from '../src/models/index.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_name_whitespace_test'

test('DEF-006: Name Whitespace Normalization & Tier 3 Deduplication Test Suite', async (t) => {
  // ========================================================
  // UNIT TESTS: cleanText & makeWhitespaceFlexibleRegex
  // ========================================================

  await t.test('1. Unit: cleanText normalizes all whitespace variants into single spaces', () => {
    assert.equal(cleanText('John Doe'), 'John Doe')
    assert.equal(cleanText('John  Doe'), 'John Doe')
    assert.equal(cleanText(' John Doe '), 'John Doe')
    assert.equal(cleanText('John   Doe '), 'John Doe')
    assert.equal(cleanText('John\tDoe'), 'John Doe')
    assert.equal(cleanText('John\nDoe'), 'John Doe')
    assert.equal(cleanText('John\r\nDoe'), 'John Doe')
    assert.equal(cleanText('John\u00A0Doe'), 'John Doe')
    assert.equal(cleanText('JOHN DOE'), 'JOHN DOE') // preserves case
    assert.equal(cleanText(''), null)
    assert.equal(cleanText(null), null)
    assert.equal(cleanText(undefined), null)
  })

  await t.test('2. Unit: makeWhitespaceFlexibleRegex constructs whitespace-tolerant, safe regex', () => {
    const rx = makeWhitespaceFlexibleRegex('John Doe')
    assert.ok(rx)
    // Matches whitespace variations
    assert.equal(rx.test('John Doe'), true)
    assert.equal(rx.test('John  Doe'), true)
    assert.equal(rx.test('John\tDoe'), true)
    assert.equal(rx.test('John\nDoe'), true)
    assert.equal(rx.test('John\u00A0Doe'), true)
    assert.equal(rx.test('JOHN DOE'), true)
    assert.equal(rx.test('john doe'), true)

    // Suffix and middle initial protection (strict boundaries)
    assert.equal(rx.test('John Doe Jr.'), false)
    assert.equal(rx.test('John Doe Sr.'), false)
    assert.equal(rx.test('John A. Doe'), false)
    assert.equal(rx.test('Johnny Doe'), false)
    assert.equal(rx.test('Sir John Doe'), false)

    // Regex metacharacter escaping
    const safeRx = makeWhitespaceFlexibleRegex('Dr. J. R. R. Tolkien (Prof.)')
    assert.ok(safeRx)
    assert.equal(safeRx.test('Dr. J. R. R. Tolkien (Prof.)'), true)
    assert.equal(safeRx.test('Dr.  J.  R.  R.  Tolkien  (Prof.)'), true)
    assert.equal(safeRx.test('DrX JX RX RX Tolkien XProfX'), false)

    // Empty or non-string inputs return null
    assert.equal(makeWhitespaceFlexibleRegex(''), null)
    assert.equal(makeWhitespaceFlexibleRegex('   '), null)
    assert.equal(makeWhitespaceFlexibleRegex(null), null)
    assert.equal(makeWhitespaceFlexibleRegex(undefined), null)
  })

  // ========================================================
  // INTEGRATION TESTS: MongoDB & persistCandidate
  // ========================================================

  await mongoose.connect(TEST_DB_URI)

  let scanA
  let scanB
  let pageA
  let pageB

  const clearDb = async () => {
    await Promise.all([
      ScanJob.deleteMany({}),
      ScanPage.deleteMany({}),
      CandidateRecord.deleteMany({}),
      Lead.deleteMany({}),
      PersonProfile.deleteMany({}),
      CompanyProfile.deleteMany({}),
    ])
    scanA = await ScanJob.create({ target: 'https://test-a.org', status: 'completed', type: 'website' })
    scanB = await ScanJob.create({ target: 'https://test-b.org', status: 'completed', type: 'website' })
    pageA = await ScanPage.create({
      scanId: scanA._id,
      url: 'https://test-a.org/team',
      normalizedUrl: 'https://test-a.org/team',
      processingStatus: 'fetched',
      source: 'seed',
    })
    pageB = await ScanPage.create({
      scanId: scanB._id,
      url: 'https://test-b.org/team',
      normalizedUrl: 'https://test-b.org/team',
      processingStatus: 'fetched',
      source: 'seed',
    })
  }

  t.after(async () => {
    await clearDb()
    await mongoose.disconnect()
  })

  await t.test('3. Tier 3: Multiple spaces in incoming candidate matches clean existing Lead', async () => {
    await clearDb()

    // 1st extraction: Clean record
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'cand-clean-1',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'John Doe',
          company: 'Acme Corp',
          designation: 'Staff Engineer',
        },
      },
    })

    const initial = await Lead.find({ company: 'Acme Corp' })
    assert.equal(initial.length, 1)
    assert.equal(initial[0].name, 'John Doe')

    // 2nd extraction: Incoming candidate with internal double space and leading/trailing space
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-spaces-2',
        candidateType: 'person',
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: '  John   Doe  ',
          company: 'Acme Corp',
          email: 'johndoe@acme.test',
        },
      },
    })

    const leads = await Lead.find({ company: 'Acme Corp' })
    assert.equal(leads.length, 1, 'Should match existing lead and not create duplicate')
    assert.equal(leads[0].email, 'johndoe@acme.test', 'Should enrich existing lead with email')
    assert.equal(leads[0].title, 'Staff Engineer', 'Should preserve existing title')
    assert.equal(leads[0].name, 'John Doe', 'Stored name must remain cleanly normalized')
  })

  await t.test('4. Tier 3: Existing dirty record in DB is matched by clean incoming candidate', async () => {
    await clearDb()

    // Simulate existing legacy dirty record in DB with double spacing
    const dirtyLead = await Lead.create({
      name: 'Sarah  Connor',
      company: 'Cyberdyne  Systems',
      title: 'Operations Director',
      status: 'new',
      scanId: scanA._id,
      candidateKey: 'sarah-dirty-legacy',
      sourceUrl: 'https://legacy-site.org/staff',
    })
    assert.ok(dirtyLead)

    // Incoming candidate has cleanly formatted name and company
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'sarah-clean-incoming',
        candidateType: 'person',
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: 'Sarah Connor',
          company: 'Cyberdyne Systems',
          phone: '+1 310 555 0199',
        },
      },
    })

    const allLeads = await Lead.find({})
    assert.equal(allLeads.length, 1, 'Legacy dirty record must be matched by incoming clean candidate')
    assert.equal(allLeads[0].phone, '+1 310 555 0199', 'Enriched with phone')
    assert.equal(allLeads[0].title, 'Operations Director', 'Original title preserved')
  })

  await t.test('5. Tier 3: Tab, newline, and Unicode non-breaking space normalization', async () => {
    await clearDb()

    // 1. Initial clean lead
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'cand-tabs-1',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'Marcus Wright',
          company: 'Resistance Org',
          designation: 'Field Commander',
        },
      },
    })

    // 2. Tab-separated name
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-tabs-2',
        candidateType: 'person',
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: 'Marcus\tWright',
          company: 'Resistance Org',
          email: 'marcus@resistance.test',
        },
      },
    })

    // 3. Newline-separated name
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-newline-3',
        candidateType: 'person',
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: 'Marcus\nWright',
          company: 'Resistance Org',
          phone: '+1 555 0188',
        },
      },
    })

    // 4. Unicode non-breaking space (U+00A0)
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-nbsp-4',
        candidateType: 'person',
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: 'Marcus\u00A0Wright',
          company: 'Resistance Org',
          linkedin_url: 'https://linkedin.com/in/marcus-wright',
        },
      },
    })

    const leads = await Lead.find({ name: /Marcus.*Wright/i })
    assert.equal(leads.length, 1, 'All whitespace variants must resolve to the same single Lead')
    assert.equal(leads[0].email, 'marcus@resistance.test')
    assert.equal(leads[0].phone, '+1 555 0188')
    assert.equal(leads[0].linkedinUrl, 'https://linkedin.com/in/marcus-wright')
    assert.equal(leads[0].title, 'Field Commander')
  })

  await t.test('6. Tier 3: Company name whitespace normalization', async () => {
    await clearDb()

    // 1st extraction: Acme   Industrial   Enterprises
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'cand-comp-1',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'Elena Rostova',
          company: 'Acme   Industrial   Enterprises',
          designation: 'VP Engineering',
        },
      },
    })

    // 2nd extraction: Same person with clean single spaces in company
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-comp-2',
        candidateType: 'person',
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: 'Elena Rostova',
          company: 'Acme Industrial Enterprises',
          email: 'elena@acme-industrial.test',
        },
      },
    })

    // 3rd extraction: Same person with tab in company
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-comp-3',
        candidateType: 'person',
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: 'Elena Rostova',
          company: 'Acme\tIndustrial\tEnterprises',
          phone: '+1 415 555 0122',
        },
      },
    })

    const leads = await Lead.find({ name: /Elena Rostova/i })
    assert.equal(leads.length, 1, 'Company whitespace differences must not create duplicate leads')
    assert.equal(leads[0].email, 'elena@acme-industrial.test')
    assert.equal(leads[0].phone, '+1 415 555 0122')
    assert.equal(leads[0].title, 'VP Engineering')
  })

  await t.test('7. Boundary Protection: Name suffix (Jr.) and Middle Initials remain distinct', async () => {
    await clearDb()

    // Senior / base name
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'john-doe-sr',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'John Doe',
          company: 'Gotham Technologies',
          designation: 'Senior Director',
        },
      },
    })

    // Junior
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'john-doe-jr',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'John Doe Jr.',
          company: 'Gotham Technologies',
          designation: 'Junior Associate',
        },
      },
    })

    // Middle Initial A
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'john-a-doe',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'John A. Doe',
          company: 'Gotham Technologies',
          designation: 'Analyst A',
        },
      },
    })

    // Middle Initial B
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'john-b-doe',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'John B. Doe',
          company: 'Gotham Technologies',
          designation: 'Analyst B',
        },
      },
    })

    const allGothams = await Lead.find({ company: 'Gotham Technologies' })
    assert.equal(allGothams.length, 4, 'John Doe, John Doe Jr., John A. Doe, and John B. Doe must remain distinct leads')
  })

  await t.test('8. Isolation: Same person name across different companies remain distinct', async () => {
    await clearDb()

    // Alice at Acme
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'alice-acme',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'Alice Cooper',
          company: 'Acme Corp',
          designation: 'Developer',
        },
      },
    })

    // Alice at Beta Industries
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'alice-beta',
        candidateType: 'person',
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: 'Alice Cooper',
          company: 'Beta Industries',
          designation: 'Lead Architect',
        },
      },
    })

    const aliceAcme = await Lead.find({ name: 'Alice Cooper', company: 'Acme Corp' })
    const aliceBeta = await Lead.find({ name: 'Alice Cooper', company: 'Beta Industries' })
    assert.equal(aliceAcme.length, 1)
    assert.equal(aliceBeta.length, 1)
    assert.equal(aliceAcme[0].title, 'Developer')
    assert.equal(aliceBeta[0].title, 'Lead Architect')
    assert.notEqual(String(aliceAcme[0]._id), String(aliceBeta[0]._id))
  })

  await t.test('9. Tiers 1 and 2 are unaffected by name whitespace normalization', async () => {
    await clearDb()

    // 1. Tier 1 LinkedIn match: same LinkedIn slug overrides different names
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
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'Robert Banner',
          company: 'Stark Labs',
          linkedin_url: 'https://linkedin.com/in/banner-hero',
        },
      },
    })

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
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: 'Bob   Banner',
          company: 'Avengers Initiative',
          linkedin_url: 'https://www.linkedin.com/in/banner-hero/',
          email: 'banner@starklabs.test',
        },
      },
    })

    const liLeads = await Lead.find({ linkedinUrl: /banner-hero/i })
    assert.equal(liLeads.length, 1, 'Tier 1 LinkedIn match should deduplicate regardless of name or company differences')
    assert.equal(liLeads[0].email, 'banner@starklabs.test')

    // 2. Tier 2 Email match: same email overrides different names or whitespace
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'cand-em-1',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: 'Natasha Romanoff',
          company: 'KGB Labs',
          email: 'natasha@shield.test',
        },
      },
    })

    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanB._id,
      candidate: {
        candidateKey: 'cand-em-2',
        candidateType: 'person',
        sourceUrl: 'https://test-b.org/team',
        fields: {
          full_name: 'Nat   Romanoff',
          company: 'SHIELD Operations',
          email: 'NATASHA@SHIELD.TEST',
          phone: '+1 212 555 0177',
        },
      },
    })

    const emailLeads = await Lead.find({ email: 'natasha@shield.test' })
    assert.equal(emailLeads.length, 1, 'Tier 2 Email match should deduplicate regardless of name differences')
    assert.equal(emailLeads[0].phone, '+1 212 555 0177')
  })

  await t.test('10. Newly inserted Lead records store cleanly normalized name and company', async () => {
    await clearDb()

    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scanA._id,
      candidate: {
        candidateKey: 'dirty-new-cand',
        candidateType: 'person',
        sourceUrl: 'https://test-a.org/team',
        fields: {
          full_name: '  Jean\t  Grey  ',
          company: ' Xavier   Institute\tfor Higher Learning ',
          designation: '  Senior\tInstructor  ',
        },
      },
    })

    const lead = await Lead.findOne({ candidateKey: 'dirty-new-cand' })
    assert.ok(lead)
    assert.equal(lead.name, 'Jean Grey', 'Lead name must be trimmed and single-spaced')
    assert.equal(lead.company, 'Xavier Institute for Higher Learning', 'Company must be trimmed and single-spaced')
    assert.equal(lead.title, 'Senior Instructor', 'Title must be trimmed and single-spaced')

    const profile = await PersonProfile.findOne({ candidateKey: 'dirty-new-cand' })
    assert.ok(profile)
    assert.equal(profile.name, 'Jean Grey')
    assert.equal(profile.organization, 'Xavier Institute for Higher Learning')
    assert.equal(profile.title, 'Senior Instructor')
  })
})
