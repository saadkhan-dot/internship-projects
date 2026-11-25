import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { BuiltInDiscoveryAdapter, calculateUrlPriority, CRAWL_PRIORITY } from '../src/discovery/crawler.js'

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

test('Priority: calculateUrlPriority returns correct hierarchy', () => {
  assert.equal(calculateUrlPriority({ url: 'https://ex.test/', source: 'seed' }), CRAWL_PRIORITY.SEED)
  assert.equal(calculateUrlPriority({ url: 'https://ex.test/?page=2', source: 'pagination' }), CRAWL_PRIORITY.PAGINATION)
  assert.equal(calculateUrlPriority({ url: 'https://ex.test/people/smith', source: 'profile' }), CRAWL_PRIORITY.PROFILE)
  assert.equal(calculateUrlPriority({ url: 'https://ex.test/faculty', source: 'internal-link' }), CRAWL_PRIORITY.RELEVANT_INTERNAL)
  assert.equal(calculateUrlPriority({ url: 'https://ex.test/docs/intro', source: 'internal-link' }), CRAWL_PRIORITY.GENERAL_INTERNAL)
  assert.equal(calculateUrlPriority({ url: 'https://ex.test/team', source: 'sitemap' }), CRAWL_PRIORITY.RELEVANT_SITEMAP)
  assert.equal(calculateUrlPriority({ url: 'https://ex.test/blog/post-1', source: 'sitemap' }), CRAWL_PRIORITY.GENERIC_SITEMAP_OR_FEED)

  // Validate numeric ordering
  assert.ok(CRAWL_PRIORITY.SEED > CRAWL_PRIORITY.PAGINATION)
  assert.ok(CRAWL_PRIORITY.PAGINATION > CRAWL_PRIORITY.PROFILE)
  assert.ok(CRAWL_PRIORITY.PROFILE > CRAWL_PRIORITY.RELEVANT_INTERNAL)
  assert.ok(CRAWL_PRIORITY.RELEVANT_INTERNAL > CRAWL_PRIORITY.GENERAL_INTERNAL)
  assert.ok(CRAWL_PRIORITY.GENERAL_INTERNAL > CRAWL_PRIORITY.RELEVANT_SITEMAP)
  assert.ok(CRAWL_PRIORITY.RELEVANT_SITEMAP > CRAWL_PRIORITY.GENERIC_SITEMAP_OR_FEED)
})

test('Priority: Pagination is processed before generic sitemap URLs', async () => {
  const crawled = []
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end(`User-agent: *\nSitemap: http://127.0.0.1:${req.socket.localPort}/sitemap.xml`)
    }
    if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml')
      return res.end(`
        <urlset>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blog/post-1</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blog/post-2</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blog/post-3</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blog/post-4</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blog/post-5</loc></url>
        </urlset>
      `)
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      return res.end(`
        <html>
          <body>
            <h1>Faculty Directory</h1>
            <table><tr><th>Name</th><th>Role</th></tr><tr><td>Dr. Turing</td><td>Professor</td></tr></table>
            <a href="/directory?page=2" rel="next">Next Page</a>
          </body>
        </html>
      `)
    }
    if (req.url === '/directory?page=2') {
      res.setHeader('content-type', 'text/html')
      return res.end(`
        <html>
          <body>
            <h1>Faculty Directory Page 2</h1>
            <table><tr><th>Name</th><th>Role</th></tr><tr><td>Dr. Hopper</td><td>Associate Professor</td></tr></table>
          </body>
        </html>
      `)
    }
    res.setHeader('content-type', 'text/html')
    return res.end('<html><body>Blog Post</body></html>')
  })

  try {
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 3,
        maxDepth: 2,
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
        if (p.processingStatus === 'fetched') crawled.push(new URL(p.url).pathname + new URL(p.url).search)
      },
      onMetrics: async () => {},
      onLog: async () => {},
      onStage: async () => {},
    })

    // Directory Page 2 MUST be crawled before any sitemap blog post!
    assert.equal(crawled[0], '/')
    assert.equal(crawled[1], '/directory?page=2')
    // Third page is sitemap blog post because directory pagination finished
    assert.ok(crawled[2].startsWith('/blog/'))
    assert.equal(crawled.length, 3)
  } finally {
    await site.close()
  }
})

test('Priority: Profile pages are not starved by generic sitemaps', async () => {
  const crawled = []
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end(`User-agent: *\nSitemap: http://127.0.0.1:${req.socket.localPort}/sitemap.xml`)
    }
    if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml')
      return res.end(`
        <urlset>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/news/item-1</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/news/item-2</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/news/item-3</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/news/item-4</loc></url>
        </urlset>
      `)
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      return res.end(`
        <html>
          <body>
            <h1>Team</h1>
            <div class="member-card">
              <h3>Alice Smith</h3>
              <p>Engineer</p>
              <a href="/people/alice-smith">Bio</a>
            </div>
            <div class="member-card">
              <h3>Bob Jones</h3>
              <p>Designer</p>
              <a href="/people/bob-jones">Bio</a>
            </div>
          </body>
        </html>
      `)
    }
    if (req.url.startsWith('/people/')) {
      res.setHeader('content-type', 'text/html')
      return res.end('<html><body><h1>Person Bio</h1></body></html>')
    }
    res.setHeader('content-type', 'text/html')
    return res.end('<html><body>Generic News</body></html>')
  })

  try {
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 3,
        maxDepth: 2,
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
        if (p.processingStatus === 'fetched') crawled.push(new URL(p.url).pathname)
      },
      onMetrics: async () => {},
      onLog: async () => {},
      onStage: async () => {},
    })

    assert.equal(crawled.length, 3)
    assert.equal(crawled[0], '/')
    // Profile pages MUST consume the remaining budget; generic news must not starve them!
    const profilesFetched = crawled.filter(u => u.startsWith('/people/'))
    assert.equal(profilesFetched.length, 2)
    assert.ok(crawled.includes('/people/alice-smith'))
    assert.ok(crawled.includes('/people/bob-jones'))
    // Zero news pages crawled
    assert.equal(crawled.some(u => u.startsWith('/news/')), false)
  } finally {
    await site.close()
  }
})

