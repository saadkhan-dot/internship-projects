import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { BuiltInDiscoveryAdapter, sleepWithSignal } from '../src/discovery/crawler.js'
import { parseSitemapXml } from '../src/discovery/sitemaps.js'
import { isPageUrl, normalizeUrl, sameHost } from '../src/discovery/url.js'

test('normalizes URLs and makes query policy explicit', () => {
  assert.equal(normalizeUrl('../about/?utm_source=mail&b=2#section', 'https://Example.com/path/page'), 'https://example.com/about?utm_source=mail&b=2')
  assert.equal(normalizeUrl('https://example.com/a?utm_source=x&id=5', null, 'remove-tracking'), 'https://example.com/a?id=5')
  assert.equal(normalizeUrl('https://example.com/a?id=5', null, 'remove-all'), 'https://example.com/a')
  assert.equal(normalizeUrl('javascript:alert(1)', 'https://example.com'), null)
  assert.equal(normalizeUrl('mailto:a@example.com', 'https://example.com'), null)
  assert.equal(normalizeUrl('http://[bad-url'), null)
})

test('filters external hosts and non-page resources', () => {
  assert.equal(sameHost('https://example.com/path', 'http://example.com'), true)
  assert.equal(sameHost('https://other.example/path', 'https://example.com'), false)
  for (const ext of ['pdf', 'png', 'css', 'js', 'woff2', 'mp4']) assert.equal(isPageUrl(`https://example.com/a.${ext}`), false)
  assert.equal(isPageUrl('https://example.com/a?download=1'), true)
})

test('parses sitemap URL sets and nested sitemap indexes', () => {
  const index = parseSitemapXml('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://e.test/child.xml</loc></sitemap></sitemapindex>', 'https://e.test/index.xml')
  assert.equal(index.kind, 'index')
  assert.deepEqual(index.urls, ['https://e.test/child.xml'])
  const urls = parseSitemapXml('<urlset><url><loc>https://e.test/a#fragment</loc></url><url><loc>https://e.test/b</loc></url></urlset>', 'https://e.test/sitemap.xml')
  assert.equal(urls.kind, 'urlset')
  assert.deepEqual(urls.urls, ['https://e.test/a', 'https://e.test/b'])
  assert.throws(() => parseSitemapXml('<broken', 'https://e.test/sitemap.xml'), /Malformed/)
})

async function fixtureSite(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('crawls fixture sitemap and internal links with limits, dedupe, redirects and failures', async () => {
  const site = await fixtureSite((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/robots.txt') { res.setHeader('content-type', 'text/plain'); return res.end(`User-agent: *\nDisallow: /blocked\nSitemap: http://127.0.0.1:${req.socket.localPort}/index.xml`) }
    if (req.url === '/index.xml') { res.setHeader('content-type', 'application/xml'); return res.end('<sitemapindex><sitemap><loc>/child.xml</loc></sitemap></sitemapindex>') }
    if (req.url === '/child.xml') { res.setHeader('content-type', 'application/xml'); return res.end('<urlset><url><loc>/from-map</loc></url><url><loc>/from-map#dupe</loc></url></urlset>') }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/page' }); return res.end() }
    if (req.url === '/fail') { res.writeHead(503); return res.end('unavailable') }
    const links = req.url === '/' ? '<a href="/page">page</a><a href="/page#repeat">again</a><a href="/deep">deep</a><a href="/redirect">redirect</a><a href="/fail">fail</a><a href="/blocked">blocked</a><a href="https://elsewhere.test/x">external</a><a href="/photo.png">image</a>' : req.url === '/page' ? '<a href="/depth-two">too deep</a>' : ''
    res.end(`<html><body>${links}</body></html>`)
  })
  try {
    const records = new Map(), metrics = {}, messages = []
    await new BuiltInDiscoveryAdapter().discover({ siteUrl: site.origin, options: { maxPages: 20, maxDepth: 1, concurrency: 2, requestDelay: 0, requestTimeoutMs: 1500, sitemapDiscovery: true, internalLinkCrawling: true, queryParameterPolicy: 'preserve', allowLocalFixtures: true }, signal: new AbortController().signal, onPage: async page => records.set(page.normalizedUrl, { ...records.get(page.normalizedUrl), ...page }), onMetrics: async value => { for (const key of ['pagesAttempted','pagesFetched','failedRequests']) if (key in value) metrics[key]=(metrics[key]||0)+value[key]; Object.assign(metrics,Object.fromEntries(Object.entries(value).filter(([key])=>!['pagesAttempted','pagesFetched','failedRequests'].includes(key)))) }, onLog: async message => messages.push(message), onStage: async () => {} })
    assert.ok(records.has(`${site.origin}/`))
    assert.ok(records.has(`${site.origin}/from-map`))
    assert.equal(records.has(`${site.origin}/depth-two`), false, 'depth limit prevents depth-2 URL')
    assert.equal(records.has(`${site.origin}/blocked`), true)
    assert.equal(records.get(`${site.origin}/blocked`).processingStatus, 'blocked')
    assert.equal(records.get(`${site.origin}/fail`).processingStatus, 'failed')
    assert.equal(records.get(`${site.origin}/redirect`).httpStatus, 200)
    assert.equal([...records.keys()].filter(url => url.endsWith('/page')).length, 1)
    assert.equal([...records.keys()].some(url => url.includes('elsewhere.test') || url.endsWith('.png')), false)
    assert.ok(metrics.pagesFetched >= 2, JSON.stringify({ metrics, messages, records: [...records.keys()] }))
    assert.ok(metrics.failedRequests >= 1)
    assert.ok(messages.some(message => message.includes('Sitemap index')))
  } finally { await site.close() }
})

test('skips malformed sitemap gracefully and respects page limits', async () => {
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') { res.setHeader('content-type', 'text/plain'); return res.end('User-agent: *\n') }
    if (req.url.endsWith('.xml')) { res.setHeader('content-type', 'application/xml'); return res.end('<urlset><url><loc>http://example.test/x</loc></url>') }
    res.setHeader('content-type', 'text/html'); res.end('<a href="/one">one</a><a href="/two">two</a>')
  })
  try {
    const records = [], messages = []
    await new BuiltInDiscoveryAdapter().discover({ siteUrl: site.origin, options: { maxPages: 2, maxDepth: 5, concurrency: 1, requestDelay: 0, requestTimeoutMs: 1500, sitemapDiscovery: true, internalLinkCrawling: true, queryParameterPolicy: 'preserve', allowLocalFixtures: true }, signal: new AbortController().signal, onPage: async page => records.push(page), onMetrics: async () => {}, onLog: async message => messages.push(message), onStage: async () => {} })
    assert.equal(new Set(records.map(x => x.normalizedUrl)).size, 2)
    assert.ok(messages.some(message => message.includes('Malformed sitemap XML')), messages.join('\n'))
  } finally { await site.close() }
})

