import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { generateCsv } from '../src/utils/csv.js'
import { Lead, CompanyProfile, ScanJob } from '../src/models/index.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port
    socket.close(() => resolve(port))
  })
})

const CSV_TEST_DB_URI = 'mongodb://127.0.0.1:27017/leadintel_csv_security_test'

test('CSV Formula Injection Protection (DEF-001 / CWE-1236) Test Suite', async (t) => {
  const columns = [
    { key: 'name', label: 'Full Name' },
    { key: 'title', label: 'Job Title' },
    { key: 'company', label: 'Company' },
    { key: 'email', label: 'Email' },
    { key: 'notes', label: 'Notes' },
  ]

  // ========================================================
  // UNIT TESTS: generateCsv utility
  // ========================================================

  await t.test('1. Neutralizes dangerous leading "=" formula character', () => {
    const records = [
      { name: '=1+1', title: '=cmd|\' /C calc\'!A0', company: '=HYPERLINK("http://evil.com","Click")' },
    ]
    const csv = generateCsv(columns, records)
    const lines = csv.split('\r\n')
    assert.equal(lines.length, 2)

    // Name has no commas/quotes: neutralized with leading single quote
    assert.ok(lines[1].includes("'=1+1"), 'Leading = must be prepended with single quote')
    assert.ok(lines[1].includes("'=cmd"), 'Command execution payload must be prepended with single quote')
    // HYPERLINK contains quotes and commas: must be prepended with single quote AND escaped per RFC-4180
    assert.ok(lines[1].includes('"\'=HYPERLINK(""http://evil.com"",""Click"")"'), 'Quotes must be doubled and cell wrapped')
  })

  await t.test('2. Neutralizes dangerous leading "+" formula character', () => {
    const records = [
      { name: '+SUM(1,2)', title: '+12345', company: '+cmd|calc!A0' },
    ]
    const csv = generateCsv(columns, records)
    // +SUM(1,2) has a comma, so RFC-4180 wraps it: "'+SUM(1,2)"
    assert.ok(csv.includes('"\'+SUM(1,2)"'), 'Formula with comma must be quoted with prepended single quote')
    assert.ok(csv.includes("'+12345"), 'Phone-like or numeric plus must be prepended with single quote')
    assert.ok(csv.includes("'+cmd|calc!A0"))
  })

  await t.test('3. Neutralizes dangerous leading "-" formula character', () => {
    const records = [
      { name: '-1+2', title: '-2+3+cmd', company: '-SUM(A1:A10)' },
    ]
    const csv = generateCsv(columns, records)
    assert.ok(csv.includes("'-1+2"))
    assert.ok(csv.includes("'-2+3+cmd"))
    assert.ok(csv.includes("'-SUM(A1:A10)"))
  })

  await t.test('4. Neutralizes dangerous leading "@" formula character', () => {
    const records = [
      { name: '@SUM(A1:A10)', title: '@username', company: '@BIN2HEX(100)' },
    ]
    const csv = generateCsv(columns, records)
    assert.ok(csv.includes("'@SUM(A1:A10)"))
    assert.ok(csv.includes("'@username"))
    assert.ok(csv.includes("'@BIN2HEX(100)"))
  })

  await t.test('5. Neutralizes dangerous leading Tab (\\t) character and Tab-prefixed formulas', () => {
    const records = [
      { name: '\t=1+1', title: '\t+SUM(1,2)', company: '\t', notes: '\t@evil' },
    ]
    const csv = generateCsv(columns, records)
    // Leading tab must be prepended with single quote
    assert.ok(csv.includes("'\t=1+1"), 'Tab-prefixed formula must start with single quote')
    assert.ok(csv.includes('"\'\t+SUM(1,2)"'), 'Tab formula with comma must be quoted with single quote')
    assert.ok(csv.includes("'\t"), 'Bare leading tab must be protected')
    assert.ok(csv.includes("'\t@evil"))
  })

  await t.test('6. Neutralizes dangerous leading Carriage Return (\\r) and CR-prefixed formulas', () => {
    const records = [
      { name: '\r=1+1', title: '\r\n=2+2', company: '\r-cmd', notes: '\r@SUM(1)' },
    ]
    const csv = generateCsv(columns, records)
    // Because values contain \r and \n, standard RFC-4180 escaping wraps them in quotes
    assert.ok(csv.includes('"\'\r=1+1"'), 'CR-prefixed formula must be wrapped in quotes with leading single quote')
    assert.ok(csv.includes('"\'\r\n=2+2"'), 'CRLF-prefixed formula must be wrapped with leading single quote')
    assert.ok(csv.includes('"\'\r-cmd"'))
    assert.ok(csv.includes('"\'\r@SUM(1)"'))
  })

  await t.test('7. Preserves legitimate normal names, companies, and roles without modification', () => {
    const records = [
      { name: 'John Doe', title: 'Senior Software Engineer', company: 'Acme Corporation', email: 'john@acme.com', notes: 'Great candidate' },
    ]
    const csv = generateCsv(columns, records)
    const lines = csv.split('\r\n')
    assert.equal(lines[1], 'John Doe,Senior Software Engineer,Acme Corporation,john@acme.com,Great candidate')
    // Must NOT contain single quotes on normal data
    assert.ok(!lines[1].includes("'John Doe"))
    assert.ok(!lines[1].includes("'Acme"))
  })

  await t.test('8. Preserves normal RFC-4180 escaping for commas, quotes, and newlines', () => {
    const records = [
      {
        name: 'Dana "The Architect" Scully',
        title: 'Special Agent, FBI',
        company: 'FBI & Associates, Inc.',
        notes: 'Line 1\nLine 2\r\nLine 3',
      },
    ]
    const csv = generateCsv(columns, records)

    // Double quotes must be doubled: ""The Architect"" and cell wrapped
    assert.ok(csv.includes('"Dana ""The Architect"" Scully"'))
    // Commas must trigger cell wrapping
    assert.ok(csv.includes('"Special Agent, FBI"'))
    assert.ok(csv.includes('"FBI & Associates, Inc."'))
    // Embedded newlines must trigger cell wrapping
    assert.ok(csv.includes('"Line 1\nLine 2\r\nLine 3"'))
  })

  await t.test('9. Preserves Unicode text across all character sets', () => {
    const records = [
      { name: 'René François', title: 'Développeur en Chef', company: 'Société Générale', notes: 'Accents preserved' },
      { name: '田中 太郎', title: '部長', company: 'ソニー株式会社', notes: 'Japanese characters preserved' },
      { name: '李小龙', title: '武术总监', company: '香港电影', notes: 'Chinese characters preserved' },
      { name: '🚀 Rocket Man', title: 'Astronaut 🪐', company: 'SpaceX 🛰️', notes: 'Emoji preserved' },
    ]
    const csv = generateCsv(columns, records)
    assert.ok(csv.includes('René François,Développeur en Chef,Société Générale,,Accents preserved'))
    assert.ok(csv.includes('田中 太郎,部長,ソニー株式会社,,Japanese characters preserved'))
    assert.ok(csv.includes('李小龙,武术总监,香港电影,,Chinese characters preserved'))
    assert.ok(csv.includes('🚀 Rocket Man,Astronaut 🪐,SpaceX 🛰️,,Emoji preserved'))
  })

  await t.test('10. Handles empty, null, and undefined values cleanly', () => {
    const records = [
      { name: null, title: undefined, company: '', email: null, notes: undefined },
    ]
    const csv = generateCsv(columns, records)
    const lines = csv.split('\r\n')
    assert.equal(lines[1], ',,,,', 'Null and empty values must produce empty CSV fields without quotes or artifacts')
  })

  await t.test('11. Applies protection consistently across multiple columns simultaneously', () => {
    const records = [
      {
        name: '=cmd|calc!A0',
        title: '+SUM(1,2)',
        company: '-2+3',
        email: '@attacker.org',
        notes: '\t=DDE("cmd";"/C calc";"__dummy__")',
      },
    ]
    const csv = generateCsv(columns, records)
    const lines = csv.split('\r\n')
    const row = lines[1]

    // Every single field must be neutralized
    assert.ok(row.includes("'=cmd|calc!A0"), 'Name neutralized')
    assert.ok(row.includes('"\'+SUM(1,2)"'), 'Title neutralized')
    assert.ok(row.includes("'-2+3"), 'Company neutralized')
    assert.ok(row.includes("'@attacker.org"), 'Email neutralized')
    assert.ok(row.includes("'\t=DDE"), 'Notes neutralized')
  })

  // ========================================================
  // INTEGRATION TESTS: HTTP API Routes (/api/leads/export & /api/companies/:id/export)
  // ========================================================

  await t.test('12. End-to-End HTTP Export Protection: Leads CSV and Company Leads CSV', async () => {
    const apiPort = await freePort()
    await mongoose.connect(CSV_TEST_DB_URI)

    await Promise.all([
      Lead.deleteMany({}),
      CompanyProfile.deleteMany({}),
      ScanJob.deleteMany({}),
    ])

    const apiEnv = {
      ...process.env,
      NODE_ENV: 'test',
      MONGODB_URI: CSV_TEST_DB_URI,
      PORT: String(apiPort),
      HOST: '127.0.0.1',
      CLIENT_ORIGIN: 'http://localhost:5173',
    }
    const apiServer = spawn('node', ['src/server.js'], { cwd: process.cwd(), env: apiEnv, stdio: 'ignore' })
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
      } catch {}
    }
    assert.equal(healthy, true, 'Test server failed to start')

    try {
      // Create a test company
      const company = await CompanyProfile.create({
        name: '=EvilCorp Calc',
        domain: 'evilcorp.io',
        website: 'https://evilcorp.io',
      })

      // Create leads with various formula injection payloads
      await Lead.create({
        name: '=cmd|\' /C calc\'!A0',
        title: '+SUM(1,2)',
        company: company.name,
        companyId: company._id,
        email: '-evil@evilcorp.io',
        phone: '@12345',
        sourceUrl: 'https://evilcorp.io/team',
        discoveredAt: new Date(),
      })

      await Lead.create({
        name: '\t=1+1',
        title: '\r=2+2',
        company: company.name,
        companyId: company._id,
        email: 'safe.lead@evilcorp.io',
        phone: '+1 415 555 2671',
        sourceUrl: 'https://evilcorp.io/leadership',
        discoveredAt: new Date(),
      })

      // 1. Test GET /api/leads/export
      const leadsRes = await fetch(`${base}/leads/export`)
      assert.equal(leadsRes.status, 200)
      assert.equal(leadsRes.headers.get('content-type'), 'text/csv; charset=utf-8')
      const leadsCsv = await leadsRes.text()

      // Verify no raw formula triggers at start of fields
      assert.ok(leadsCsv.includes("'=cmd"), 'Leads export must neutralize =cmd')
      assert.ok(leadsCsv.includes('"\'\+SUM(1,2)"') || leadsCsv.includes("'+SUM(1,2)"), 'Leads export must neutralize +SUM')
      assert.ok(leadsCsv.includes("'-evil@evilcorp.io"), 'Leads export must neutralize -email')
      assert.ok(leadsCsv.includes("'@12345"), 'Leads export must neutralize @phone')
      assert.ok(leadsCsv.includes("'\t=1+1"), 'Leads export must neutralize tab-prefixed formula')
      assert.ok(leadsCsv.includes('"\'\r=2+2"'), 'Leads export must neutralize CR-prefixed formula')
      assert.ok(leadsCsv.includes("'+1 415 555 2671"), 'Leads export must protect phone numbers')

      // 2. Test GET /api/companies/:id/export
      const compRes = await fetch(`${base}/companies/${company._id}/export`)
      assert.equal(compRes.status, 200)
      assert.equal(compRes.headers.get('content-type'), 'text/csv; charset=utf-8')
      const compCsv = await compRes.text()

      assert.ok(compCsv.includes("'=cmd"), 'Company leads export must neutralize =cmd')
      assert.ok(compCsv.includes("'-evil@evilcorp.io"), 'Company leads export must neutralize -email')
      assert.ok(compCsv.includes("'\t=1+1"), 'Company leads export must neutralize tab-prefixed formula')

    } finally {
      if (apiServer) apiServer.kill('SIGKILL')
      await Promise.all([
        Lead.deleteMany({}),
        CompanyProfile.deleteMany({}),
        ScanJob.deleteMany({}),
      ])
      await mongoose.disconnect()
    }
  })

  // ========================================================
  // EDGE-CASE REVIEW: Specific Review Target Inputs
  // ========================================================

  await t.test('13. Edge-Case Verification: All 8 review targets are neutralized properly', () => {
    const edgeCases = [
      { input: '=1+1', expectedRaw: "'=1+1", desc: 'Basic formula =' },
      { input: '  =1+1', expectedRaw: "'  =1+1", desc: 'Leading spaces before =' },
      { input: '\t', expectedRaw: "'\t", desc: 'Standalone tab character' },
      { input: '\r', expectedRaw: "\"'\r\"", desc: 'Standalone carriage return (RFC-4180 quoted)' },
      { input: '\t=1+1', expectedRaw: "'\t=1+1", desc: 'Tab-prefixed formula' },
      { input: '\r=1+1', expectedRaw: "\"'\r=1+1\"", desc: 'Carriage-return-prefixed formula (RFC-4180 quoted)' },
      { input: '\r\n=1+1', expectedRaw: "\"'\r\n=1+1\"", desc: 'CRLF-prefixed formula (RFC-4180 quoted)' },
      { input: '   @SUM(A1:A10)', expectedRaw: "'   @SUM(A1:A10)", desc: 'Spaces before @ formula' },
    ]

    for (const { input, expectedRaw, desc } of edgeCases) {
      const csv = generateCsv([{ key: 'val', label: 'Field' }], [{ val: input }])
      const lines = csv.split('\r\n')
      // Extract the row value
      const rowValue = lines.slice(1).join('\r\n')
      assert.equal(rowValue, expectedRaw, `Failed for ${desc} (${JSON.stringify(input)}): expected ${JSON.stringify(expectedRaw)}, got ${JSON.stringify(rowValue)}`)
      
      // Crucial security invariant: The cell must start with single quote (or quote-then-single-quote if RFC-4180 quoted)
      const startsWithSingleQuote = rowValue.startsWith("'") || rowValue.startsWith("\"'")
      assert.ok(startsWithSingleQuote, `Cell for ${desc} must start with text prefix single quote (')`)
    }
  })
})

