import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { safeFetch, validateOutboundUrl } from '../src/discovery/fetch.js'
import { discoverSitemaps, parseSitemapXml } from '../src/discovery/sitemaps.js'
import { BuiltInDiscoveryAdapter } from '../src/discovery/crawler.js'
import { gzipSync } from 'node:zlib'
import ipaddr from 'ipaddr.js'

test('outbound URL safety rejects loopback, private, link-local, and reserved IPv4 and IPv6', async () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.2', '169.254.1.1', '224.0.0.1', '0.0.0.0', '[::1]', '[fc00::1]', '[fe80::1]', '[2001:db8::1]']) {
    await assert.rejects(validateOutboundUrl(`http://${host}/`), /prohibited|non-public/)
  }
  assert.equal((await validateOutboundUrl('https://example.test/', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] })).url.hostname, 'example.test')
  assert.deepEqual((await validateOutboundUrl('https://public.example/', { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] })).addresses, [{ address: '93.184.216.34', family: 4 }])
  await assert.rejects(validateOutboundUrl('http://example.test:8080/', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }), /port 80/)
})

test('public address classification covers IPv4, IPv6, mapped IPv6, and every DNS answer', async () => {
  const prohibited = [
    ['127.0.0.1', 4], ['10.0.0.1', 4], ['172.16.0.1', 4], ['192.168.1.1', 4],
    ['169.254.169.254', 4], ['100.64.0.1', 4], ['224.0.0.1', 4], ['240.0.0.1', 4], ['0.0.0.0', 4],
    ['::1', 6], ['fe80::1', 6], ['fc00::1', 6], ['ff02::1', 6], ['2001:db8::1', 6],
    ['::ffff:127.0.0.1', 6], ['::ffff:10.0.0.1', 6],
  ]
  for (const [address] of prohibited) {
    const host = address.includes(':') ? `[${address}]` : address
    await assert.rejects(validateOutboundUrl(`https://${host}/`), /prohibited|non-public/, address)
  }

  for (const [address, family] of [['93.184.216.34', 4], ['2606:4700:4700::1111', 6], ['::ffff:93.184.216.34', 6]]) {
    const host = address.includes(':') ? `[${address}]` : address
    const result = await validateOutboundUrl(`https://${host}/`)
    assert.equal(ipaddr.process(result.addresses[0].address).toString(), ipaddr.process(address).toString())
    assert.equal(result.addresses[0].family, family)
  }

  const answers = [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]
  assert.deepEqual((await validateOutboundUrl('https://mixed.example/', { lookup: async () => answers })).addresses, [answers[0]])
  await assert.rejects(validateOutboundUrl('https://mixed.example/', { lookup: async () => [answers[1]] }), /prohibited/)
  const publicAnswers = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]
  const result = await validateOutboundUrl('https://public.example/', { lookup: async () => publicAnswers })
  assert.deepEqual(result.addresses, publicAnswers)
  await assert.rejects(validateOutboundUrl('https://empty.example/', { lookup: async () => [] }), /prohibited|non-public/)
  await assert.rejects(validateOutboundUrl('https://bad-record.example/', { lookup: async () => [{ address: 'not-an-ip', family: 4 }, { address: '93.184.216.34', family: 6 }] }), /prohibited|non-public/)
})

async function localServer(handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('safeFetch rejects prohibited destinations and bounds decompressed response bytes', async () => {
  await assert.rejects(safeFetch('http://127.0.0.1/'), /prohibited|non-public/)
  const fixture = await localServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.2/private' }); return res.end() }
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
    res.end(gzipSync(Buffer.alloc(200, 65)))
  })
  try {
    await assert.rejects(safeFetch(`${fixture.url}/redirect`, { allowLocalFixtures: true, maxHtmlBytes: 10, timeoutMs: 100 }))
    const response = await safeFetch(fixture.url, { allowLocalFixtures: true, maxHtmlBytes: 100 })
    await assert.rejects(response.text(), /100-byte/)
  } finally { await fixture.close() }
})

test('sitemap URL set and huge index report configured truncation', async () => {
  const privateReference = parseSitemapXml('<urlset><url><loc>http://127.0.0.1/internal</loc></url></urlset>', 'https://example.test/map.xml')
  await assert.rejects(validateOutboundUrl(privateReference.urls[0]), /prohibited|non-public/)
  const locs = Array.from({ length: 5 }, (_, i) => `<sitemap><loc>https://example.test/${i}.xml</loc></sitemap>`).join('')
  const parsed = parseSitemapXml(`<sitemapindex>${locs}</sitemapindex>`, 'https://example.test/index.xml', { maxIndexChildren: 2 })
  assert.equal(parsed.urls.length, 2)
  assert.equal(parsed.truncated, true)
  const fixture = await localServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' })
    if (req.url === '/sitemap.xml') return res.end(`<sitemapindex>${locs}</sitemapindex>`)
    res.end('<urlset/>')
  })
  try {
    const logs = []
    const result = await discoverSitemaps(fixture.url, { allowLocalFixtures: true, limits: { sitemapSources: 1, sitemapIndexChildren: 2 }, log: async msg => logs.push(msg) })
    assert.equal(result.truncated, true)
    assert.equal(result.complete, false)
    assert.ok(result.remainingSources >= 1)
    assert.ok(logs.some(line => /source limit reached/.test(line)))
  } finally { await fixture.close() }
})

test('oversized sitemap response and crawler URL queue are bounded with visible outcomes', async () => {
  const fixture = await localServer((req, res) => {
    if (req.url === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<urlset>${'<url><loc>https://example.test/a</loc></url>'.repeat(20)}</urlset>`) }
    if (req.url === '/sitemap_index.xml') { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<a href="/a">A</a><a href="/b">B</a>')
  })
  try {
    const sitemapLogs = []
    await assert.rejects(safeFetch(`${fixture.url}/sitemap.xml`, { allowLocalFixtures: true, maxXmlBytes: 80 }).then(r => r.text()), /80-byte/)
    const metrics = {}, logs = []
    await new BuiltInDiscoveryAdapter().discover({ siteUrl: fixture.url, options: { allowLocalFixtures: true, maxPages: 1, maxQueuedUrls: 1, maxDepth: 1, concurrency: 1, requestDelay: 0, requestTimeoutMs: 2000, sitemapDiscovery: false, internalLinkCrawling: true }, signal: new AbortController().signal, onPage: async () => {}, onMetrics: async data => Object.assign(metrics, data), onLog: async line => logs.push(line), onStage: async () => {} })
    assert.equal(metrics.urlQueueTruncated, true)
    assert.ok(logs.some(line => /URL queue limit reached/.test(line)))
    assert.ok(sitemapLogs.length === 0)
  } finally { await fixture.close() }
})
