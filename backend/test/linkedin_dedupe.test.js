import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { parseLinkedInProfileSlug } from '../src/extraction/normalization.js'
import { ScanJob, ScanPage, CandidateRecord, Lead, PersonProfile, CompanyProfile } from '../src/models/index.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'

const LINKEDIN_TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_linkedin_dedupe_test'

test('DEF-004: LinkedIn URL Canonicalization & Deduplication Test Suite', async (t) => {
  // ========================================================
  // UNIT TESTS: parseLinkedInProfileSlug
  // ========================================================

  await t.test('1. Unit: Extracts and canonicalizes personal LinkedIn profile slugs', () => {
    // Basic /in/ URLs
    assert.equal(parseLinkedInProfileSlug('https://www.linkedin.com/in/johndoe'), 'johndoe')
    assert.equal(parseLinkedInProfileSlug('http://linkedin.com/in/johndoe/'), 'johndoe')
    assert.equal(parseLinkedInProfileSlug('https://uk.linkedin.com/in/johndoe?trk=profile'), 'johndoe')
    assert.equal(parseLinkedInProfileSlug('https://www.linkedin.com/in/JohnDoe/'), 'johndoe')
    assert.equal(parseLinkedInProfileSlug('https://www.linkedin.com/in/john-doe-12345/'), 'john-doe-12345')

    // Legacy /pub/ URLs
    assert.equal(parseLinkedInProfileSlug('https://www.linkedin.com/pub/some-user/'), 'some-user')

    // Company and school pages must return null (not personal profile)
    assert.equal(parseLinkedInProfileSlug('https://www.linkedin.com/company/acme-corp'), null)
    assert.equal(parseLinkedInProfileSlug('https://www.linkedin.com/school/harvard'), null)

    // Non-LinkedIn domains must return null
    assert.equal(parseLinkedInProfileSlug('https://evil-linkedin.com/in/johndoe'), null)
    assert.equal(parseLinkedInProfileSlug('https://google.com/in/johndoe'), null)

    // Invalid or empty URLs
    assert.equal(parseLinkedInProfileSlug('not-a-url'), null)
    assert.equal(parseLinkedInProfileSlug('https://www.linkedin.com/in/'), null)
    assert.equal(parseLinkedInProfileSlug('https://www.linkedin.com/in/?param=1'), null)
    assert.equal(parseLinkedInProfileSlug(''), null)
    assert.equal(parseLinkedInProfileSlug(null), null)
    assert.equal(parseLinkedInProfileSlug(undefined), null)
  })

  // ========================================================
  // INTEGRATION TESTS: persistCandidate & LeadModel Deduplication
  // ========================================================

  await mongoose.connect(LINKEDIN_TEST_DB_URI)

  let scan
  let page

  const initScanAndPage = async () => {
    await Promise.all([
      ScanJob.deleteMany({}),
      ScanPage.deleteMany({}),
      CandidateRecord.deleteMany({}),
      Lead.deleteMany({}),
      PersonProfile.deleteMany({}),
      CompanyProfile.deleteMany({}),
    ])
    scan = await ScanJob.create({ target: 'https://test-site.org', status: 'completed', type: 'website' })
    page = await ScanPage.create({
      scanId: scan._id,
      url: 'https://test-site.org/team',
      normalizedUrl: 'https://test-site.org/team',
      processingStatus: 'fetched',
      source: 'seed',
    })
  }

  await initScanAndPage()

  t.after(async () => {
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

  await t.test('2. Deduplication: HTTPS vs HTTP variants of the same LinkedIn profile', async () => {
    await initScanAndPage()

    // 1st extraction: Saved with HTTPS
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'sarah-https',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Sarah Connor',
          designation: 'Operations Lead',
          company: 'Resistance Org',
          linkedin_url: 'https://linkedin.com/in/sarah-connor',
        },
      },
    })

    const initial = await Lead.find({ name: 'Sarah Connor' })
    assert.equal(initial.length, 1)

    // 2nd extraction: Scraped with HTTP and new phone number
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'sarah-http',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Sarah Connor',
          company: 'Resistance Org',
          linkedin_url: 'http://linkedin.com/in/sarah-connor',
          phone: '+1 555 0100',
        },
      },
    })

    const leads = await Lead.find({ name: 'Sarah Connor' })
    assert.equal(leads.length, 1, 'HTTP vs HTTPS must deduplicate into the same lead record')
    assert.equal(leads[0].phone, '+1 555 0100', 'Phone must be enriched')
    assert.equal(leads[0].title, 'Operations Lead', 'Original designation must be preserved')
    // Original display URL is kept
    assert.equal(leads[0].linkedinUrl, 'https://linkedin.com/in/sarah-connor')
  })

  await t.test('3. Deduplication: www vs non-www subdomain variants', async () => {
    await initScanAndPage()

    // 1st: with www.
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'john-www',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'John Connor',
          company: 'Resistance Org',
          linkedin_url: 'https://www.linkedin.com/in/john-connor',
        },
      },
    })

    // 2nd: without www.
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'john-non-www',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'John Connor',
          company: 'Resistance Org',
          linkedin_url: 'https://linkedin.com/in/john-connor',
          email: 'jconnor@resistance.org',
        },
      },
    })

    const leads = await Lead.find({ name: 'John Connor' })
    assert.equal(leads.length, 1, 'www vs non-www must deduplicate to single lead')
    assert.equal(leads[0].email, 'jconnor@resistance.org')
  })

  await t.test('4. Deduplication: Trailing slash vs no trailing slash', async () => {
    await initScanAndPage()

    // 1st: with trailing slash
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'kyle-slash',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Kyle Reese',
          linkedin_url: 'https://www.linkedin.com/in/kyle-reese/',
        },
      },
    })

    // 2nd: no trailing slash
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'kyle-no-slash',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Kyle Reese',
          linkedin_url: 'https://www.linkedin.com/in/kyle-reese',
          phone: '+1 555 0199',
        },
      },
    })

    const leads = await Lead.find({ name: 'Kyle Reese' })
    assert.equal(leads.length, 1, 'Trailing slash variants must deduplicate')
    assert.equal(leads[0].phone, '+1 555 0199')
  })

  await t.test('5. Deduplication: Query parameters and tracking tokens', async () => {
    await initScanAndPage()

    // 1st: clean URL
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 't800-clean',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'T-800 Guardian',
          linkedin_url: 'https://www.linkedin.com/in/t800-guardian',
        },
      },
    })

    // 2nd: URL with query parameters
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 't800-query',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'T-800 Guardian',
          linkedin_url: 'https://www.linkedin.com/in/t800-guardian?trk=public_profile&utm_source=share#experience',
          designation: 'Cybernetic Security Lead',
        },
      },
    })

    const leads = await Lead.find({ name: 'T-800 Guardian' })
    assert.equal(leads.length, 1, 'Query parameters must not cause duplicate leads')
    assert.equal(leads[0].title, 'Cybernetic Security Lead')
  })

  await t.test('6. Deduplication: Case normalization in slug', async () => {
    await initScanAndPage()

    // 1st: CamelCase slug
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'miles-upper',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Miles Dyson',
          linkedin_url: 'https://www.linkedin.com/in/MilesDyson',
        },
      },
    })

    // 2nd: lowercase slug
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'miles-lower',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Miles Dyson',
          linkedin_url: 'http://linkedin.com/in/milesdyson/',
          email: 'miles@cyberdyne.test',
        },
      },
    })

    const leads = await Lead.find({ name: 'Miles Dyson' })
    assert.equal(leads.length, 1, 'Case variants must match case-insensitively')
    assert.equal(leads[0].email, 'miles@cyberdyne.test')
  })

  await t.test('7. Boundary Safety: Two different profile slugs must NEVER be conflated', async () => {
    await initScanAndPage()

    // Three distinct people with overlapping slug prefixes
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'smith-base',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Agent Smith',
          linkedin_url: 'https://www.linkedin.com/in/agent-smith',
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
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'smith-1',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Agent Smith One',
          linkedin_url: 'https://www.linkedin.com/in/agent-smith-1',
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
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'smith-senior',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Agent Smith Senior',
          linkedin_url: 'https://www.linkedin.com/in/agent-smith-senior',
        },
      },
    })

    const allSmiths = await Lead.find({})
    assert.equal(allSmiths.length, 3, 'Different profile slugs with common prefixes must remain 3 distinct leads')
    const names = allSmiths.map(l => l.name).sort()
    assert.deepEqual(names, ['Agent Smith', 'Agent Smith One', 'Agent Smith Senior'])
  })

  await t.test('8. Entity Safety: Personal profile vs company page must remain distinct', async () => {
    await initScanAndPage()

    // Lead with personal profile matching company slug
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'cyberdyne-person',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Cyberdyne Systems Admin',
          linkedin_url: 'https://www.linkedin.com/in/cyberdyne-systems',
        },
      },
    })

    // Another candidate with company URL
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'cyberdyne-company-cand',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Cyberdyne Corp Rep',
          linkedin_url: 'https://www.linkedin.com/company/cyberdyne-systems',
        },
      },
    })

    const allLeads = await Lead.find({})
    assert.equal(allLeads.length, 2, 'Personal profile /in/ and company page /company/ must NOT deduplicate together')
  })

  await t.test('9. Robustness: Invalid LinkedIn URLs do not cause false matches', async () => {
    await initScanAndPage()

    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'inv-1',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'User One',
          linkedin_url: 'https://google.com/in/johndoe',
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
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'inv-2',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'User Two',
          linkedin_url: 'not-a-valid-url',
        },
      },
    })

    const leads = await Lead.find({})
    assert.equal(leads.length, 2, 'Invalid URLs must not match each other or other leads')
  })

  await t.test('10. Tier Preservation & Non-Destructive Enrichment', async () => {
    await initScanAndPage()

    // Test Tier 2 (Email) when LinkedIn is absent
    await persistCandidate({
      CandidateRecordModel: CandidateRecord,
      ScanPageModel: ScanPage,
      LeadModel: Lead,
      PersonProfileModel: PersonProfile,
      CompanyProfileModel: CompanyProfile,
      ScanJobModel: ScanJob,
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'email-cand-1',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Marcus Wright',
          email: 'marcus@resistance.org',
          designation: 'Scout',
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
      scanJobId: scan._id,
      candidate: {
        candidateKey: 'email-cand-2',
        candidateType: 'person',
        sourceUrl: 'https://test-site.org/team',
        fields: {
          full_name: 'Marcus Wright',
          email: 'marcus@resistance.org',
          phone: '+1 555 7777', // Enrich missing phone
          linkedin_url: 'https://www.linkedin.com/in/marcus-wright', // Enrich missing LinkedIn
        },
      },
    })

    const leads = await Lead.find({ email: 'marcus@resistance.org' })
    assert.equal(leads.length, 1, 'Tier 2 (Email) must continue working seamlessly')
    assert.equal(leads[0].phone, '+1 555 7777', 'Missing phone must be enriched')
    assert.equal(leads[0].linkedinUrl, 'https://www.linkedin.com/in/marcus-wright', 'Missing LinkedIn URL enriched')
    assert.equal(leads[0].title, 'Scout', 'Original title preserved')
  })
})
