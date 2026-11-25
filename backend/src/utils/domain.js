/**
 * Normalizes a URL or website string into a canonical domain.
 * Strips protocol, www., paths, query parameters, ports, and trailing slashes.
 * e.g. "https://www.example.com/about?ref=1" -> "example.com"
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return ''
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return ''

  try {
    const withProto = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`
    const parsed = new URL(withProto)
    let hostname = parsed.hostname.toLowerCase()
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4)
    }
    return hostname
  } catch {
    // Regex fallback
    return trimmed
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .split(':')[0]
      .trim()
  }
}
