import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const freePort = () => new Promise((resolve, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) }) })
async function scanUntil(base, id, states, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs
  let job
  while (Date.now() < until) {
    job = await (await fetch(`${base}/scans/${id}`)).json()
    if (states.includes(job.status)) return job
    await wait(30)
  }
  throw new Error(`Scan ${id} did not reach ${states.join('/')} (last: ${job?.status})`)
}

test('API runs, cancels, fails, persists URLs, and keeps Phase 1 endpoints available', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leadintel-api-test-'))
  const mongoPort = await freePort(), apiPort = await freePort()
  let mongod, api, site
  const slowRequests = new Set()
  try {
    mongod = spawn('mongod', ['--dbpath', dir, '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' })
    site = createServer((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /blocked\n') }
      if (req.url === '/sitemap.xml' || req.url === '/sitemap_index.xml') { res.writeHead(404); return res.end() }
      if (req.url === '/slow') { const timer = setTimeout(() => { slowRequests.delete(timer); if (!res.destroyed) res.end('<html>slow</html>') }, 5000); slowRequests.add(timer); req.on('close', () => { clearTimeout(timer); slowRequests.delete(timer) }); return }
      if (req.url === '/missing') { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('offline') }
      res.writeHead(200, { 'content-type': 'text/html' })
      if (req.url === '/extract') return res.end('<html><head><title>Contact</title></head><body><script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Grace Hopper","jobTitle":"Engineer","email":"grace@example.test","telephone":"+1 415 555 0101","worksFor":{"@type":"Organization","name":"Navy Systems"}}</script></body></html>')
      if (req.url === '/ratio') return res.end(Array.from({ length: 15 }, (_, i) => `<a href="/ratio/page-${i + 1}">page</a>`).join('') + '<a href="/blocked">robots blocked</a>')
      res.end(req.url === '/' ? '<a href="/page">page</a><a href="/missing">missing</a><a href="/slow">slow</a><a href="/blocked">blocked</a><a href="https://external.invalid/out">external</a>' : '<html><body>ok</body></html>')
    })
    site.listen(0, '127.0.0.1'); await once(site, 'listening')
    const origin = `http://127.0.0.1:${site.address().port}`
    const apiEnv = { ...process.env, NODE_ENV: 'test', LEADINTEL_ALLOW_LOCAL_FIXTURES: 'true', MONGODB_URI: `mongodb://127.0.0.1:${mongoPort}/leadintel_phase2_test?heartbeatFrequencyMS=500&serverSelectionTimeoutMS=3000`, PORT: String(apiPort), HOST: '127.0.0.1', CLIENT_ORIGIN: 'http://localhost:5173' }
    api = spawn('node', ['src/server.js'], { cwd: process.cwd(), env: apiEnv, stdio: 'ignore' })
    const base = `http://127.0.0.1:${apiPort}/api`
    let health
    for (let i = 0; i < 120; i++) { await wait(100); try { health = await (await fetch(`${base}/health`)).json(); if (health.dbConnected) break } catch {} }
    assert.equal(health?.dbConnected, true, 'backend should connect to temporary MongoDB')
    const savedSettings = await fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultPageLimit: 20, crawlDepth: 2, requestDelay: 0, concurrency: 2, requestTimeoutMs: 3000, sitemapDiscovery: false, internalLinkCrawling: true, seleniumFallback: true, queryParameterPolicy: 'preserve' }) })
    assert.equal(savedSettings.status, 200)

    const create = (target, options = { maxPages: 10, maxDepth: 1 }) => fetch(`${base}/scans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'website', target, options }) })
    for (const options of [null, { maxPages: '10' }, { maxPages: NaN }, { maxPages: Infinity }, { maxDepth: null }, { maxDepth: -1 }, { concurrency: 99 }]) {
      const invalid = await create(origin, options)
      assert.equal(invalid.status, 400, JSON.stringify(options))
    }
    const completedResponse = await create(origin)
    assert.equal(completedResponse.status, 201)
    const completedJob = await completedResponse.json()
    const completed = await scanUntil(base, completedJob._id, ['completed', 'failed'])
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    assert.ok(completed.progress.pagesAttempted >= 3)
    assert.ok(completed.progress.pagesFetched >= 2)
    assert.ok(completed.progress.failedRequests >= 1)
    const pageResponse = await fetch(`${base}/scans/${completedJob._id}/pages?source=internal-link`)
    const pageResults = await pageResponse.json()
    assert.ok(pageResults.items.some(page => page.url.endsWith('/page') && page.processingStatus === 'fetched' && page.httpStatus === 200))
    assert.ok(pageResults.items.some(page => page.url.endsWith('/missing') && page.processingStatus === 'failed' && page.httpStatus === 503))
    assert.ok(pageResults.items.some(page => page.url.endsWith('/blocked') && page.processingStatus === 'blocked'))
    assert.equal(pageResults.items.some(page => page.url.includes('external.invalid')), false)
    assert.ok(completed.logs.some(log => log.message.includes('Fetched page')))

    const extractionResponse = await create(`${origin}/extract`, { maxPages: 2, maxDepth: 0 })
    const extractionJob = await extractionResponse.json()
    const extractionResult = await scanUntil(base, extractionJob._id, ['completed', 'failed'])
    assert.equal(extractionResult.status, 'completed', JSON.stringify(extractionResult))
    assert.equal(extractionResult.progress.extractionPagesProcessed, 1)
    assert.equal(extractionResult.progress.candidatesFound, 2)
    const candidatesResponse = await fetch(`${base}/scans/${extractionJob._id}/candidates?type=person&status=candidate`)
    assert.equal(candidatesResponse.status, 200)
    const candidateData = await candidatesResponse.json()
    assert.equal(candidateData.total, 1)
    assert.equal(candidateData.items[0].fields.full_name, 'Grace Hopper')
    assert.ok(candidateData.items[0].provenance.some(item => item.fieldName === 'email' && item.method === 'json_ld'))

    // Candidate API validation regressions
    const malformedCandidates = await fetch(`${base}/scans/invalid-id/candidates`)
    assert.equal(malformedCandidates.status, 400)
    assert.deepEqual(await malformedCandidates.json(), { error: 'Invalid scan ID.' })

    const nonexistentCandidates = await fetch(`${base}/scans/6b028d9b36d6e50dec599999/candidates`)
    assert.equal(nonexistentCandidates.status, 200)
    const nonexistentData = await nonexistentCandidates.json()
    assert.equal(nonexistentData.total, 0)
    assert.equal(nonexistentData.items.length, 0)

    const ratioResponse = await create(`${origin}/ratio`, { maxPages: 30, maxDepth: 1 })
    assert.equal(ratioResponse.status, 201, JSON.stringify(await ratioResponse.clone().json()))
    const ratioJob = await ratioResponse.json()
    const ratioResult = await scanUntil(base, ratioJob._id, ['completed', 'failed'])
    assert.equal(ratioResult.status, 'completed')
    assert.equal(ratioResult.progress.urlsDiscovered, 17)
    assert.equal(ratioResult.progress.pagesAttempted, 16)
    assert.equal(ratioResult.progress.pagesFetched, 16)
    assert.equal(ratioResult.progress.percent, 100)

    const cancelResponse = await create(origin)
    const cancelJob = await cancelResponse.json()
    const inFlight = await scanUntil(base, cancelJob._id, ['running'])
    let progress = inFlight
    for (let i = 0; i < 120 && (progress.progress?.pagesAttempted || 0) < 2; i++) { await wait(20); progress = await (await fetch(`${base}/scans/${cancelJob._id}`)).json() }
    const cancellation = await fetch(`${base}/scans/${cancelJob._id}/cancel`, { method: 'POST' })
    assert.equal(cancellation.status, 200)
    const cancelled = await scanUntil(base, cancelJob._id, ['cancelled'])
    assert.equal(cancelled.status, 'cancelled')
    const partial = await (await fetch(`${base}/scans/${cancelJob._id}/pages`)).json()
    assert.ok(partial.items.length >= 2, 'cancellation keeps partial discoveries')

    const interruptedResponse = await create(origin)
    const interruptedJob = await interruptedResponse.json()
    let interruptedProgress = await scanUntil(base, interruptedJob._id, ['running'])
    for (let i = 0; i < 120 && (interruptedProgress.progress?.pagesAttempted || 0) < 2; i++) { await wait(20); interruptedProgress = await (await fetch(`${base}/scans/${interruptedJob._id}`)).json() }
    const apiExit = once(api, 'exit')
    api.kill('SIGTERM'); await apiExit
    api = spawn('node', ['src/server.js'], { cwd: process.cwd(), env: apiEnv, stdio: 'ignore' })
    let reconnected = false
    for (let i = 0; i < 120; i++) { await wait(50); try { const health = await (await fetch(`${base}/health`)).json(); if (health.dbConnected) { reconnected = true; break } } catch {} }
    assert.equal(reconnected, true)
    const recovered = await scanUntil(base, interruptedJob._id, ['failed', 'cancelled'])
    assert.equal(recovered.status, 'failed')
    assert.match(recovered.error, /restarted/)
    const restartPartial = await (await fetch(`${base}/scans/${interruptedJob._id}/pages`)).json()
    assert.ok(restartPartial.items.length >= 2)

    const deadPort = await freePort()
    const unreachableResponse = await create(`http://127.0.0.1:${deadPort}`)
    const unreachableJob = await unreachableResponse.json()
    const unreachable = await scanUntil(base, unreachableJob._id, ['failed', 'completed'])
    assert.equal(unreachable.status, 'failed')
    assert.equal(unreachable.error, 'No HTML pages could be fetched.')
    assert.match(unreachable.failureReason, /ECONNREFUSED|connect/i)
    assert.ok(unreachable.logs.some(log => /failed|unavailable/i.test(log.message)))
    const stats = await (await fetch(`${base}/dashboard`)).json()
    assert.ok(stats.completedScans >= 1)
    const persistedSettings = await (await fetch(`${base}/settings`)).json()
    assert.equal(persistedSettings.requestDelay, 0)
    assert.equal(persistedSettings.seleniumFallback, false)

    const mongodExit = once(mongod, 'exit')
    mongod.kill('SIGTERM'); await mongodExit; mongod = null
    let disconnectedHealth
    for (let i = 0; i < 100; i++) { await wait(100); try { const response = await fetch(`${base}/health`); disconnectedHealth = await response.json(); if (!disconnectedHealth.dbConnected) break } catch {} }
    assert.equal(disconnectedHealth?.dbConnected, false, 'health must report MongoDB disconnection')
    assert.equal((await fetch(`${base}/dashboard`)).status, 503, 'database-backed API routes must reject requests while disconnected')
    assert.equal((await create(origin)).status, 503, 'scan creation must not queue a job while disconnected')

    mongod = spawn('mongod', ['--dbpath', dir, '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' })
    let reconnectedHealth
    for (let i = 0; i < 160; i++) { await wait(100); try { const response = await fetch(`${base}/health`); reconnectedHealth = await response.json(); if (reconnectedHealth.dbConnected) break } catch {} }
    assert.equal(reconnectedHealth?.dbConnected, true, 'backend should become ready after MongoDB reconnects')
    const recoveredCreate = await create(origin)
    assert.equal(recoveredCreate.status, 201, 'scan creation should recover without restarting the backend')
    const recoveredQueued = await recoveredCreate.json()
    assert.equal((await scanUntil(base, recoveredQueued._id, ['completed', 'failed'])).status, 'completed')
    console.log('API integration: scan lifecycle, cancellation, restart recovery, database disconnect/reconnect, persistence, and settings passed')
  } finally {
    for (const timer of slowRequests) clearTimeout(timer)
    api?.kill('SIGTERM'); mongod?.kill('SIGTERM')
    if (site) await new Promise(resolve => site.close(resolve))
    await wait(200)
    await rm(dir, { recursive: true, force: true })
  }
})
