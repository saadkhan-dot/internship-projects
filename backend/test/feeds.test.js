import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { discoverFeedUrls, discoverFeeds, parseFeed } from '../src/discovery/feeds.js'

test('parses RSS entries and normalizes relative links with optional metadata', () => {
  const parsed = parseFeed('<rss><channel><item><title>One</title><link>/one</link><guid>id-1</guid><pubDate>Mon</pubDate><description>Summary</description></item><item><title>Two</title><link>/two</link></item></channel></rss>', 'https://site.test/feed.xml')
  assert.equal(parsed.kind, 'rss'); assert.equal(parsed.items.length, 2)
  assert.equal(parsed.items[0].url, 'https://site.test/one'); assert.equal(parsed.items[0].guid, 'id-1')
  assert.equal(parsed.items[1].title, 'Two'); assert.equal(parsed.items[1].description, '')
})

test('parses Atom, picks alternate HTML link, supports singleton entries and malformed XML', () => {
  const parsed = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:one</id><title>One</title><link rel="self" href="/feed"/><link href="/article" type="text/html"/><summary>Brief</summary><updated>2025-01-01</updated></entry></feed>', 'https://site.test/atom.xml')
  assert.equal(parsed.kind, 'atom'); assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].url, 'https://site.test/article'); assert.equal(parsed.items[0].guid, 'tag:one')
  assert.throws(() => parseFeed('<feed><entry>', 'https://site.test/feed'), /Malformed/)
})

test('finds autodiscovery links, rejects external links, falls back to common paths and deduplicates entries', async () => {
  const site = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end() }
    if (req.url === '/rss.xml') { res.setHeader('content-type', 'application/rss+xml'); return res.end('<rss><channel><item><guid>x</guid><link>/a</link></item><item><guid>x</guid><link>/b</link></item><item><link>/a</link></item></channel></rss>') }
    res.writeHead(404); res.end()
  })
  site.listen(0, '127.0.0.1'); await once(site, 'listening')
  const origin = `http://127.0.0.1:${site.address().port}`
  try {
    assert.deepEqual(discoverFeedUrls('<link rel="alternate" type="application/rss+xml" href="/rss.xml"><link rel="alternate" type="application/atom+xml" href="https://evil.test/feed">', `${origin}/`), [`${origin}/rss.xml`])
    const added = [], logs = []
    const result = await discoverFeeds(origin, '<html/>', { allowLocalFixtures: true, limits: { feedSources: 1, feedEntries: 10 }, log: async x => logs.push(x), robotsRules: () => true, addEntry: async entry => { added.push(entry.url); return added.length === 1 } })
    assert.equal(result.feedsDiscovered, 1); assert.equal(result.feedEntriesFound, 3); assert.equal(result.feedUrlsAdded, 1)
    assert.equal(result.duplicateEntriesIgnored, 2); assert.deepEqual(added, [`${origin}/a`])
    assert.ok(logs.some(x => /Feed limit reached/.test(x)))
  } finally { await new Promise(resolve => site.close(resolve)) }
})

test('feed entry limit and cancellation are honored', async () => {
  const feed = parseFeed('<rss><channel><item><link>/a</link></item><item><link>/b</link></item></channel></rss>', 'https://site.test/feed', { maxEntries: 1 })
  assert.equal(feed.items.length, 1); assert.equal(feed.truncated, true)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(discoverFeeds('https://site.test', '', { signal: controller.signal, robotsRules: () => true }), /cancel/i)
})
