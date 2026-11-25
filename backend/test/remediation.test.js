import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCandidates } from '../src/extraction/candidateExtractor.js'
import { parseHtmlPage } from '../src/extraction/pageParser.js'
import { isValidPersonName, normalizePhone, normalizeFax, normalizeEmail } from '../src/extraction/normalization.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'

test('1. False-positive suppression: technical documentation tables do not create Person candidates', () => {
  const docHtml = `
    <html><body>
      <main>
        <h1>Accommodation Schema</h1>
        <table>
          <tr><th>name</th><td>Text The name of the item.</td></tr>
          <tr><th>telephone</th><td>Text The telephone number.</td></tr>
          <tr><th>address</th><td>PostalAddress or Text Physical address.</td></tr>
          <tr><th>email</th><td>Text Email address.</td></tr>
          <tr><th>booleanProperty</th><td>Boolean</td></tr>
          <tr><th>id</th><td>Integer</td></tr>
          <tr><th>url</th><td>URL</td></tr>
        </table>
      </main>
    </body></html>
  `
  const { candidates } = extractCandidates(docHtml, { sourceUrl: 'https://schema.org/Accommodation' })
  const people = candidates.filter(c => c.candidateType === 'person')
  assert.equal(people.length, 0, 'No false Person candidates should be extracted from property documentation tables')
})

test('2. False-positive suppression: isValidPersonName rejects types and placeholders while preserving real names', () => {
  const invalid = [
    'Text', 'String', 'Boolean', 'Integer', 'Number', 'Date', 'URL', 'PostalAddress',
    'Thing', 'Property', 'Enumeration', 'Array', 'Object', 'null', 'undefined',
    'Unknown', 'N/A', 'Not available', 'PostalAddress or Text', 'String or URL',
    '{user_name}', 'name: test', '12345', 'function()', 'Item 1'
  ]
  for (const token of invalid) {
    assert.equal(isValidPersonName(token), false, `Should reject invalid token: ${token}`)
  }

  const valid = [
    'Ada Lovelace', 'Grace Hopper', 'Katherine Johnson', 'Li Na', 'Jo Cox',
    'Jean-Luc Picard', 'Mary Jane Watson', 'Dr. John Smith', "Conan O'Brien"
  ]
  for (const name of valid) {
    assert.equal(isValidPersonName(name), true, `Should accept valid human name: ${name}`)
  }
})

test('3. Phone extraction: excludes code snippets, <pre>, <code>, <kbd>, <samp>', () => {
  const html = `
    <html><body>
      <main>
        <h1>API Documentation</h1>
        <p>Example request payload:</p>
        <pre><code>
          {
            "user": "Test User",
            "telephone": "+1-617-312-9783",
            "backupPhone": "+1-604-829-6070"
          }
        </code></pre>
        <p>Inline command: <code>call +1-800-555-0199</code></p>
        <kbd>dial +1-888-555-0122</kbd>
        <samp>Error contacting +1-877-555-0133</samp>
        <div class="contact-section">
          <h2>Official Support</h2>
          <p>Office phone: +1-415-555-0100</p>
          <a href="tel:+1-415-555-0101">Direct line</a>
        </div>
      </main>
    </body></html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/api-docs' })
  const allPhones = candidates.flatMap(c => [c.fields.phone, c.fields.phone_normalized].filter(Boolean))

  // Code snippet phones must NOT be extracted
  assert.equal(allPhones.some(p => p.includes('617-312-9783')), false, 'Pre/code phone +1-617-312-9783 must be ignored')
  assert.equal(allPhones.some(p => p.includes('604-829-6070')), false, 'Pre/code phone +1-604-829-6070 must be ignored')
  assert.equal(allPhones.some(p => p.includes('800-555-0199')), false, 'Inline code phone must be ignored')
  assert.equal(allPhones.some(p => p.includes('888-555-0122')), false, 'Kbd phone must be ignored')
  assert.equal(allPhones.some(p => p.includes('877-555-0133')), false, 'Samp phone must be ignored')

  // Real contact section phone MUST be extracted
  assert.ok(allPhones.some(p => p.includes('415-555-0100') || p.includes('415-555-0101')), 'Real contact phone should be extracted')
})

test('4. Fax vs Phone differentiation: separates fax from voice phone without context contamination', () => {
  const html = `
    <html><body>
      <main>
        <h1>IANA Contact</h1>
        <p>Telephone contacts: +1-424-254-5300 (phone) +1-424-254-5033 (facsimile)</p>
        <dl>
          <dt>Phone</dt>
          <dd>+1-310-555-0111</dd>
          <dt>Fax</dt>
          <dd>+1-310-555-0122</dd>
        </dl>
      </main>
    </body></html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://iana.org/contact' })

  // Find voice phones
  const voicePhones = candidates.map(c => c.fields.phone).filter(Boolean)
  assert.ok(voicePhones.includes('+1-424-254-5300'), 'Should extract voice phone +1-424-254-5300')
  assert.equal(voicePhones.includes('+1-424-254-5033'), false, 'Facsimile +1-424-254-5033 must NOT be classified as general phone')

  // Find faxes
  const faxes = candidates.map(c => c.fields.fax).filter(Boolean)
  assert.ok(faxes.some(f => f.includes('5033')), 'Facsimile +1-424-254-5033 should be captured in fax field')
  assert.ok(faxes.some(f => f.includes('0122')), 'Labeled fax +1-310-555-0122 should be captured in fax field')
})

