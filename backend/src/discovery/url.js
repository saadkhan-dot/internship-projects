const NON_PAGE_EXTENSIONS = /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|json|m4a|m4v|mov|mp3|mp4|mpeg|odp|ods|odt|pdf|png|pptx?|rar|rss|svg|tar|ttf|txt|wav|webm|webp|woff2?|xlsx?|zip)$/i
const TRACKING_PARAMS = /^(?:utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid)$/i

export function normalizeUrl(input, base, policy = 'preserve') {
  try {
    if (typeof input !== 'string' || !input.trim()) return null
    const url = new URL(input.trim(), base || undefined)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = ''
    if (policy === 'remove-all') url.search = ''
    if (policy === 'remove-tracking') for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key)
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    return url.href
  } catch { return null }
}

export function isPageUrl(input) {
  try { const u = new URL(input); return ['http:', 'https:'].includes(u.protocol) && !NON_PAGE_EXTENSIONS.test(u.pathname) }
  catch { return false }
}

export function hostDomain(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '')
}

export function sameHost(input, origin) {
  try {
    const h1 = hostDomain(new URL(input).hostname)
    const h2 = hostDomain(new URL(origin).hostname)
    return Boolean(h1 && h1 === h2)
  }
  catch { return false }
}

export function normalizeWebsite(input) {
  let url = normalizeUrl(input)
  if (!url) return null
  const parsed = new URL(url)
  if (!parsed.pathname || parsed.pathname === '/') { parsed.pathname = '/' }
  return parsed.href
}
