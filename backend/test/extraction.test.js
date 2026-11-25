import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { BuiltInDiscoveryAdapter } from '../src/discovery/crawler.js'
import { parseHtmlPage } from '../src/extraction/pageParser.js'
import { extractCandidates } from '../src/extraction/candidateExtractor.js'
import { normalizeEmail, normalizePhone, normalizeHttpUrl, splitUnambiguousName } from '../src/extraction/normalization.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'

const personJsonLd = `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Person', name: ' Ada Lovelace ', jobTitle: 'Analyst',
  email: 'ADA@EXAMPLE.COM', telephone: '+1 (415) 555-0134', sameAs: ['https://www.linkedin.com/in/ada-lovelace'],
  worksFor: { '@type': 'Organization', name: 'Analytical Engines Ltd', url: 'https://engines.example/' },
  address: { '@type': 'PostalAddress', addressLocality: 'London', addressCountry: 'UK' },
})}</script>`

test('extracts JSON-LD Person fields with field-level provenance', () => {
  const { candidates } = extractCandidates(personJsonLd, { sourceUrl: 'https://example.com/team/ada', contentType: 'text/html' })
  const person = candidates.find(candidate => candidate.candidateType === 'person')
  assert.ok(person)
  assert.equal(person.fields.full_name, 'Ada Lovelace')
  assert.equal(person.fields.first_name, 'Ada')
  assert.equal(person.fields.last_name, 'Lovelace')
  assert.equal(person.fields.designation, 'Analyst')
  assert.equal(person.fields.company, 'Analytical Engines Ltd')
  assert.equal(person.fields.company_website, 'https://engines.example/')
  assert.equal(person.fields.email, 'ada@example.com')
  assert.equal(person.fields.email_original, 'ADA@EXAMPLE.COM')
  assert.equal(person.fields.phone, '+1 (415) 555-0134')
  assert.equal(person.fields.phone_normalized, '+14155550134')
  assert.equal(person.fields.linkedin_url, 'https://linkedin.com/in/ada-lovelace')
  assert.equal(person.fields.location, 'London, UK')
  assert.equal(person.fields.source_url, 'https://example.com/team/ada')
  assert.ok(person.provenance.some(item => item.fieldName === 'email' && item.method === 'json_ld' && item.sourceUrl === person.fields.source_url))
  assert.ok(person.provenance.every(item => item.ruleVersion && item.extractedAt && item.evidence.length <= 180))
})

test('extracts Schema.org Organization and LocalBusiness as distinct candidate classes', () => {
  const html = `<script type="application/ld+json">${JSON.stringify([
    { '@type': 'Organization', name: 'Example Foundation', url: 'https://foundation.example', email: 'info@foundation.example', telephone: '+442079460000', sameAs: ['https://www.linkedin.com/company/example-foundation'], address: { addressLocality: 'London' } },
    { '@type': 'LocalBusiness', name: 'Example Repairs', url: 'https://repairs.example', telephone: '+1 212 555 0100' },
  ])}</script>`
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://foundation.example/about' })
  const org = candidates.find(candidate => candidate.fields.company_name === 'Example Foundation')
  const company = candidates.find(candidate => candidate.fields.company_name === 'Example Repairs')
  assert.equal(org.candidateType, 'organization')
  assert.equal(org.fields.website, 'https://foundation.example/')
  assert.equal(org.fields.email, 'info@foundation.example')
  assert.equal(org.fields.linkedin_url, 'https://linkedin.com/company/example-foundation')
  assert.equal(company.candidateType, 'company')
})

