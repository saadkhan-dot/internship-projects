import { normalizeUrl } from '../discovery/url.js'

export const EXTRACTION_VERSION = 'deterministic-1'
const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

const DISALLOWED_NAME_TOKENS = new Set([
  'text', 'string', 'boolean', 'integer', 'number', 'date', 'datetime', 'time',
  'url', 'uri', 'postaladdress', 'thing', 'property', 'enumeration', 'array',
  'object', 'null', 'undefined', 'unknown', 'n/a', 'na', 'not available', 'none',
  'true', 'false', 'type', 'class', 'id', 'void', 'float', 'double', 'char',
  'byte', 'symbol', 'function', 'any', 'example', 'sample', 'test', 'demo',
  'item', 'node', 'value', 'data', 'content', 'element', 'field', 'parameter',
  'documentation', 'doc', 'code', 'snippet', 'schema', 'description'
])

export const GENERIC_EXCLUSION_PHRASES = new Set([
  'contact us', 'contact', 'contacts', 'contact details', 'contact info', 'contact information',
  'get in touch', 'reach out', 'write to us', 'send a message', 'message us', 'connect with us', 'call us',
  'about us', 'about', 'about our company', 'who we are', 'our story', 'our mission', 'overview', 'company overview',
  'our team', 'meet our team', 'meet the team', 'the team', 'leadership team', 'our people', 'people', 'team',
  'executive team', 'board of directors', 'management team', 'our leadership', 'advisory board', 'staff directory', 'team members',
  'careers', 'jobs', 'open positions', 'join us', 'join our team', 'work with us', 'we are hiring', 'employment', 'opportunities',
  'privacy policy', 'terms of service', 'terms and conditions', 'terms of use', 'disclaimer', 'cookie policy', 'legal notice', 'copyright', 'all rights reserved',
  'frequently asked questions', 'faq', 'faqs', 'help center', 'knowledge base', 'help',
  'support', 'customer support', 'technical support', 'customer service',
  'sales', 'marketing', 'administration', 'human resources', 'billing', 'finance', 'accounting',
  'press', 'media', 'public relations', 'general inquiries', 'investor relations', 'operations', 'legal',
  'home', 'menu', 'navigation', 'search', 'login', 'sign in', 'sign up', 'register', 'subscribe', 'newsletter',
  'submit', 'read more', 'learn more', 'view more', 'click here', 'see more', 'back to top',
  'bio', 'biography', 'profile', 'overview', 'summary', 'background', 'experience', 'education', 'publications',
  'credentials', 'awards', 'achievements', 'career', 'introduction', 'description', 'details', 'contact', 'address',
  'speaking', 'interviews', 'talks', 'articles'
])

export const GENERIC_HEADING_PATTERNS = [
  /^(?:contact|about|meet|our|join)\s+(?:us|the\s+team|our\s+team|the\s+people|our\s+people)\b/i,
  /^(?:privacy\s+policy|terms\s+(?:of\s+(?:service|use)|and\s+conditions)|cookie\s+policy|legal\s+notice|frequently\s+asked\s+questions)\b/i,
  /^(?:get\s+in\s+touch|reach\s+out(?:\s+to\s+us)?|work\s+with\s+us|who\s+we\s+are)\b/i,
  /^(?:customer\s+support|technical\s+support|customer\s+service|general\s+inquiries|human\s+resources|investor\s+relations)\b/i,
  /^(?:leadership\s+team|executive\s+team|management\s+team|board\s+of\s+directors|advisory\s+board|staff\s+directory)\b/i,
]

const ORGANIZATIONAL_SUFFIX_PATTERN = /\b(?:department|division|team|center|group|office|headquarters|committee|council|board|associates|llc|inc|corp|corporation|ltd|limited|gmbh|co\.)\s*$/i

const SINGLE_WORD_DEPARTMENT_SET = new Set([
  'support', 'sales', 'marketing', 'administration', 'careers', 'jobs', 'billing', 'finance',
  'legal', 'operations', 'engineering', 'press', 'media', 'team', 'staff', 'people', 'leadership',
  'contact', 'contacts', 'about', 'services', 'solutions', 'products', 'resources', 'company',
  'blog', 'news', 'events', 'pricing', 'faq', 'faqs', 'disclaimer', 'copyright'
])

