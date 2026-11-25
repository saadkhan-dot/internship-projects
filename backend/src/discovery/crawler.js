import * as cheerio from 'cheerio'
import { discoverSitemaps } from './sitemaps.js'
import { safeFetch } from './fetch.js'
import { isPageUrl, normalizeUrl, sameHost } from './url.js'
import { isAllowedByRobots, parseRobots } from './robots.js'
import { discoverFeeds } from './feeds.js'
import { extractCandidates } from '../extraction/candidateExtractor.js'
import { discoverPaginationUrls } from './pagination.js'

export const sleepWithSignal = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Scan cancelled'))
  let settled = false
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
  const finish = callback => { if (settled) return; settled = true; cleanup(); callback() }
  const onAbort = () => finish(() => reject(new Error('Scan cancelled')))
  const timer = setTimeout(() => finish(resolve), ms)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
})

export function isTransientError(error) {
  if (!error) return false
  if (error.name === 'CrawlCancelledError' || error.message === 'Scan cancelled') return false
  if (error.name === 'ResponseLimitError') return false
  if (error.message?.includes('prohibited or non-public address')) return false
  if (error.message?.includes('Invalid outbound URL')) return false
  if (error.message?.includes('Only HTTP and HTTPS')) return false

  const status = error.httpStatus
  if (status) {
    if ([500, 502, 503, 504, 429].includes(status)) return true
    if (status >= 400 && status < 500) return false
  }

  const code = error.code
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENOTFOUND'].includes(code)) {
    return true
  }

  if (/timed out/i.test(error.message) || /timeout/i.test(error.message) || /socket hang up/i.test(error.message)) {
    return true
  }

  return false
}

const PROFILE_PATH_PATTERN = /\b(team|about|people|leadership|management|staff|contact|executives|board|faculty|attorneys|employees|directory|our-team|about-us|author|bio|profile|member|members|speaker|speakers)\b/i
const PAGINATION_PATTERN = /[?&](?:page|p|paged|pg|offset)=\d+|\/(?:page|p)\/\d+/i

export const CRAWL_PRIORITY = {
  SEED: 100,
  PAGINATION: 80,
  PROFILE: 60,
  RELEVANT_INTERNAL: 40,
  GENERAL_INTERNAL: 20,
  RELEVANT_SITEMAP: 15,
  GENERIC_SITEMAP_OR_FEED: 10,
}

export function calculateUrlPriority({ url, source, depth = 0 }) {
  if (source === 'seed') return CRAWL_PRIORITY.SEED
  if (source === 'pagination') return CRAWL_PRIORITY.PAGINATION
  if (source === 'profile') return CRAWL_PRIORITY.PROFILE

  let pathname = ''
  let full = ''
  try {
    const parsed = new URL(url)
    pathname = parsed.pathname.toLowerCase()
    full = (pathname + parsed.search).toLowerCase()
  } catch {
    return CRAWL_PRIORITY.GENERIC_SITEMAP_OR_FEED
  }

  if (source === 'internal-link') {
    if (PAGINATION_PATTERN.test(full)) return CRAWL_PRIORITY.PAGINATION
    if (PROFILE_PATH_PATTERN.test(pathname)) return CRAWL_PRIORITY.RELEVANT_INTERNAL
    return CRAWL_PRIORITY.GENERAL_INTERNAL
  }

  if (source === 'sitemap' || source === 'rss') {
    if (PROFILE_PATH_PATTERN.test(pathname)) return CRAWL_PRIORITY.RELEVANT_SITEMAP
    return CRAWL_PRIORITY.GENERIC_SITEMAP_OR_FEED
  }

  return CRAWL_PRIORITY.GENERAL_INTERNAL
}

export function urlPriority(item) {
  return calculateUrlPriority(item)
}