test('5. Cross-page deduplication within the same scan: merges provenance and fields without duplicate records', async () => {
  const database = new Map()

  const mockPageModel = {
    findOne: ({ normalizedUrl }) => ({
      select: async () => ({ _id: normalizedUrl.includes('page1') ? 'page-1-objid' : 'page-2-objid' })
    })
  }

  const mockCandidateModel = {
    findOne: async ({ scanJobId, candidateKey }) => {
      return database.get(`${scanJobId}|${candidateKey}`) || null
    },
    updateOne: async (filter, update, options) => {
      if (options?.upsert) {
        const key = `${filter.scanJobId}|${filter.candidateKey}`
        if (database.has(key)) return { upsertedCount: 0 }
        const doc = { _id: 'doc-' + Math.random(), ...update.$setOnInsert }
        database.set(key, doc)
        return { upsertedCount: 1 }
      }
      // Update existing document
      const doc = [...database.values()].find(d => d._id === filter._id)
      if (doc && update.$set) {
        if (update.$set.provenance) doc.provenance = update.$set.provenance
        for (const [k, v] of Object.entries(update.$set)) {
          if (k.startsWith('fields.')) {
            const field = k.split('.')[1]
            doc.fields[field] = v
          }
        }
      }
      return { modifiedCount: 1 }
    }
  }

  const candidatePage1 = {
    candidateKey: 'hash-alice-smith',
    candidateType: 'person',
    fields: { full_name: 'Alice Smith', email: 'alice@example.com', phone: null },
    provenance: [{ fieldName: 'email', value: 'alice@example.com', sourceUrl: 'https://example.com/team/alice', method: 'mailto' }],
    sourceUrl: 'https://example.com/team/alice',
    extractedAt: new Date('2026-11-22T10:00:00Z'),
    parserVersion: 'deterministic-1'
  }

  const candidatePage2 = {
    candidateKey: 'hash-alice-smith',
    candidateType: 'person',
    fields: { full_name: 'Alice Smith', email: 'alice@example.com', phone: '+14155550199' },
    provenance: [{ fieldName: 'phone', value: '+14155550199', sourceUrl: 'https://example.com/contact', method: 'tel' }],
    sourceUrl: 'https://example.com/contact',
    extractedAt: new Date('2026-11-22T10:01:00Z'),
    parserVersion: 'deterministic-1'
  }

  // First page inserts
  const firstInserted = await persistCandidate({ CandidateRecordModel: mockCandidateModel, ScanPageModel: mockPageModel, scanJobId: 'scan-job-42', candidate: candidatePage1 })
  assert.equal(firstInserted, true, 'First encounter should insert new candidate record')

  // Second page encounters same candidate in same scan
  const secondInserted = await persistCandidate({ CandidateRecordModel: mockCandidateModel, ScanPageModel: mockPageModel, scanJobId: 'scan-job-42', candidate: candidatePage2 })
  assert.equal(secondInserted, false, 'Second encounter in same scan should merge, not insert a duplicate')

  // Verify only 1 record exists in database for this scan
  assert.equal(database.size, 1, 'Only 1 candidate record should exist in the scan')

  const stored = database.get('scan-job-42|hash-alice-smith')
  // Verified fields merged: phone populated from page 2, email preserved from page 1
  assert.equal(stored.fields.email, 'alice@example.com')
  assert.equal(stored.fields.phone, '+14155550199')

  // Provenance merged from both pages
  assert.equal(stored.provenance.length, 2)
  assert.ok(stored.provenance.some(p => p.fieldName === 'email' && p.sourceUrl.includes('team/alice')))
  assert.ok(stored.provenance.some(p => p.fieldName === 'phone' && p.sourceUrl.includes('contact')))

  // Verify a different scan job keeps its own isolated record
  const differentScanInserted = await persistCandidate({ CandidateRecordModel: mockCandidateModel, ScanPageModel: mockPageModel, scanJobId: 'scan-job-99', candidate: candidatePage1 })
  assert.equal(differentScanInserted, true, 'Different scan job must insert its own record independently')
  assert.equal(database.size, 2, 'Separate historical scan jobs remain isolated')
})

