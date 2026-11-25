import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Lead, CompanyProfile, ScanJob, ScanPage, CandidateRecord } from '../src/models/index.js'
import { generateCsv } from '../src/utils/csv.js'
import { BuiltInDiscoveryAdapter, isTransientError } from '../src/discovery/crawler.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

async function fixtureSite(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_export_scan_reliability_test'

test('LeadIntel Stage 4: Export & Scan Reliability Test Suite', async (t) => {
  const apiPort = await freePort()
  let apiServer

  await mongoose.connect(TEST_DB_URI)

  await Promise.all([
    ScanJob.deleteMany({}),
    ScanPage.deleteMany({}),
    CandidateRecord.deleteMany({}),
    Lead.deleteMany({}),
    CompanyProfile.deleteMany({}),
  ])

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
    } catch {
      // retry
    }
  }
  assert.ok(healthy, 'Backend server must boot and connect to MongoDB')

  t.after(async () => {
    if (apiServer) {
      apiServer.kill('SIGTERM')
      await wait(100)
    }
    await Promise.all([
      ScanJob.deleteMany({}),
      ScanPage.deleteMany({}),
      CandidateRecord.deleteMany({}),
      Lead.deleteMany({}),
      CompanyProfile.deleteMany({}),
    ])
    await mongoose.disconnect()
  })

  // ========================================================
  // PART A: LEAD EXPORT TESTS
  // ========================================================

  await t.test('Part A1: CSV Export has exact 12 columns with expected headers', async () => {
    await Lead.deleteMany({})

    const testLead = await Lead.create({
      name: 'Dr. Sarah Connor',
      title: 'Chief Technology Officer',
      company: 'Cyberdyne Systems',
      email: 'sconnor@cyberdyne.test',
      phone: '+1 555-0199',
      linkedinUrl: 'https://linkedin.com/in/sarah-connor',
      status: 'qualified',
      sourceUrl: 'https://cyberdyne.test/team/sconnor',
      biography: 'Experienced engineering leader focusing on autonomous systems.',
      notes: 'Met at AI conference.',
      discoveredAt: new Date('2026-05-15T10:30:00.000Z'),
    })

    const res = await fetch(`${base}/leads/export`)
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').includes('text/csv'))
    assert.ok(res.headers.get('content-disposition').includes('attachment; filename="leadintel-leads-'))

    const text = await res.text()
    const lines = text.trim().split('\r\n')
    assert.ok(lines.length >= 2, 'CSV must contain at least header and one data row')

    // Verify exact 12 columns
    const expectedHeaders = 'Full Name,Designation,Company,Email,Phone,LinkedIn,Lead Status,Source Website,Profile URL,Date Discovered,Biography,Notes'
    assert.equal(lines[0], expectedHeaders, 'CSV header must exactly match the 12 required fields')

    // Verify row contents
    assert.ok(lines[1].includes('Dr. Sarah Connor'))
    assert.ok(lines[1].includes('Chief Technology Officer'))
    assert.ok(lines[1].includes('Cyberdyne Systems'))
    assert.ok(lines[1].includes('sconnor@cyberdyne.test'))
    assert.ok(lines[1].includes('https://linkedin.com/in/sarah-connor'))
    assert.ok(lines[1].includes('qualified'))
    assert.ok(lines[1].includes('https://cyberdyne.test')) // derived sourceWebsite origin
    assert.ok(lines[1].includes('https://cyberdyne.test/team/sconnor'))
    assert.ok(lines[1].includes('2026-05-15T10:30:00.000Z'))
    assert.ok(lines[1].includes('Experienced engineering leader'))
    assert.ok(lines[1].includes('Met at AI conference.'))
  })

  await t.test('Part A2: CSV Export respects search, status, and company filters', async () => {
    await Lead.deleteMany({})
    const compA = await CompanyProfile.create({ name: 'Alpha Corp', website: 'https://alphacorp.test' })
    const compB = await CompanyProfile.create({ name: 'Beta Ltd', website: 'https://betaltd.test' })

    const lead1 = await Lead.create({
      name: 'Alice Cooper',
      title: 'DevOps Lead',
      company: compA.name,
      companyId: compA._id,
      email: 'alice@alphacorp.test',
      status: 'new',
    })
    const lead2 = await Lead.create({
      name: 'Bob Cooper',
      title: 'Security Architect',
      company: compB.name,
      companyId: compB._id,
      email: 'bob@betaltd.test',
      status: 'contacted',
    })
    const lead3 = await Lead.create({
      name: 'Charlie Davis',
      title: 'Product Manager',
      company: compA.name,
      companyId: compA._id,
      email: 'charlie@alphacorp.test',
      status: 'qualified',
    })

    // 1. Filter by search query 'Cooper' -> lead1 and lead2
    const resSearch = await fetch(`${base}/leads/export?q=Cooper`)
    const csvSearch = await resSearch.text()
    assert.ok(csvSearch.includes('Alice Cooper'))
    assert.ok(csvSearch.includes('Bob Cooper'))
    assert.ok(!csvSearch.includes('Charlie Davis'))

    // 2. Filter by status 'qualified' -> lead3 only
    const resStatus = await fetch(`${base}/leads/export?status=qualified`)
    const csvStatus = await resStatus.text()
    assert.ok(!csvStatus.includes('Alice Cooper'))
    assert.ok(!csvStatus.includes('Bob Cooper'))
    assert.ok(csvStatus.includes('Charlie Davis'))

    // 3. Filter by companyId compA -> lead1 and lead3
    const resComp = await fetch(`${base}/leads/export?companyId=${compA._id}`)
    const csvComp = await resComp.text()
    assert.ok(csvComp.includes('Alice Cooper'))
    assert.ok(csvComp.includes('Charlie Davis'))
    assert.ok(!csvComp.includes('Bob Cooper'))
  })

  await t.test('Part A3: CSV Export supports selected leads (GET and POST)', async () => {
    await Lead.deleteMany({})

    const l1 = await Lead.create({ name: 'Lead One', email: 'l1@test.org', status: 'new' })
    const l2 = await Lead.create({ name: 'Lead Two', email: 'l2@test.org', status: 'new' })
    const l3 = await Lead.create({ name: 'Lead Three', email: 'l3@test.org', status: 'new' })

    // GET with comma-separated ids
    const resGet = await fetch(`${base}/leads/export?ids=${l1._id},${l3._id}`)
    assert.equal(resGet.status, 200)
    const csvGet = await resGet.text()
    assert.ok(csvGet.includes('Lead One'))
    assert.ok(csvGet.includes('Lead Three'))
    assert.ok(!csvGet.includes('Lead Two'), 'Lead Two was not selected and must not appear')

    // POST with body array of ids
    const resPost = await fetch(`${base}/leads/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [l2._id.toString()] }),
    })
    assert.equal(resPost.status, 200)
    const csvPost = await resPost.text()
    assert.ok(csvPost.includes('Lead Two'))
    assert.ok(!csvPost.includes('Lead One'))
    assert.ok(!csvPost.includes('Lead Three'))
  })

  await t.test('Part A4: Data quality, RFC-4180 escaping, and formula injection protection', async () => {
    await Lead.deleteMany({})

    // Record with commas, quotes, newlines, empty fields, and formula injection strings
    await Lead.create({
      name: '=cmd|\' /C calc\'!A0',
      title: '+SUM(1,2)',
      company: '@Acme, "Special" Inc.',
      email: '-danger@test.org',
      phone: '', // empty field
      biography: 'Line 1\nLine 2 with, commas and "quotes"',
      notes: '\tTabbed Note',
    })

    const res = await fetch(`${base}/leads/export`)
    const csv = await res.text()
    const lines = csv.split('\r\n')

    // Check formula injection neutralization (prepended with ')
    assert.ok(csv.includes("'=cmd|"), 'Leading = must be prepended with single quote')
    assert.ok(csv.includes("'+SUM(1,2)"), 'Leading + must be prepended with single quote')
    assert.ok(csv.includes("'-danger@test.org"), 'Leading - must be prepended with single quote')
    assert.ok(csv.includes("'\tTabbed Note"), 'Leading tab must be prepended with single quote')

    // Check RFC-4180 escaping: quotes doubled, wrapped in quotes
    assert.ok(csv.includes('""Special""'), 'Inner double quotes must be doubled')
    assert.ok(csv.includes('"Line 1\nLine 2 with, commas and ""quotes"""'), 'Multi-line with commas must be wrapped')
  })

  // ========================================================
  // PART B: SCAN RELIABILITY TESTS
  // ========================================================

  await t.test('Part B1: isTransientError correctly distinguishes transient vs permanent failures', () => {
    // Transient errors
    assert.equal(isTransientError(Object.assign(new Error('HTTP 500'), { httpStatus: 500 })), true)
    assert.equal(isTransientError(Object.assign(new Error('HTTP 502'), { httpStatus: 502 })), true)
    assert.equal(isTransientError(Object.assign(new Error('HTTP 503'), { httpStatus: 503 })), true)
    assert.equal(isTransientError(Object.assign(new Error('HTTP 504'), { httpStatus: 504 })), true)
    assert.equal(isTransientError(Object.assign(new Error('HTTP 429'), { httpStatus: 429 })), true)
    assert.equal(isTransientError(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })), true)
    assert.equal(isTransientError(Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })), true)
    assert.equal(isTransientError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true)
    assert.equal(isTransientError(Object.assign(new Error('Fetch timed out'), { name: 'TimeoutError' })), true)

    // Permanent errors - MUST NOT BE RETRIED
    assert.equal(isTransientError(Object.assign(new Error('HTTP 404'), { httpStatus: 404 })), false)
    assert.equal(isTransientError(Object.assign(new Error('HTTP 401'), { httpStatus: 401 })), false)
    assert.equal(isTransientError(Object.assign(new Error('HTTP 403'), { httpStatus: 403 })), false)
    assert.equal(isTransientError(Object.assign(new Error('HTTP 400'), { httpStatus: 400 })), false)
    assert.equal(isTransientError(Object.assign(new Error('HTTP 410'), { httpStatus: 410 })), false)
    assert.equal(isTransientError(Object.assign(new Error('Exceeded limit'), { name: 'ResponseLimitError' })), false)
    assert.equal(isTransientError(Object.assign(new Error('SSRF blocked'), { name: 'SecurityError' })), false)
    assert.equal(isTransientError(Object.assign(new Error('Aborted'), { name: 'AbortError' })), false)
  })

  await t.test('Part B2: Transient HTTP 500 error is retried and succeeds on second attempt', async () => {
    let requests = 0
    const site = await fixtureSite((req, res) => {
      requests++
      if (req.url === '/robots.txt') {
        res.setHeader('content-type', 'text/plain')
        return res.end('User-agent: *\nDisallow:')
      }
      if (req.url === '/') {
        if (requests === 2) {
          // First attempt at homepage fails with 500
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain')
          return res.end('Internal Server Error')
        }
        // Second attempt succeeds with candidate HTML
        res.setHeader('content-type', 'text/html')
        return res.end(`
          <html><body>
            <table>
              <tr><th>Name</th><th>Role</th></tr>
              <tr><td>Dr. Evelyn Reed</td><td>Principal Investigator</td></tr>
            </table>
          </body></html>
        `)
      }
      res.statusCode = 404
      res.end()
    })

    const candidates = []
    const pages = []
    const logs = []

    try {
      await new BuiltInDiscoveryAdapter().discover({
        siteUrl: site.origin,
        options: {
          maxPages: 3,
          maxDepth: 1,
          concurrency: 1,
          requestDelay: 0,
          requestTimeoutMs: 1500,
          allowLocalFixtures: true,
          maxPageRetries: 2,
          internalLinkCrawling: true,
          feedDiscovery: false,
          sitemapDiscovery: false,
        },
        signal: new AbortController().signal,
        onPage: async p => pages.push(p),
        onCandidate: async c => { candidates.push(c); return true },
        onLog: async m => logs.push(m),
        onMetrics: async () => {},
        onStage: async () => {},
      })

      assert.ok(requests >= 3, `Expected at least 3 requests (robots + failed attempt 1 + retry attempt 2), got ${requests}`)
      assert.ok(logs.some(l => l.includes('Retrying transient error')), 'Must log retry attempt')
      assert.ok(candidates.some(c => c.fields?.full_name === 'Dr. Evelyn Reed'), 'Candidate must be extracted after successful retry')
    } finally {
      await site.close()
    }
  })

  await t.test('Part B3: Permanent HTTP 404 error is NOT retried and crawl continues', async () => {
    let missingRequests = 0
    const site = await fixtureSite((req, res) => {
      if (req.url === '/robots.txt') {
        res.setHeader('content-type', 'text/plain')
        return res.end('User-agent: *\nDisallow:')
      }
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html')
        return res.end(`
          <html><body>
            <a href="/missing-page">Missing</a>
            <a href="/valid-page">Valid</a>
          </body></html>
        `)
      }
      if (req.url === '/missing-page') {
        missingRequests++
        res.statusCode = 404
        return res.end('Not Found')
      }
      if (req.url === '/valid-page') {
        res.setHeader('content-type', 'text/html')
        return res.end(`
          <html><body>
            <table>
              <tr><th>Name</th><th>Role</th></tr>
              <tr><td>Grace Hopper</td><td>Admiral</td></tr>
            </table>
          </body></html>
        `)
      }
      res.statusCode = 404
      res.end()
    })

    const pages = []
    const candidates = []
    try {
      await new BuiltInDiscoveryAdapter().discover({
        siteUrl: site.origin,
        options: {
          maxPages: 5,
          maxDepth: 2,
          concurrency: 1,
          requestDelay: 0,
          requestTimeoutMs: 1500,
          allowLocalFixtures: true,
          maxPageRetries: 2,
          internalLinkCrawling: true,
          feedDiscovery: false,
          sitemapDiscovery: false,
        },
        signal: new AbortController().signal,
        onPage: async p => pages.push(p),
        onCandidate: async c => { candidates.push(c); return true },
        onLog: async () => {},
        onMetrics: async () => {},
        onStage: async () => {},
      })

      // 404 must NOT be retried: missingRequests for /missing-page must be exactly 1
      assert.equal(missingRequests, 1, '404 permanent failure must be attempted exactly once (never retried)')

      // Valid page must still be crawled and candidate extracted
      assert.ok(candidates.some(c => c.fields?.full_name === 'Grace Hopper'), 'Crawl must continue past 404 and extract candidates from valid pages')
    } finally {
      await site.close()
    }
  })

  await t.test('Part B4: Non-HTML page is gracefully skipped without terminating scan', async () => {
    const site = await fixtureSite((req, res) => {
      if (req.url === '/robots.txt') {
        res.setHeader('content-type', 'text/plain')
        return res.end('User-agent: *\nDisallow:')
      }
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html')
        return res.end(`
          <html><body>
            <a href="/download-doc">Download PDF</a>
            <a href="/team">Our Team</a>
          </body></html>
        `)
      }
      if (req.url === '/download-doc') {
        res.setHeader('content-type', 'application/pdf')
        return res.end('%PDF-1.4 binary content...')
      }
      if (req.url === '/team') {
        res.setHeader('content-type', 'text/html')
        return res.end(`
          <html><body>
            <table>
              <tr><th>Name</th><th>Role</th></tr>
              <tr><td>Margaret Hamilton</td><td>Software Director</td></tr>
            </table>
          </body></html>
        `)
      }
      res.statusCode = 404
      res.end()
    })

    const pages = []
    const candidates = []
    const logs = []
    try {
      await new BuiltInDiscoveryAdapter().discover({
        siteUrl: site.origin,
        options: {
          maxPages: 5,
          maxDepth: 2,
          concurrency: 1,
          requestDelay: 0,
          requestTimeoutMs: 1500,
          allowLocalFixtures: true,
          internalLinkCrawling: true,
          feedDiscovery: false,
          sitemapDiscovery: false,
        },
        signal: new AbortController().signal,
        onPage: async p => pages.push(p),
        onCandidate: async c => { candidates.push(c); return true },
        onLog: async m => logs.push(m),
        onMetrics: async () => {},
        onStage: async () => {},
      })

      assert.ok(logs.some(l => l.includes('Skipped non-HTML response (application/pdf)')), 'Must log skipped non-HTML response')
      assert.ok(candidates.some(c => c.fields?.full_name === 'Margaret Hamilton'), 'Must continue crawl and find team members on HTML pages')
    } finally {
      await site.close()
    }
  })

  await t.test('Part B5: Extraction or persistence errors on individual pages do not abort scan', async () => {
    const site = await fixtureSite((req, res) => {
      if (req.url === '/robots.txt') {
        res.setHeader('content-type', 'text/plain')
        return res.end('User-agent: *\nDisallow:')
      }
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html')
        return res.end(`
          <html><body>
            <a href="/page-fail">Page Fail</a>
            <a href="/page-pass">Page Pass</a>
          </body></html>
        `)
      }
      if (req.url === '/page-fail') {
        res.setHeader('content-type', 'text/html')
        return res.end(`
          <html><body>
            <table>
              <tr><th>Name</th><th>Role</th></tr>
              <tr><td>Fail Person</td><td>Engineer</td></tr>
            </table>
          </body></html>
        `)
      }
      if (req.url === '/page-pass') {
        res.setHeader('content-type', 'text/html')
        return res.end(`
          <html><body>
            <table>
              <tr><th>Name</th><th>Role</th></tr>
              <tr><td>Pass Person</td><td>Scientist</td></tr>
            </table>
          </body></html>
        `)
      }
      res.statusCode = 404
      res.end()
    })

    const savedCandidates = []
    try {
      await new BuiltInDiscoveryAdapter().discover({
        siteUrl: site.origin,
        options: {
          maxPages: 5,
          maxDepth: 2,
          concurrency: 1,
          requestDelay: 0,
          requestTimeoutMs: 1500,
          allowLocalFixtures: true,
          internalLinkCrawling: true,
          feedDiscovery: false,
          sitemapDiscovery: false,
        },
        signal: new AbortController().signal,
        onPage: async () => {},
        onCandidate: async c => {
          if (c.fields?.full_name === 'Fail Person') {
            throw new Error('Database write error simulating disk corruption')
          }
          savedCandidates.push(c)
          return true
        },
        onLog: async () => {},
        onMetrics: async () => {},
        onStage: async () => {},
      })

      assert.ok(savedCandidates.some(c => c.fields?.full_name === 'Pass Person'), 'Scan must survive individual candidate persistence errors and extract subsequent candidates')
    } finally {
      await site.close()
    }
  })

  await t.test('Part B6: Cancellation aborts workers promptly and preserves partial results', async () => {
    const controller = new AbortController()
    let crawledPages = 0

    const names = ['Ada Lovelace', 'Charles Babbage', 'Alan Turing']

    const site = await fixtureSite(async (req, res) => {
      if (req.url === '/robots.txt') {
        res.setHeader('content-type', 'text/plain')
        return res.end('User-agent: *\nDisallow:')
      }
      crawledPages++
      if (crawledPages >= 2) {
        // Trigger cancellation midway through crawl
        controller.abort()
      }
      const personName = names[crawledPages - 1] || 'Katherine Johnson'
      res.setHeader('content-type', 'text/html')
      res.end(`
        <html><body>
          <table>
            <tr><th>Name</th><th>Role</th></tr>
            <tr><td>${personName}</td><td>Researcher</td></tr>
          </table>
          <a href="/page-${crawledPages + 1}">Next Page</a>
        </body></html>
      `)
    })

    const savedCandidates = []
    try {
      await new BuiltInDiscoveryAdapter().discover({
        siteUrl: site.origin,
        options: {
          maxPages: 20,
          maxDepth: 10,
          concurrency: 1,
          requestDelay: 0,
          requestTimeoutMs: 1500,
          allowLocalFixtures: true,
          internalLinkCrawling: true,
          feedDiscovery: false,
          sitemapDiscovery: false,
        },
        signal: controller.signal,
        onPage: async () => {},
        onCandidate: async c => {
          savedCandidates.push(c)
          return true
        },
        onLog: async () => {},
        onMetrics: async () => {},
        onStage: async () => {},
      })
    } catch {
      // Abort may throw or return cleanly
    } finally {
      await site.close()
    }

    assert.ok(controller.signal.aborted, 'Signal should be aborted')
    assert.ok(savedCandidates.length > 0, 'Partial candidate results discovered before abort must be preserved')
    assert.ok(savedCandidates.some(c => c.fields?.full_name === 'Ada Lovelace'), 'Ada Lovelace discovered on page 1 must be preserved')
    assert.ok(crawledPages < 10, `Crawl should have halted well before reaching maxPages (stopped at ${crawledPages})`)
  })
})
