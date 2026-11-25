import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCandidates } from '../src/extraction/candidateExtractor.js'
import { persistCandidate } from '../src/services/candidatePersistence.js'

test('BUG 1 VERIFIED: False Person Candidate from Documentation Table is rejected', () => {
  const docHtml = `
    <html><body>
      <main>
        <h1>Accommodation</h1>
        <table>
          <tr><th>name</th><td>Text</td></tr>
          <tr><th>telephone</th><td>Text</td></tr>
          <tr><th>address</th><td>PostalAddress or Text</td></tr>
        </table>
      </main>
    </body></html>
  `
  const { candidates } = extractCandidates(docHtml, { sourceUrl: 'https://schema.org/Accommodation' })
  const person = candidates.find(c => c.candidateType === 'person')
  assert.equal(person, undefined, 'Person candidate named "Text" must NOT be extracted')
})

test('BUG 2 VERIFIED: Dummy phone inside <code> or <pre> code example is ignored', () => {
  const codeHtml = `
    <html><body>
      <main>
        <p>Documentation with example code:</p>
        <pre><code>{ "telephone": "+1-617-312-9783" }</code></pre>
        <p>Inline example: <code>+1-604-829-6070</code></p>
      </main>
    </body></html>
  `
  const { candidates } = extractCandidates(codeHtml, { sourceUrl: 'https://example.com/docs' })
  const phones = candidates.filter(c => c.fields.phone)
  assert.equal(phones.length, 0, 'Code snippet phones must NOT be extracted')
})

test('BUG 3 VERIFIED: Fax number is not misclassified as general voice phone', () => {
  const contactHtml = `
    <html><body>
      <main>
        <p>Telephone contacts: +1-424-254-5300 (phone) +1-424-254-5033 (facsimile)</p>
      </main>
    </body></html>
  `
  const { candidates } = extractCandidates(contactHtml, { sourceUrl: 'https://iana.org/contact' })
  const phones = candidates.filter(c => c.fields.phone)
  const faxAsPhone = phones.find(p => p.fields.phone.includes('5033'))
  assert.equal(faxAsPhone, undefined, 'Facsimile must NOT be extracted as voice phone')

  const faxes = candidates.filter(c => c.fields.fax)
  assert.ok(faxes.some(f => f.fields.fax.includes('5033')), 'Facsimile should be captured in fax field')
})

test('BUG 4 VERIFIED: Cross-page candidate merges records for the same scan', async () => {
  const records = new Map()
  const mockPageModel = {
    findOne: ({ normalizedUrl }) => ({
      select: async () => ({ _id: normalizedUrl.includes('page1') ? 'page-1-id' : 'page-2-id' })
    })
  }
  const mockCandidateModel = {
    findOne: async ({ scanJobId, candidateKey }) => records.get(`${scanJobId}|${candidateKey}`) || null,
    updateOne: async (filter, update, options) => {
      if (options?.upsert) {
        const key = `${filter.scanJobId}|${filter.candidateKey}`
        if (records.has(key)) return { upsertedCount: 0 }
        records.set(key, { _id: 'rec-1', ...update.$setOnInsert })
        return { upsertedCount: 1 }
      }
      return { modifiedCount: 1 }
    }
  }

  const candidatePage1 = {
    candidateKey: 'same-hash-123', candidateType: 'person',
    fields: { full_name: 'Alice Smith', email: 'alice@example.com', phone: null },
    provenance: [{ fieldName: 'email', value: 'alice@example.com', sourceUrl: 'https://example.com/page1', method: 'mailto' }],
    sourceUrl: 'https://example.com/page1', extractedAt: new Date(), parserVersion: 'deterministic-1'
  }
  const candidatePage2 = {
    candidateKey: 'same-hash-123', candidateType: 'person',
    fields: { full_name: 'Alice Smith', email: 'alice@example.com', phone: '+14155550199' },
    provenance: [{ fieldName: 'phone', value: '+14155550199', sourceUrl: 'https://example.com/page2', method: 'tel' }],
    sourceUrl: 'https://example.com/page2', extractedAt: new Date(), parserVersion: 'deterministic-1'
  }

  const first = await persistCandidate({ CandidateRecordModel: mockCandidateModel, ScanPageModel: mockPageModel, scanJobId: 'scan-1', candidate: candidatePage1 })
  const second = await persistCandidate({ CandidateRecordModel: mockCandidateModel, ScanPageModel: mockPageModel, scanJobId: 'scan-1', candidate: candidatePage2 })

  assert.equal(first, true, 'First write should insert')
  assert.equal(second, false, 'Second write should merge, not insert')
  assert.equal(records.size, 1, 'Exactly 1 record should exist for this scan')
})