test('6. Traditional HTML extraction: Schema.org Microdata', () => {
  const html = `
    <html><body>
      <div itemscope itemtype="https://schema.org/Person">
        <span itemprop="name">Barbara Liskov</span>
        <span itemprop="jobTitle">Professor of Computer Science</span>
        <span itemprop="worksFor">MIT</span>
        <a itemprop="email" href="mailto:liskov@mit.edu">Email</a>
        <span itemprop="telephone">+1-617-555-0188</span>
        <a itemprop="sameAs" href="https://linkedin.com/in/barbara-liskov">LinkedIn</a>
      </div>
      <div itemscope itemtype="https://schema.org/Organization">
        <span itemprop="name">MIT Computer Science</span>
        <a itemprop="url" href="https://csail.mit.edu">Website</a>
      </div>
    </body></html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/faculty' })
  const person = candidates.find(c => c.candidateType === 'person')
  assert.ok(person, 'Should extract Person from Schema.org microdata')
  assert.equal(person.fields.full_name, 'Barbara Liskov')
  assert.equal(person.fields.designation, 'Professor of Computer Science')
  assert.equal(person.fields.company, 'MIT')
  assert.equal(person.fields.email, 'liskov@mit.edu')
  assert.equal(person.fields.phone, '+1-617-555-0188')
  assert.equal(person.fields.linkedin_url, 'https://linkedin.com/in/barbara-liskov')

  const org = candidates.find(c => c.candidateType === 'organization')
  assert.ok(org, 'Should extract Organization from Schema.org microdata')
  assert.equal(org.fields.company_name, 'MIT Computer Science')
  assert.equal(org.fields.website, 'https://csail.mit.edu/')
})

test('7. Traditional HTML extraction: Microformats2 h-card', () => {
  const html = `
    <html><body>
      <div class="h-card">
        <h2 class="p-name">Tim Berners-Lee</h2>
        <p class="p-job-title">Director</p>
        <p class="p-org">World Wide Web Consortium</p>
        <a class="u-email" href="mailto:timbl@w3.org">timbl@w3.org</a>
        <span class="p-tel">+1-617-555-0199</span>
      </div>
    </body></html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/bio' })
  const person = candidates.find(c => c.candidateType === 'person')
  assert.ok(person, 'Should extract Person from h-card')
  assert.equal(person.fields.full_name, 'Tim Berners-Lee')
  assert.equal(person.fields.designation, 'Director')
  assert.equal(person.fields.company, 'World Wide Web Consortium')
  assert.equal(person.fields.email, 'timbl@w3.org')
  assert.equal(person.fields.phone, '+1-617-555-0199')
})

test('8. Precision rule: article authors and directory tables without lead context yield no false candidates', () => {
  // quotes.toscrape.com style article
  const quoteHtml = `
    <html><body>
      <div class="quote">
        <span class="text">“The world as we have created it is a process of our thinking.”</span>
        <span>by <small class="author">Albert Einstein</small></span>
      </div>
      <div class="quote">
        <span class="text">“It is our choices, Harry, that show what we truly are.”</span>
        <span>by <small class="author">J.K. Rowling</small></span>
      </div>
    </body></html>
  `
  const quoteResult = extractCandidates(quoteHtml, { sourceUrl: 'https://quotes.toscrape.com/' })
  assert.equal(quoteResult.candidates.length, 0, 'Quote authors without contact/lead context should yield zero candidates')

  // scrapethissite.com style tabular directory without contact info
  const tableHtml = `
    <html><body>
      <table>
        <thead><tr><th>Country</th><th>Capital</th><th>Population</th></tr></thead>
        <tbody>
          <tr><td>Andorra</td><td>Andorra la Vella</td><td>84000</td></tr>
          <tr><td>United Arab Emirates</td><td>Abu Dhabi</td><td>4975593</td></tr>
        </tbody>
      </table>
    </body></html>
  `
  const tableResult = extractCandidates(tableHtml, { sourceUrl: 'https://scrapethissite.com/pages/simple/' })
  assert.equal(tableResult.candidates.length, 0, 'Country/directory tables should not be turned into candidates')
})