test('Priority & Deduplication: URL priority is upgraded when discovered from higher-priority source', async () => {
  const crawled = []
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end(`User-agent: *\nSitemap: http://127.0.0.1:${req.socket.localPort}/sitemap.xml`)
    }
    if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml')
      // Sitemaps list /about/ceo and /blog/first
      return res.end(`
        <urlset>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blog/first</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/about/ceo</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/blog/second</loc></url>
        </urlset>
      `)
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      // Homepage has candidate card linking to /about/ceo as profile URL!
      return res.end(`
        <html>
          <body>
            <h1>Welcome</h1>
            <div class="team-card">
              <h3>Jane Doe</h3>
              <p>CEO</p>
              <a href="/about/ceo">Profile</a>
            </div>
          </body>
        </html>
      `)
    }
    res.setHeader('content-type', 'text/html')
    return res.end('<html><body>Page Content</body></html>')
  })

  try {
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 2,
        maxDepth: 2,
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
        if (p.processingStatus === 'fetched') crawled.push(new URL(p.url).pathname)
      },
      onMetrics: async () => {},
      onLog: async () => {},
      onStage: async () => {},
    })

    assert.equal(crawled.length, 2)
    assert.equal(crawled[0], '/')
    // /about/ceo was upgraded to profile priority (60) over /blog/first (10)
    assert.equal(crawled[1], '/about/ceo')
  } finally {
    await site.close()
  }
})

test('Limits: maxPages is strictly enforced and never exceeded', async () => {
  const crawled = []
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end('User-agent: *\n')
    }
    res.setHeader('content-type', 'text/html')
    const links = Array.from({ length: 20 }, (_, i) => `<a href="/page-${i}">Page ${i}</a>`).join('')
    return res.end(`<html><body>${links}</body></html>`)
  })

  try {
    const metrics = {}
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 4,
        maxDepth: 2,
        concurrency: 2,
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
        if (p.processingStatus === 'fetched') crawled.push(new URL(p.url).pathname)
      },
      onMetrics: async data => Object.assign(metrics, data),
      onLog: async () => {},
      onStage: async () => {},
    })

    assert.equal(crawled.length, 4)
    assert.equal(metrics.totalKnown, 4)
  } finally {
    await site.close()
  }
})

test('Limits: maxDepth is strictly enforced', async () => {
  const crawled = []
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end('User-agent: *\n')
    }
    res.setHeader('content-type', 'text/html')
    if (req.url === '/') return res.end('<a href="/depth-1">Depth 1</a>')
    if (req.url === '/depth-1') return res.end('<a href="/depth-2">Depth 2</a>')
    if (req.url === '/depth-2') return res.end('<a href="/depth-3">Depth 3</a>')
    return res.end('<html>Deep</html>')
  })

  try {
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 10,
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
        if (p.processingStatus === 'fetched') crawled.push(new URL(p.url).pathname)
      },
      onMetrics: async () => {},
      onLog: async () => {},
      onStage: async () => {},
    })

    assert.deepEqual(crawled, ['/', '/depth-1'])
    assert.equal(crawled.includes('/depth-2'), false)
  } finally {
    await site.close()
  }
})

test('Limits: Queue eviction discards lower-priority sitemap URLs when queue limit is reached', async () => {
  const crawled = []
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain')
      return res.end(`User-agent: *\nSitemap: http://127.0.0.1:${req.socket.localPort}/sitemap.xml`)
    }
    if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml')
      // Fill sitemap with 5 entries
      return res.end(`
        <urlset>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/sitemap-1</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/sitemap-2</loc></url>
          <url><loc>http://127.0.0.1:${req.socket.localPort}/sitemap-3</loc></url>
        </urlset>
      `)
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      return res.end(`
        <html>
          <body>
            <h1>Directory</h1>
            <a href="/directory?page=2" rel="next">Next</a>
          </body>
        </html>
      `)
    }
    res.setHeader('content-type', 'text/html')
    return res.end('<html><body>Page Content</body></html>')
  })

  try {
    // Set maxQueuedUrls = 3 (seed + 2 sitemaps saturate queue)
    await new BuiltInDiscoveryAdapter().discover({
      siteUrl: site.origin,
      options: {
        maxPages: 2,
        maxQueuedUrls: 3,
        maxDepth: 2,
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
        if (p.processingStatus === 'fetched') crawled.push(new URL(p.url).pathname + new URL(p.url).search)
      },
      onMetrics: async () => {},
      onLog: async () => {},
      onStage: async () => {},
    })

    assert.equal(crawled[0], '/')
    // /directory?page=2 must have evicted a sitemap item and been crawled second!
    assert.equal(crawled[1], '/directory?page=2')
    assert.equal(crawled.length, 2)
  } finally {
    await site.close()
  }
})