const ROLE_KEYWORD_PATTERN = /\b(?:director|officer|manager|lead|leader|engineer|head|vp|vice\s+president|president|founder|co-founder|cofounder|chief|ceo|cto|cfo|cmo|coo|cio|ciso|counsel|attorney|lawyer|partner|principal|associate|coordinator|administrator|consultant|specialist|developer|designer|fellow|analyst|strategist|technician|assistant|professor|lecturer|instructor|teacher|chair|chairperson|treasurer|secretary|board\s+member|member|trustee|editor|producer|architect|advisor|adviser|scientist|researcher|representative|agent|advocate|curator|intern|liaison|practitioner|physician|surgeon|nurse|therapist|coach|executive|operator|supervisor|contributor|staff|auditor|recruiter|buyer|clerk|aide|expert|mathematician|statistician|physicist|chemist|biologist|economist|programmer|author|writer|artist|photographer)\b/i

export function cleanText(value) {
  if (value == null) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text || null
}

export function isValidPersonName(value) {
  const name = cleanText(value)
  if (!name || name.length < 2 || name.length > 70) return false

  // Reject punctuation typical of code, data structures, formulas or URLs
  if (/[{}[\]()<>\/\\|*&=+@#$%^~;:`]/.test(name)) return false
  // Reject if contains digits
  if (/\d/.test(name)) return false

  const lower = name.toLowerCase()
  const normalizedPhrase = lower.replace(/[^\w\s'-]/g, '').replace(/\s+/g, ' ').trim()

  if (DISALLOWED_NAME_TOKENS.has(lower) || DISALLOWED_NAME_TOKENS.has(normalizedPhrase)) return false

  // Reject compound type strings like "PostalAddress or Text", "String or URL"
  if (/\b(?:or|and)\b/i.test(name)) {
    const parts = lower.split(/\s+(?:or|and)\s+/)
    if (parts.some(p => DISALLOWED_NAME_TOKENS.has(p))) return false
  }

  // Reject generic website navigation, CTAs, headings, legal policies
  if (GENERIC_EXCLUSION_PHRASES.has(lower) || GENERIC_EXCLUSION_PHRASES.has(normalizedPhrase)) return false
  if (GENERIC_HEADING_PATTERNS.some(pat => pat.test(name) || pat.test(normalizedPhrase))) return false

  // Reject single-word department/organizational labels
  if (SINGLE_WORD_DEPARTMENT_SET.has(lower) || SINGLE_WORD_DEPARTMENT_SET.has(normalizedPhrase)) return false

  // Reject organizational / corporate entity suffixes (e.g., "Marketing Team", "Sales Department", "Acme LLC")
  if (ORGANIZATIONAL_SUFFIX_PATTERN.test(name)) return false

  // Reject common sentence fragments or table headers
  if (/^(?:the|a|an|physical address|email address|telephone number|contact name)\b/i.test(lower)) return false

  // Must contain at least one letter
  if (!/[a-zA-Z\u00C0-\u024F]/.test(name)) return false

  return true
}

export function isValidDesignation(value, personName = null) {
  const title = cleanText(value)
  if (!title || title.length < 2 || title.length > 70) return false

  // Reject URLs, emails, phone numbers
  if (/@|https?:|\+?\d{7,}/.test(title)) return false

  // Reject punctuation typical of code, data structures, formulas
  if (/[{}[\]()<>\/\\|*&=+@#$%^~;:`]/.test(title)) return false

  const lower = title.toLowerCase().replace(/['’.-]/g, '').replace(/\s+/g, ' ').trim()

  // Reject generic website navigation / headings / technical tokens
  if (GENERIC_EXCLUSION_PHRASES.has(lower) || DISALLOWED_NAME_TOKENS.has(lower)) return false
  if (GENERIC_HEADING_PATTERNS.some(pat => pat.test(title))) return false

  // Cannot equal or contain the person's name
  if (personName) {
    const cleanPerson = cleanText(personName)
    if (cleanPerson) {
      const lowerPerson = cleanPerson.toLowerCase().replace(/['’.-]/g, '').replace(/\s+/g, ' ').trim()
      if (lower === lowerPerson) return false
      if (lower.includes(lowerPerson) || lowerPerson.includes(lower)) return false
    }
  }

  // Reject long narrative sentences or bio fragments
  const words = title.split(/\s+/)
  if (words.length > 8) return false
  if (/^(?:he|she|they|i|we|it|who|is|was|has|have|had|with|at|in|on|for)\b/i.test(title)) return false

  // If title looks like a person's name (2 or more words, passes isValidPersonName)
  // and does NOT contain any role indicator, it is likely a person name rather than a job designation
  const hasRoleIndicator = ROLE_KEYWORD_PATTERN.test(title)
  if (!hasRoleIndicator && words.length >= 2 && isValidPersonName(title)) {
    return false
  }

  // Must contain at least one letter
  if (!/[a-zA-Z\u00C0-\u024F]/.test(title)) return false

  return true
}

export function normalizeName(value) { return cleanText(value) }

export function normalizeEmail(value) {
  const email = cleanText(value)?.replace(/^mailto:/i, '').split('?')[0].trim()
  if (!email || email.length > 254 || !EMAIL.test(email)) return { value: null, original: email, validationStatus: 'invalid' }
  return { value: email.toLowerCase(), original: email, validationStatus: 'syntax_valid' }
}

export function normalizePhone(value) {
  const original = cleanText(value)?.replace(/^tel:/i, '') || null
  if (!original) return { value: null, normalized: null, original: null, validationStatus: 'missing' }
  // Reject year ranges like "1994-2010" or "2018 - 2022"
  if (/^(?:19|20)\d{2}\s*[-–—/]\s*(?:19|20)\d{2}$/.test(original.trim())) {
    return { value: null, normalized: null, original, validationStatus: 'invalid' }
  }
  const digits = original.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return { value: null, normalized: null, original, validationStatus: 'invalid' }
  const normalized = original.trim().startsWith('+') ? `+${digits}` : null
  return { value: original, normalized, original, validationStatus: normalized ? 'syntax_valid' : 'unverified' }
}

export function normalizeFax(value) {
  return normalizePhone(value)
}

export function normalizeHttpUrl(value, baseUrl) {
  const url = cleanText(value)
  if (!url) return null
  const normalized = normalizeUrl(url, baseUrl)
  return normalized || null
}

export function normalizeLinkedInUrl(value, baseUrl) {
  const normalized = normalizeHttpUrl(value, baseUrl)
  if (!normalized) return null
  try {
    const parsed = new URL(normalized)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null
    parsed.hostname = host
    return parsed.href
  } catch { return null }
}

/**
 * Extracts and canonicalizes the personal profile slug from a LinkedIn URL.
 * Returns null if the URL is not a personal LinkedIn profile (/in/ or legacy /pub/).
 * Company pages (/company/) and school pages (/school/) explicitly return null.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function parseLinkedInProfileSlug(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const withProto = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`
    const parsed = new URL(withProto)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null
    const match = parsed.pathname.match(/^\/(?:in|pub)\/([^/?#]+)/i)
    if (!match || !match[1]) return null
    const rawSlug = match[1].replace(/\/+$/, '')
    if (!rawSlug) return null
    try {
      return decodeURIComponent(rawSlug).trim().toLowerCase()
    } catch {
      return rawSlug.trim().toLowerCase()
    }
  } catch {
    const match = trimmed.match(/(?:linkedin\.com)\/(?:in|pub)\/([^/?#\s]+)/i)
    if (match && match[1]) {
      const rawSlug = match[1].replace(/\/+$/, '')
      try {
        return decodeURIComponent(rawSlug).trim().toLowerCase()
      } catch {
        return rawSlug.trim().toLowerCase()
      }
    }
    return null
  }
}

/**
 * Constructs a RegExp that matches a string case-insensitively with flexible whitespace between tokens.
 * Each token is independently escaped to prevent regex injection.
 *
 * @param {string} value
 * @returns {RegExp|null}
 */
export function makeWhitespaceFlexibleRegex(value) {
  if (!value || typeof value !== 'string') return null
  const tokens = value.trim().split(/\s+/).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!tokens.length) return null
  return new RegExp(`^${tokens.join('\\s+')}$`, 'i')
}

export function splitUnambiguousName(value) {
  const name = cleanText(value)
  if (!name || !isValidPersonName(name)) return { full_name: name || null, first_name: null, last_name: null }
  const tokens = name.split(' ')
  if (tokens.length !== 2) return { full_name: name, first_name: null, last_name: null }
  return { full_name: name, first_name: tokens[0], last_name: tokens[1] }
}

export function sourceDomain(sourceUrl) {
  try { return new URL(sourceUrl).hostname.toLowerCase() } catch { return null }
}
