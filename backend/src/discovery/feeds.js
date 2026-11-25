import * as cheerio from 'cheerio'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { normalizeUrl } from './url.js'
import { safeFetch, ResponseLimitError } from './fetch.js'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, trimValues: true })
const array = value => value == null ? [] : Array.isArray(value) ? value : [value]
const string = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''

export function discoverFeedUrls(html, pageUrl, limit = 5) {
  const $ = cheerio.load(html)
  const feeds = []
  for (const el of $('link[rel~="alternate"][href]').toArray()) {
    const type = String($(el).attr('type') || '').toLowerCase().split(';')[0].trim()
    if (!['application/rss+xml', 'application/atom+xml'].includes(type)) continue
    const url = normalizeUrl($(el).attr('href'), pageUrl)
    if (url && new URL(url).hostname === new URL(pageUrl).hostname && !feeds.includes(url)) feeds.push(url)
    if (feeds.length >= limit) break
  }
  return feeds
}

export function parseFeed(xml, feedUrl, { maxEntries = 500 } = {}) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed feed XML')
  let data
  try { data = parser.parse(xml) } catch { throw new Error('Malformed feed XML') }
  let entries = [], kind
  if (data.rss?.channel) { kind = 'rss'; entries = array(data.rss.channel.item) }
  else if (data.feed) { kind = 'atom'; entries = array(data.feed.entry) }
  else throw new Error('XML is not an RSS or Atom feed')
  const items = []
  for (const item of entries.slice(0, maxEntries)) {
    let link = ''
    if (kind === 'rss') link = string(item.link)
    else {
      const links = array(item.link)
      const chosen = links.find(x => (x?.['@_rel'] || 'alternate') === 'alternate' && (!x?.['@_type'] || /html/i.test(x['@_type']))) || links.find(x => (x?.['@_rel'] || 'alternate') === 'alternate') || links[0]
      link = string(chosen?.['@_href'])
    }
    const url = normalizeUrl(link, feedUrl)
    const title = string(item.title?.['#text'] ?? item.title)
    const summary = string(item.description?.['#text'] ?? item.description ?? item.summary?.['#text'] ?? item.summary ?? item.content?.['#text'] ?? item.content)
    const publishedAt = string(item.pubDate ?? item.published ?? item.updated ?? item.date)
    items.push({ title, url, guid: string(item.guid?.['#text'] ?? item.guid ?? item.id), publishedAt, description: summary, feedUrl })
  }
  return { kind, entryCount: entries.length, truncated: entries.length > maxEntries, items }
}

const commonPaths = ['/feed', '/feed/', '/feed.xml', '/rss.xml', '/rss', '/atom.xml', '/index.xml', '/blog/feed', '/blog/feed.xml', '/news/feed']

export async function discoverFeeds(siteUrl, homepageHtml, { signal, timeoutMs, beforeRequest = async () => {}, allowLocalFixtures = false, limits = {}, log = async () => {}, robotsRules = () => true, addEntry = async () => false } = {}) {
  const maxFeeds = limits.feedSources ?? 5, maxEntries = limits.feedEntries ?? 500, maxBytes = limits.maxFeedBytes ?? 1_000_000
  const origin = new URL(siteUrl).origin
  await log('RSS/Atom autodiscovery started')
  const discovered = discoverFeedUrls(homepageHtml, siteUrl, maxFeeds).filter(url => new URL(url).hostname === new URL(siteUrl).hostname)
  if (discovered.length) for (const url of discovered) await log(`Feed discovered: ${url}`)
  else {
    await log('No HTML feed links found; checking common feed paths')
    for (const path of commonPaths) {
      if (discovered.length >= maxFeeds) break
      const url = normalizeUrl(path, origin)
      if (!robotsRules(url) || discovered.includes(url)) continue
      await beforeRequest()
      try {
        const response = await safeFetch(url, { signal, timeoutMs, maxBytes, allowLocalFixtures, headers: { accept: 'application/rss+xml,application/atom+xml,application/feed+json,application/xml,text/xml;q=0.9,*/*;q=0.2' } })
        if (!response.ok || !/xml|rss|atom|feed\+json/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); continue }
        const body = await response.text()
        parseFeed(body, response.url, { maxEntries: 0 })
        discovered.push(url); await log(`Feed discovered: ${url}`)
      } catch (error) { if (signal?.aborted) throw error; if (error instanceof ResponseLimitError) await log(`Feed fetch failed (response limit): ${url}`) }
    }
  }
  let entriesFound = 0, added = 0, duplicates = 0
  const seenGuid = new Set(), seenUrl = new Set()
  for (const feedUrl of discovered.slice(0, maxFeeds)) {
    if (signal?.aborted) throw new Error('Scan cancelled')
    if (!robotsRules(feedUrl)) { await log(`Robots.txt disallows feed: ${feedUrl}`); continue }
    await beforeRequest()
    try {
      const response = await safeFetch(feedUrl, { signal, timeoutMs, maxBytes, allowLocalFixtures, headers: { accept: 'application/rss+xml,application/atom+xml,application/feed+json,application/xml,text/xml;q=0.9,*/*;q=0.2' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const parsed = parseFeed(await response.text(), response.url, { maxEntries })
      entriesFound += parsed.entryCount
      for (const entry of parsed.items) {
        if (!entry.url || new URL(entry.url).hostname !== new URL(siteUrl).hostname || !robotsRules(entry.url)) continue
        if ((entry.guid && seenGuid.has(entry.guid)) || seenUrl.has(entry.url)) { duplicates++; continue }
        if (entry.guid) seenGuid.add(entry.guid)
        seenUrl.add(entry.url)
        const wasAdded = await addEntry(entry)
        if (wasAdded) added++
      }
      await log(`Feed parsed: ${parsed.items.length} entries found (${added} new URLs)`)
      if (parsed.truncated) await log(`Feed entry limit reached (${maxEntries}): ${feedUrl}`)
    } catch (error) { if (signal?.aborted) throw error; await log(`Feed fetch failed (${error.message}): ${feedUrl}`) }
  }
  if (discovered.length >= maxFeeds) await log(`Feed limit reached (${maxFeeds})`)
  await log(`RSS discovery finished: ${discovered.length} feeds, ${entriesFound} entries, ${added} new URLs, ${duplicates} duplicates ignored`)
  return { feedsDiscovered: discovered.length, feedEntriesFound: entriesFound, feedUrlsAdded: added, duplicateEntriesIgnored: duplicates }
}
