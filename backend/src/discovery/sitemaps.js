import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { normalizeUrl } from './url.js'
import { ResponseLimitError, safeFetch } from './fetch.js'

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true })
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value]

export function parseSitemapXml(xml, baseUrl, { maxEntries = 20000, maxIndexChildren = 100 } = {}) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed sitemap XML')
  let parsed
  try { parsed = xmlParser.parse(xml) } catch { throw new Error('Malformed sitemap XML') }
  if (parsed.sitemapindex) {
    const entries = asArray(parsed.sitemapindex.sitemap)
    return { kind: 'index', urls: entries.slice(0, maxIndexChildren).map(x => normalizeUrl(x?.loc, baseUrl)).filter(Boolean), truncated: entries.length > maxIndexChildren, entryCount: entries.length }
  }
  if (parsed.urlset) {
    const entries = asArray(parsed.urlset.url)
    return { kind: 'urlset', urls: entries.slice(0, maxEntries).map(x => normalizeUrl(x?.loc, baseUrl)).filter(Boolean), truncated: entries.length > maxEntries, entryCount: entries.length }
  }
  throw new Error('XML is not a sitemap index or URL set')
}

export async function discoverSitemaps(siteUrl, { signal, timeoutMs, log = async () => {}, sitemapUrls = [], beforeRequest = async () => {}, allowLocalFixtures = false, limits = {} } = {}) {
  const sourceLimit = limits.sitemapSources ?? 30
  const maxEntries = limits.sitemapEntries ?? 20000
  const maxIndexChildren = limits.sitemapIndexChildren ?? 100
  const maxXmlBytes = limits.maxSitemapBytes ?? 5_000_000
  const maxQueuedUrls = limits.maxQueuedUrls ?? 5000
  const origin = new URL(siteUrl).origin
  const attempted = new Set(), visited = new Set(), pages = new Map(), queue = []
  queue.push(...sitemapUrls.map(url => normalizeUrl(url, origin)))
  for (const path of ['/sitemap.xml', '/sitemap_index.xml']) queue.push(normalizeUrl(path, origin))
  let truncated = false, omittedSources = 0
  const truncationReasons = new Set()
  while (queue.length && visited.size < sourceLimit) {
    if (signal?.aborted) throw new Error('Scan cancelled')
    const sitemapUrl = queue.shift()
    if (!sitemapUrl || visited.has(sitemapUrl)) continue
    visited.add(sitemapUrl); attempted.add(sitemapUrl)
    try {
      await log(`Fetching sitemap ${sitemapUrl}`)
      await beforeRequest()
      const response = await safeFetch(sitemapUrl, { signal, timeoutMs, maxXmlBytes, allowLocalFixtures, headers: { accept: 'application/xml,text/xml,*/*;q=0.2' } })
      if (!response.ok) { await log(`Sitemap returned HTTP ${response.status}: ${sitemapUrl}`); continue }
      const text = await response.text()
      const result = parseSitemapXml(text, sitemapUrl, { maxEntries, maxIndexChildren })
      if (result.truncated) {
        truncated = true
        const reason = result.kind === 'index' ? 'sitemap-index-child-limit' : 'sitemap-entry-limit'
        truncationReasons.add(reason)
        await log(`Sitemap entry limit reached (${result.kind === 'index' ? maxIndexChildren : maxEntries}) at ${sitemapUrl}`)
      }
      if (result.kind === 'index') {
        await log(`Sitemap index contains ${result.entryCount} child sitemaps; processing up to ${maxIndexChildren}`)
        omittedSources += Math.max(0, result.entryCount - result.urls.length)
        for (const child of result.urls) if (!visited.has(child) && !queue.includes(child)) queue.push(child)
      } else for (const url of result.urls) {
        if (pages.has(url)) continue
        if (pages.size >= maxQueuedUrls) { truncated = true; truncationReasons.add('url-queue-limit'); await log(`Sitemap URL queue limit reached (${maxQueuedUrls}); additional page URLs were not retained.`); break }
        pages.set(url, { url, sourceUrl: sitemapUrl })
      }
      await log(`Sitemap ${sitemapUrl} discovered ${result.kind === 'urlset' ? result.urls.length : 0} page URLs`)
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof ResponseLimitError) { truncated = true; truncationReasons.add('sitemap-response-size-limit'); await log(`Sitemap response size limit reached (${maxXmlBytes} bytes): ${sitemapUrl}`) }
      else await log(`Sitemap skipped (${error.message}): ${sitemapUrl}`)
    }
  }
  if (queue.length || omittedSources) { truncated = true; truncationReasons.add('sitemap-source-limit'); await log(`Sitemap source limit reached (${sourceLimit}); ${queue.length + omittedSources} child sitemap(s) remain unprocessed`) }
  return { pages: [...pages.values()], attempted: [...attempted], complete: !truncated, truncated, truncationReasons: [...truncationReasons], sourceLimit, remainingSources: queue.length + omittedSources }
}