export class BuiltInDiscoveryAdapter {
  async discover({ siteUrl, options, signal, onStage, onLog, onPage, onMetrics, onCandidate = async () => true }) {
    const origin = new URL(siteUrl).origin
    const visited = new Set(), inProgress = new Set(), blocked = new Set(), queued = new Map()
    const limits = { maxHtmlBytes: options.maxHtmlBytes ?? 2_000_000, maxSitemapBytes: options.maxSitemapBytes ?? 5_000_000, maxQueuedUrls: options.maxQueuedUrls ?? options.maxPages }
    let queueTruncated = false
    let discoveryOrder = 0
    const policy = options.queryParameterPolicy || 'preserve'
    let lastRequestAt = 0, requestGate = Promise.resolve()
    const beforeRequest = async () => {
      let release
      const previous = requestGate
      requestGate = new Promise(resolve => { release = resolve })
      await previous
      try {
        const delayMs = Math.max(options.requestDelay * 1000, robots.crawlDelay * 1000)
        const wait = Math.max(0, delayMs - (Date.now() - lastRequestAt))
        if (wait) await sleepWithSignal(wait, signal)
        lastRequestAt = Date.now()
      } finally { release() }
    }
    const add = async (input, { source, sourceUrl, depth, feedMetadata = {} }) => {
      const url = normalizeUrl(input, siteUrl, policy)
      if (!url || !isPageUrl(url) || !sameHost(url, siteUrl) || visited.has(url) || blocked.has(url)) return false
      const priority = calculateUrlPriority({ url, source, depth })

      if (queued.has(url)) {
        const existing = queued.get(url)
        let upgraded = false
        if (priority > existing.priority) {
          existing.priority = priority
          existing.source = source
          upgraded = true
        }
        if (depth < existing.depth) {
          existing.depth = depth
          upgraded = true
        }
        return upgraded
      }

      if (queued.size >= limits.maxQueuedUrls) {
        let minCandidate = null
        for (const item of queued.values()) {
          if (visited.has(item.normalizedUrl) || blocked.has(item.normalizedUrl) || inProgress.has(item.normalizedUrl)) continue
          if (item.source === 'seed') continue
          if (!minCandidate || item.priority < minCandidate.priority || (item.priority === minCandidate.priority && item.order > minCandidate.order)) {
            minCandidate = item
          }
        }
        if (minCandidate && priority > minCandidate.priority) {
          queued.delete(minCandidate.normalizedUrl)
        } else {
          queueTruncated = true
          return false
        }
      }

      const record = { url, normalizedUrl: url, source, sourceUrl: sourceUrl || '', depth, priority, order: ++discoveryOrder, ...feedMetadata }
      queued.set(url, record)
      await onPage(record)
      await onMetrics({ urlsDiscovered: queued.size })
      return true
    }

    await onStage('robots')
    let robots = { rules: [], crawlDelay: 0, sitemaps: [] }
    try {
      await onLog(`Fetching robots.txt at ${origin}/robots.txt`)
      const response = await safeFetch(`${origin}/robots.txt`, { signal, timeoutMs: options.requestTimeoutMs, maxBytes: 65536, allowLocalFixtures: options.allowLocalFixtures, headers: { accept: 'text/plain,*/*;q=0.2' } })
      if (response.ok) robots = parseRobots(await response.text())
      else await onLog(`robots.txt returned HTTP ${response.status}; continuing with default allow rules`)
    } catch (error) { if (signal.aborted) throw error; await onLog(`robots.txt unavailable: ${error.message}; continuing with default allow rules`) }
    await onMetrics({ robotsRules: robots.rules.length })
    await add(siteUrl, { source: 'seed', sourceUrl: '', depth: 0 })

    if (options.sitemapDiscovery) {
      await onStage('sitemaps')
      const maps = await discoverSitemaps(siteUrl, { signal, timeoutMs: options.requestTimeoutMs, log: onLog, sitemapUrls: robots.sitemaps, beforeRequest, allowLocalFixtures: options.allowLocalFixtures, limits })
      await onLog(`Sitemap discovery finished: ${maps.pages.length} unique page URLs from ${maps.attempted.length} sitemap sources`)
      if (maps.truncated) await onLog(`Sitemap discovery was incomplete (${maps.truncationReasons.join(', ')}); ${maps.remainingSources} source(s) remain.`)
      await onMetrics({ sitemapDiscovery: { complete: maps.complete, truncated: maps.truncated, sourceLimit: maps.sourceLimit, remainingSources: maps.remainingSources } })
      for (const page of maps.pages) await add(page.url, { source: 'sitemap', sourceUrl: page.sourceUrl, depth: 0 })
    }

    if (options.feedDiscovery !== false) {
      await onStage('feeds')
      try {
        await beforeRequest()
        const response = await safeFetch(siteUrl, { signal, timeoutMs: options.requestTimeoutMs, maxHtmlBytes: limits.maxHtmlBytes, allowLocalFixtures: options.allowLocalFixtures, headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2' } })
        if (response.ok && /html|xhtml/i.test(response.headers.get('content-type') || '')) {
          const html = await response.text()
          const metrics = await discoverFeeds(siteUrl, html, { signal, timeoutMs: options.requestTimeoutMs, beforeRequest, allowLocalFixtures: options.allowLocalFixtures, limits: options, log: onLog, robotsRules: url => isAllowedByRobots(url, robots.rules), addEntry: entry => add(entry.url, { source: 'rss', sourceUrl: entry.feedUrl, depth: 0, feedMetadata: { title: entry.title, description: entry.description, publishedAt: entry.publishedAt, feedGuid: entry.guid } }) })
          await onMetrics({ rssDiscovery: metrics })
        } else { await response.body?.cancel(); await onLog('RSS autodiscovery skipped because homepage did not return HTML') }
      } catch (error) { if (signal.aborted) throw error; await onLog(`RSS autodiscovery failed (${error.message}); continuing with other discovery sources`) }
    }

    if (!options.internalLinkCrawling) {
      if (queueTruncated) {
        await onLog(`URL queue limit reached (${limits.maxQueuedUrls}); additional URLs were not queued.`)
        await onMetrics({ urlQueueTruncated: true, maxQueuedUrls: limits.maxQueuedUrls })
      }
      await onMetrics({ urlsProcessed: queued.size, urlsDiscovered: queued.size, totalKnown: queued.size })
      return
    }
    await onStage('crawling')
    const getNextItem = () => {
      if (visited.size + inProgress.size >= options.maxPages) return null
      let best = null
      for (const item of queued.values()) {
        if (visited.has(item.normalizedUrl) || blocked.has(item.normalizedUrl) || inProgress.has(item.normalizedUrl)) continue
        if (item.depth > options.maxDepth) continue
        if (!best) {
          best = item
          continue
        }
        if (item.priority > best.priority) {
          best = item
        } else if (item.priority === best.priority) {
          if (item.depth < best.depth) {
            best = item
          } else if (item.depth === best.depth && item.order < best.order) {
            best = item
          }
        }
      }
      if (best) {
        inProgress.add(best.normalizedUrl)
      }
      return best
    }

    const concurrency = Math.max(1, Math.min(options.concurrency || 1, 5))
    const worker = async () => {
      while (!signal.aborted) {
        if (visited.size >= options.maxPages) break
        const item = getNextItem()
        if (!item) {
          if (inProgress.size > 0) {
            await sleepWithSignal(50, signal)
            continue
          }
          break
        }
        try {
          if (!isAllowedByRobots(item.url, robots.rules)) {
            blocked.add(item.normalizedUrl)
            await onLog(`Robots.txt disallows ${item.url}`)
            await onPage({ ...item, processingStatus: 'blocked' })
            await onMetrics({ pagesAttempted: 0, urlsProcessed: 1, urlsDiscovered: queued.size, totalKnown: queued.size })
            continue
          }
          await beforeRequest()
          await onMetrics({ pagesAttempted: 1, currentUrl: item.url, urlsDiscovered: queued.size, totalKnown: queued.size })

          let response = null
          let html = null
          let fetchError = null
          const maxRetries = options.maxPageRetries !== undefined ? options.maxPageRetries : (options.retryTransientErrors ? 2 : 1)

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (signal.aborted) return
            try {
              if (attempt > 0) {
                const backoffMs = Math.min(1000, 100 * (2 ** (attempt - 1)))
                await sleepWithSignal(backoffMs, signal)
                await beforeRequest()
                await onLog(`Retrying transient error (attempt ${attempt}/${maxRetries}): ${item.url}`)
              }
              response = await safeFetch(item.url, { signal, timeoutMs: options.requestTimeoutMs, maxHtmlBytes: limits.maxHtmlBytes, allowLocalFixtures: options.allowLocalFixtures })
              const contentType = response.headers.get('content-type') || ''
              if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { httpStatus: response.status, contentType })
              if (!contentType.toLowerCase().includes('text/html') && !contentType.toLowerCase().includes('application/xhtml+xml')) {
                await response.body?.cancel()
                visited.add(item.normalizedUrl)
                await onPage({ ...item, httpStatus: response.status, contentType, processingStatus: 'blocked' })
                await onMetrics({ pagesFetched: 1, urlsProcessed: 1, extractionPagesSkipped: 1 })
                await onLog(`Skipped non-HTML response (${contentType || 'unknown type'}): ${item.url}`)
                response = null
                break
              }
              html = await response.text()
              fetchError = null
              break
            } catch (err) {
              fetchError = err
              if (signal.aborted) return
              if (attempt < maxRetries && isTransientError(err)) {
                continue
              }
              break
            }
          }

          if (fetchError) {
            visited.add(item.normalizedUrl)
            if (fetchError.name === 'ResponseLimitError') await onLog(`Page skipped because it exceeded the HTML response limit: ${item.url}`)
            await onPage({ ...item, httpStatus: fetchError.httpStatus, contentType: fetchError.contentType, processingStatus: 'failed' })
            await onMetrics({ failedRequests: 1, urlsProcessed: 1 })
            await onLog(`Request failed for ${item.url}: ${fetchError.message}`)
            continue
          }

          if (!response || !html) {
            continue
          }

          visited.add(item.normalizedUrl)
          await onPage({ ...item, httpStatus: response.status, contentType: response.headers.get('content-type') || '', processingStatus: 'fetched' })
          await onMetrics({ pagesFetched: 1, urlsProcessed: 1 })
          await onLog(`Fetched page ${item.url} (HTTP ${response.status})`)
          let extractionErrors = 0
          let persistedCandidates = 0
          let parsedResult = null
          try {
            const { candidates, parsed } = extractCandidates(html, { sourceUrl: item.url, contentType: response.headers.get('content-type') || '', extractedAt: new Date() })
            parsedResult = parsed
            for (const candidate of candidates) {
              try { if (await onCandidate(candidate)) persistedCandidates++ }
              catch (error) {
                extractionErrors++
                await onLog(`Candidate persistence failed for ${new URL(item.url).origin} (${error.name || 'error'}).`)
              }
            }
            await onMetrics({ extractionPagesProcessed: 1, candidatesFound: persistedCandidates, extractionErrors })
            await onLog(`Extraction processed page ${new URL(item.url).origin}; ${persistedCandidates} candidate(s) saved.`)
          } catch (error) {
            extractionErrors++
            await onMetrics({ extractionErrors: 1 })
            await onLog(`Extraction failed for ${new URL(item.url).origin} (${error.name || 'error'}).`)
          }
          if (item.depth < options.maxDepth) {
            const $ = cheerio.load(html)

            // 1. Prioritize discovered profile links from extracted candidates
            if (parsedResult?.entities) {
              for (const entity of parsedResult.entities) {
                const profUrl = entity.fields?.profile_url
                if (profUrl && sameHost(profUrl, siteUrl) && isPageUrl(profUrl)) {
                  await add(profUrl, { source: 'profile', sourceUrl: item.url, depth: item.depth + 1 })
                }
              }
            }

            // 2. Discover controlled pagination URLs if this is a directory or has multiple candidates
            if (parsedResult?.directory?.isDirectory || persistedCandidates >= 2 || parsedResult?.directory?.hasPagination) {
              const paginationUrls = discoverPaginationUrls($, item.url, siteUrl, {
                queryParameterPolicy: policy,
                maxPaginationPerDirectory: options.maxPaginationPerDirectory ?? 5,
              })
              for (const pagUrl of paginationUrls) {
                await add(pagUrl, { source: 'pagination', sourceUrl: item.url, depth: item.depth + 1 })
              }
            }

            // 3. General internal links discovery
            for (const element of $('a[href]').toArray()) {
              const href = $(element).attr('href')
              const discovered = normalizeUrl(href, item.url, policy)
              if (discovered && sameHost(discovered, siteUrl) && isPageUrl(discovered)) {
                await add(discovered, { source: 'internal-link', sourceUrl: item.url, depth: item.depth + 1 })
              }
            }
          }
        } finally {
          inProgress.delete(item.normalizedUrl)
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
    if (signal.aborted) throw new Error('Scan cancelled')
    if (queueTruncated) {
      await onLog(`URL queue limit reached (${limits.maxQueuedUrls}); additional URLs were not queued.`)
      await onMetrics({ urlQueueTruncated: true, maxQueuedUrls: limits.maxQueuedUrls })
    }
    await onMetrics({ totalKnown: visited.size + blocked.size })
  }
}