test('parses multiple JSON-LD blocks and nested @graph entities without promoting an article author by name alone', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@graph': [
    { '@type': 'WebPage', name: 'Team' },
    { '@type': 'Person', name: 'Grace Hopper' },
    { '@type': 'Person', name: 'Grace Hopper', jobTitle: 'Engineer', email: 'grace@example.org' },
  ] })}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'Article', author: { '@type': 'Person', name: 'Blog Author' } })}</script>`
  const parsed = parseHtmlPage(html, { sourceUrl: 'https://example.org/team' })
  assert.ok(parsed.entities.some(entity => entity.schemaType === 'Person'))
  const persons = extractCandidates(html, { sourceUrl: 'https://example.org/team' }).candidates.filter(item => item.candidateType === 'person')
  assert.equal(persons.length, 1)
  assert.equal(persons[0].fields.full_name, 'Grace Hopper')
})

test('extracts explicit mailto, tel, visible email and context-labeled phone contacts', () => {
  const html = '<main><h1>Contact</h1><a href="mailto:Sales@Example.com?subject=hello">Email sales</a><a href="tel:+1-415-555-0100">Call us</a><p>Public email: support@example.com</p><p>Office phone: +44 20 7946 0123</p></main>'
  const { parsed, candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/contact' })
  assert.ok(parsed.contacts.emails.some(item => item.method === 'mailto'))
  assert.ok(parsed.contacts.emails.some(item => item.value === 'support@example.com' && item.method === 'pattern_match'))
  assert.ok(parsed.contacts.phones.some(item => item.method === 'tel'))
  assert.ok(parsed.contacts.phones.some(item => item.value.includes('+44 20 7946 0123') && item.method === 'pattern_match'))
  assert.ok(candidates.some(item => item.candidateType === 'unknown' && item.fields.email === 'sales@example.com'))
  assert.ok(candidates.some(item => item.candidateType === 'unknown' && item.fields.phone === '+1-415-555-0100'))
})

test('parses page metadata, profile metadata, headings, and explicit semantic labels', () => {
  const html = `<html><head><title>Our Team</title><meta name="description" content="Team page"><meta property="og:title" content="Team"><meta property="og:description" content="People"><meta property="og:url" content="https://example.com/team#top"><meta property="og:type" content="profile"><meta property="profile:first_name" content="Katherine"><meta property="profile:last_name" content="Johnson"><link rel="canonical" href="/team"></head><body><main><h1>Team</h1><p><strong>Name:</strong> Katherine Johnson</p><p><strong>Job Title:</strong> Mathematician</p><a href="mailto:katherine@example.com">Email</a></main></body></html>`
  const result = extractCandidates(html, { sourceUrl: 'https://example.com/team', contentType: 'text/html' })
  assert.equal(result.parsed.page.title, 'Our Team')
  assert.equal(result.parsed.page.meta_description, 'Team page')
  assert.equal(result.parsed.page.canonical_url, 'https://example.com/team')
  assert.equal(result.parsed.page.og_url, 'https://example.com/team')
  assert.deepEqual(result.parsed.headings, ['Team'])
  const person = result.candidates.find(item => item.candidateType === 'person')
  assert.equal(person.fields.full_name, 'Katherine Johnson')
  assert.equal(person.fields.designation, 'Mathematician')
})

test('missing fields remain null and names/phones are normalized conservatively', () => {
  const { candidates } = extractCandidates('<script type="application/ld+json">{"@type":"Person","name":"Mary Jane Watson"}</script>', { sourceUrl: 'https://example.com/person' })
  assert.equal(candidates.some(item => item.candidateType === 'person'), false, 'a name-only Person is not a lead candidate')
  assert.deepEqual(splitUnambiguousName('Mary Jane Watson'), { full_name: 'Mary Jane Watson', first_name: null, last_name: null })
  assert.deepEqual(normalizeEmail(' Not An Email '), { value: null, original: 'Not An Email', validationStatus: 'invalid' })
  assert.deepEqual(normalizePhone('020 7946 0958'), { value: '020 7946 0958', normalized: null, original: '020 7946 0958', validationStatus: 'unverified' })
  assert.equal(normalizeHttpUrl('javascript:alert(1)', 'https://example.com'), null)
})

test('malformed HTML and malformed JSON-LD do not crash parsing or extraction', () => {
  const result = extractCandidates('<html><body><h1>Contact</h1><script type="application/ld+json">{broken</script><a href="mailto:hi@example.com">Email</a>', { sourceUrl: 'https://example.com/contact' })
  assert.equal(result.parsed.page.title, null)
  assert.equal(result.candidates.some(item => item.fields.email === 'hi@example.com'), true)
})

test('navigation, footer, testimonials, comments, and generic author names do not become people', () => {
  const html = '<nav><strong>Name:</strong> Nav Person <a href="mailto:nav@example.com">Email</a></nav><main><h1>Customer stories</h1><blockquote><strong>Name:</strong> Testimonial Person <a href="mailto:quote@example.com">Email</a></blockquote><div class="comments"><strong>Name:</strong> Comment Person</div><p>Written by Alex Example.</p></main><footer><a href="mailto:footer@example.com">Footer</a></footer>'
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/article' })
  assert.equal(candidates.some(item => item.candidateType === 'person'), false)
  assert.equal(candidates.some(item => item.fields.email === 'nav@example.com' || item.fields.email === 'quote@example.com' || item.fields.email === 'footer@example.com'), false)
})

test('deduplicates repeated emails, LinkedIn URLs and structured entities within one page', () => {
  const html = `${personJsonLd}${personJsonLd}<main><a href="mailto:ada@example.com">Ada</a><a href="https://linkedin.com/in/ada-lovelace">LinkedIn</a><a href="https://www.linkedin.com/in/ada-lovelace#profile">Profile</a></main>`
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/team/ada' })
  assert.equal(candidates.filter(item => item.candidateType === 'person').length, 1)
  assert.equal(candidates.filter(item => item.fields.email === 'ada@example.com').length, 1)
  assert.equal(candidates.filter(item => item.candidateType === 'unknown' && item.fields.linkedin_url === 'https://linkedin.com/in/ada-lovelace').length, 0, 'known LinkedIn contact is merged into the person record')
})

test('candidate persistence is idempotent and uses insert-only writes', async () => {
  const records = new Map()
  const pageModel = { findOne: () => ({ select: async () => ({ _id: 'page-1' }) }) }
  const candidateModel = { updateOne: async (filter, update) => {
    const key = `${filter.scanJobId}|${filter.pageId}|${filter.candidateKey}`
    if (records.has(key)) return { upsertedCount: 0 }
    records.set(key, update.$setOnInsert)
    return { upsertedCount: 1 }
  } }
  const candidate = { candidateKey: 'hash', candidateType: 'person', fields: { full_name: 'Verified Name' }, provenance: [], sourceUrl: 'https://example.com/p', extractedAt: new Date(), parserVersion: 'deterministic-1', extractionStatus: 'candidate', validationStatus: 'needs_review' }
  assert.equal(await persistCandidate({ CandidateRecordModel: candidateModel, ScanPageModel: pageModel, scanJobId: 'scan-1', candidate }), true)
  assert.equal(await persistCandidate({ CandidateRecordModel: candidateModel, ScanPageModel: pageModel, scanJobId: 'scan-1', candidate: { ...candidate, fields: { full_name: 'Weaker Replacement' } } }), false)
  assert.equal(records.size, 1)
  assert.equal([...records.values()][0].fields.full_name, 'Verified Name')
})

async function fixtureSite(handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('extraction persistence failure is isolated and successful page fetch remains successful', async () => {
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') { res.setHeader('content-type', 'text/plain'); return res.end('User-agent: *\n') }
    res.setHeader('content-type', 'text/html'); res.end(personJsonLd)
  })
  try {
    const metrics = {}, logs = [], pages = []
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.url, options: { allowLocalFixtures: true, maxPages: 2, maxDepth: 0, concurrency: 1, requestDelay: 0, requestTimeoutMs: 1000, sitemapDiscovery: false, internalLinkCrawling: true, feedDiscovery: false },
      signal: new AbortController().signal, onStage: async () => {}, onLog: async value => logs.push(value), onPage: async page => pages.push(page),
      onMetrics: async patch => { for (const key of Object.keys(patch)) metrics[key] = (metrics[key] || 0) + (typeof patch[key] === 'number' ? patch[key] : 0) },
      onCandidate: async () => { throw new Error('database unavailable') },
    })
    assert.equal(pages.filter(page => page.url === `${site.url}/`).at(-1).processingStatus, 'fetched')
    assert.equal(metrics.pagesFetched, 1)
    assert.equal(metrics.extractionPagesProcessed, 1)
    assert.equal(metrics.extractionErrors, 2, 'person and organization persistence errors are counted separately')
    assert.equal(logs.some(line => line.includes('database unavailable')), false)
  } finally { await site.close() }
})
