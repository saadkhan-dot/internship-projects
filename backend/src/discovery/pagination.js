import { normalizeUrl, isPageUrl, sameHost } from './url.js'
import { cleanText } from '../extraction/normalization.js'

const NEXT_TEXT_PATTERN = /^\s*(?:next|next\s+page|›|»|>|siguiente|suivant|weiter)\s*$/i
const NEXT_ATTR_PATTERN = /\b(?:next|pagination-next|pager-next|next-page|page-numbers\s+next)\b/i

// Helper to extract page number from URL query or path
export function extractPageNumber(urlStr) {
  try {
    const parsed = new URL(urlStr)
    // Check query params: page, p, paged, pg, offset
    for (const param of ['page', 'p', 'paged', 'pg', 'page_num', 'pagenum']) {
      const val = parsed.searchParams.get(param)
      if (val && /^\d+$/.test(val)) return parseInt(val, 10)
    }
    // Check offset with limit (e.g. offset=20 when limit=10 -> page 3)
    const offset = parsed.searchParams.get('offset')
    if (offset && /^\d+$/.test(offset)) {
      return Math.floor(parseInt(offset, 10) / 10) + 1
    }
    // Check path: /page/2, /p/2, /page-2
    const pathMatch = parsed.pathname.match(/\/(?:page|p|pg)[/-](\d+)(?:\/|$)/i)
    if (pathMatch && pathMatch[1]) {
      return parseInt(pathMatch[1], 10)
    }
    return 1
  } catch {
    return 1
  }
}

export function discoverPaginationUrls($, currentUrl, siteUrl, options = {}) {
  const policy = options.queryParameterPolicy || 'preserve'
  const maxPaginationPages = options.maxPaginationPerDirectory ?? 5
  const currentPageNum = extractPageNumber(currentUrl)

  const candidates = []
  const seenUrls = new Set()

  const addCandidate = (rawHref, type, weight) => {
    if (!rawHref || typeof rawHref !== 'string') return
    const normalized = normalizeUrl(rawHref, currentUrl, policy)
    if (!normalized || !isPageUrl(normalized) || !sameHost(normalized, siteUrl)) return
    if (normalized === currentUrl || seenUrls.has(normalized)) return

    // Loop prevention: Avoid pagination URLs that navigate backward to page 1 if current is already > 1
    const targetPageNum = extractPageNumber(normalized)
    if (currentPageNum > 1 && targetPageNum < currentPageNum && targetPageNum === 1) return

    // Limit maximum pagination depth per directory sequence
    if (targetPageNum > maxPaginationPages + currentPageNum) return

    seenUrls.add(normalized)
    candidates.push({
      url: normalized,
      type,
      weight,
      pageNum: targetPageNum,
    })
  }

  // 1. rel="next" in <link> or <a> (Highest standard semantic signal)
  $('link[rel="next"], a[rel="next"]').each((_, el) => {
    addCandidate($(el).attr('href'), 'rel_next', 100)
  })

  // 2. Explicit "Next" button or link
  $('a').each((_, el) => {
    const $a = $(el)
    const text = cleanText($a.text())
    const ariaLabel = $a.attr('aria-label') || ''
    const title = $a.attr('title') || ''
    const className = $a.attr('class') || ''
    const rel = $a.attr('rel') || ''

    if (rel === 'next') return // Already checked

    const isNextText = NEXT_TEXT_PATTERN.test(text)
    const isNextAria = NEXT_ATTR_PATTERN.test(ariaLabel) || NEXT_ATTR_PATTERN.test(title)
    const isNextClass = NEXT_ATTR_PATTERN.test(className)

    if (isNextText || isNextAria || isNextClass) {
      addCandidate($a.attr('href'), 'next_link', 90)
    }
  })

  // 3. Numbered pagination links inside a dedicated pagination container
  const paginationContainers = $('.pagination, .pager, nav[aria-label*="pagination" i], [class*="pagination" i], [class*="pager" i], [class*="page-numbers" i], ul.page-numbers')
  if (paginationContainers.length > 0) {
    paginationContainers.find('a[href]').each((_, el) => {
      const $a = $(el)
      const text = cleanText($a.text())
      if (/^\d+$/.test(text)) {
        const pageNum = parseInt(text, 10)
        // Only consider forward pages (e.g. current + 1, current + 2)
        if (pageNum > currentPageNum && pageNum <= currentPageNum + 3) {
          const weight = pageNum === currentPageNum + 1 ? 85 : 70 - (pageNum - currentPageNum) * 5
          addCandidate($a.attr('href'), 'numbered_pagination', weight)
        }
      }
    })
  }

  // Sort by weight descending, then pageNum ascending
  candidates.sort((a, b) => b.weight - a.weight || a.pageNum - b.pageNum)

  // Return the immediate next page and up to 2 forward pages to avoid flooding the crawl queue
  return candidates.slice(0, 3).map(c => c.url)
}