test('cancellation aborts an in-flight request and leaves partial discoveries available', async () => {
  let slowStarted = false
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') { res.setHeader('content-type', 'text/plain'); return res.end('User-agent: *\n') }
    if (req.url.endsWith('.xml')) { res.writeHead(404); return res.end() }
    if (req.url === '/slow') { slowStarted = true; req.on('close', () => {}); return setTimeout(() => { if (!res.destroyed) res.end('<html/>') }, 3000) }
    res.setHeader('content-type', 'text/html'); res.end('<a href="/slow">slow</a>')
  })
  const controller = new AbortController(), partial = []
  try {
    const pending = new BuiltInDiscoveryAdapter().discover({ siteUrl: site.origin, options: { maxPages: 10, maxDepth: 2, concurrency: 1, requestDelay: 0, requestTimeoutMs: 10000, sitemapDiscovery: false, internalLinkCrawling: true, queryParameterPolicy: 'preserve', allowLocalFixtures: true }, signal: controller.signal, onPage: async page => partial.push(page), onMetrics: async () => {}, onLog: async () => {}, onStage: async () => {} })
    for (let i=0; i<100 && !slowStarted; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(slowStarted, true)
    controller.abort()
    await assert.rejects(pending, /cancel/i)
    assert.ok(partial.some(page => page.source === 'seed'))
    assert.ok(partial.some(page => page.url.endsWith('/slow')))
  } finally { await site.close() }
})

test('cancellation-aware delay removes its abort listener on resolve and abort', async () => {
  const listeners = new Set()
  const signal = { aborted: false, addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) }
  await sleepWithSignal(1, signal)
  assert.equal(listeners.size, 0, 'normal timeout removes its listener')
  const pending = sleepWithSignal(1000, signal)
  assert.equal(listeners.size, 1)
  signal.aborted = true
  for (const listener of [...listeners]) listener()
  await assert.rejects(pending, /cancel/i)
  assert.equal(listeners.size, 0, 'abort removes its listener')
})

test('RSS autodiscovery feeds same-host article URLs into the normal crawl queue', async () => {
  const site = await fixtureSite((req, res) => {
    if (req.url === '/robots.txt') { res.setHeader('content-type', 'text/plain'); return res.end('User-agent: *\n') }
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<link rel="alternate" type="application/rss+xml" href="/feed.xml"><a href="https://elsewhere.test/article">external</a>') }
    if (req.url === '/feed.xml') { res.setHeader('content-type', 'application/rss+xml'); return res.end('<rss><channel><item><title>Story</title><link>/story</link><guid>story-id</guid></item><item><link>https://elsewhere.test/nope</link></item></channel></rss>') }
    res.setHeader('content-type', 'text/html'); res.end('<html/>')
  })
  try {
    const records = new Map(), metrics = {}
    await new BuiltInDiscoveryAdapter().discover({ siteUrl: site.origin, options: { maxPages: 10, maxDepth: 0, concurrency: 1, requestDelay: 0, requestTimeoutMs: 1000, sitemapDiscovery: false, internalLinkCrawling: false, allowLocalFixtures: true }, signal: new AbortController().signal, onPage: async page => records.set(page.normalizedUrl, page), onMetrics: async patch => Object.assign(metrics, patch), onLog: async () => {}, onStage: async () => {} })
    assert.equal(records.get(`${site.origin}/story`).source, 'rss')
    assert.equal(records.get(`${site.origin}/story`).title, 'Story')
    assert.equal(records.has('https://elsewhere.test/nope'), false)
    assert.deepEqual(metrics.rssDiscovery, { feedsDiscovered: 1, feedEntriesFound: 2, feedUrlsAdded: 1, duplicateEntriesIgnored: 0 })
  } finally { await site.close() }
})
