import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { BuiltInDiscoveryAdapter } from '../src/discovery/crawler.js'

async function fixtureSite(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

test('Phase 4.2 Test A — Robots-blocked URLs do not consume HTTP crawl budget', async () => {
  const httpAttempts = []
  const site = await fixtureSite((req, res) => {
    httpAttempts.push(req.url)
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end(`User-agent: *\nDisallow: /blocked-\nSitemap: http://127.0.0.1:${req.socket.localPort}/sitemap.xml`)
    }
    if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml')
      return res.end(`
        <urlset>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blocked-1</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blocked-2</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blocked-3</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/permitted-1</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/permitted-2</loc></url>
        </urlset>
      `)
    }
    res.setHeader('content-type', 'text/html')
    return res.end('<html><body>Permitted Content</body></html>')
  })

  try {
    const fetchedPages = []
    const blockedPages = []
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 3,
        maxQueuedUrls: 10,
        maxDepth: 1,
        concurrency: 1,
        requestDelay: 0,
        requestTimeoutMs: 1500,
        sitemapDiscovery: true,
        feedDiscovery: false,
        internalLinkCrawling: true,
        queryParameterPolicy: 'preserve',
        allowLocalFixtures: true,
      },
      signal: new AbortController().signal,
      onPage: async p => {
        if (p.processingStatus === 'fetched') fetchedPages.push(new URL(p.url).pathname)
        if (p.processingStatus === 'blocked') blockedPages.push(new URL(p.url).pathname)
      },
      onMetrics: async () => {},
      onLog: async () => {},
      onStage: async () => {},
    })

    // 3 permitted HTTP page requests must have succeeded
    assert.equal(fetchedPages.length, 3)
    assert.deepEqual(fetchedPages, ['/', '/permitted-1', '/permitted-2'])

    // Blocked URLs must be evaluated and recorded as blocked
    assert.ok(blockedPages.includes('/blocked-1'))
    assert.ok(blockedPages.includes('/blocked-2'))
    assert.ok(blockedPages.includes('/blocked-3'))

    // The HTTP server should only have received requests for robots.txt, sitemap.xml, and the 3 permitted pages
    const pageHttpRequests = httpAttempts.filter(u => !u.endsWith('.txt') && !u.endsWith('.xml'))
    assert.deepEqual(pageHttpRequests, ['/', '/permitted-1', '/permitted-2'])
  } finally {
    await site.close()
  }
})

test('Phase 4.2 Test B — Blocked URLs are not repeatedly re-processed or looped', async () => {
  let schedulerInteractions = 0
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end(`User-agent: *\nDisallow: /disallowed\nSitemap: http://127.0.0.1:${req.socket.localPort}/sitemap.xml`)
    }
    if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml')
      return res.end(`
        <urlset>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/disallowed</loc></url>
        </urlset>
      `)
    }
    res.setHeader('content-type', 'text/html')
    // Seed page also links to /disallowed to test deduplication / re-queue prevention
    return res.end('<html><body><a href="/disallowed">Link to Disallowed</a></body></html>')
  })

  try {
    const blockedEvents = []
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 2,
        maxDepth: 1,
        concurrency: 1,
        requestDelay: 0,
        requestTimeoutMs: 1500,
        sitemapDiscovery: true,
        feedDiscovery: false,
        internalLinkCrawling: true,
        queryParameterPolicy: 'preserve',
        allowLocalFixtures: true,
      },
      signal: new AbortController().signal,
      onPage: async p => {
        if (p.processingStatus === 'blocked') blockedEvents.push(new URL(p.url).pathname)
      },
      onMetrics: async () => {},
      onLog: async () => {},
      onStage: async () => {},
    })

    // /disallowed must only be processed as blocked ONCE, not duplicated or looped
    assert.equal(blockedEvents.filter(u => u === '/disallowed').length, 1)
  } finally {
    await site.close()
  }
})

test('Phase 4.2 Test C — HTTP failures consume crawl budget', async () => {
  const httpAttempts = []
  const site = await fixtureSite((req, res) => {
    httpAttempts.push(req.url)
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end('User-agent: *\n')
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      return res.end('<html><body><a href="/not-found">404 Page</a><a href="/permitted">Permitted Page</a></body></html>')
    }
    if (req.url === '/not-found') {
      res.writeHead(404, { 'content-type': 'text/html' })
      return res.end('Not Found')
    }
    res.setHeader('content-type', 'text/html')
    return res.end('Permitted')
  })

  try {
    const failedPages = []
    const fetchedPages = []
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 2,
        maxDepth: 1,
        concurrency: 1,
        requestDelay: 0,
        requestTimeoutMs: 1500,
        sitemapDiscovery: false,
        feedDiscovery: false,
        internalLinkCrawling: true,
        queryParameterPolicy: 'preserve',
        allowLocalFixtures: true,
      },
      signal: new AbortController().signal,
      onPage: async p => {
        if (p.processingStatus === 'fetched') fetchedPages.push(new URL(p.url).pathname)
        if (p.processingStatus === 'failed') failedPages.push(new URL(p.url).pathname)
      },
      onMetrics: async () => {},
      onLog: async () => {},
      onStage: async () => {},
    })

    // Total HTTP page attempts must equal 2 (Seed 200 + /not-found 404)
    const pageHttpRequests = httpAttempts.filter(u => !u.endsWith('.txt'))
    assert.equal(pageHttpRequests.length, 2)
    assert.equal(fetchedPages.length, 1) // /
    assert.equal(failedPages.length, 1) // /not-found
    assert.equal(failedPages[0], '/not-found')

    // /permitted was not crawled because maxPages: 2 was consumed by / and /not-found
    assert.equal(httpAttempts.includes('/permitted'), false)
  } finally {
    await site.close()
  }
})

test('Phase 4.2 Test D — Concurrency enforcement: total HTTP attempts never exceed maxPages under concurrent workers', async () => {
  const httpAttempts = []
  const site = await fixtureSite((req, res) => {
    httpAttempts.push(req.url)
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end('User-agent: *\nDisallow: /blocked-\n')
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      const links = [
        '<a href="/blocked-1">B1</a>',
        '<a href="/blocked-2">B2</a>',
        '<a href="/p-1">P1</a>',
        '<a href="/p-2">P2</a>',
        '<a href="/p-3">P3</a>',
        '<a href="/p-4">P4</a>',
        '<a href="/p-5">P5</a>',
      ].join('')
      return res.end(`<html><body>${links}</body></html>`)
    }
    res.setHeader('content-type', 'text/html')
    return res.end('<html><body>Page Content</body></html>')
  })

  try {
    const fetchedPages = []
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 3,
        maxQueuedUrls: 10,
        maxDepth: 1,
        concurrency: 3,
        requestDelay: 0,
        requestTimeoutMs: 1500,
        sitemapDiscovery: false,
        feedDiscovery: false,
        internalLinkCrawling: true,
        queryParameterPolicy: 'preserve',
        allowLocalFixtures: true,
      },
      signal: new AbortController().signal,
      onPage: async p => {
        if (p.processingStatus === 'fetched') fetchedPages.push(new URL(p.url).pathname)
      },
      onMetrics: async () => {},
      onLog: async () => {},
      onStage: async () => {},
    })

    // Assert strictly bounded to maxPages (3) despite 3 concurrent workers and blocked links
    const pageHttpRequests = httpAttempts.filter(u => !u.endsWith('.txt'))
    assert.equal(pageHttpRequests.length, 3)
    assert.equal(fetchedPages.length, 3)
  } finally {
    await site.close()
  }
})
