import { cleanText, isValidPersonName, GENERIC_EXCLUSION_PHRASES } from './normalization.js'

const DIRECTORY_HEADING_PATTERNS = [
  { type: 'faculty', pattern: /\b(?:faculty|professors|academic\s*staff|instructors|teachers|researchers)\b/i },
  { type: 'staff', pattern: /\b(?:staff\s*directory|employee\s*directory|personnel\s*directory|our\s*staff|meet\s*(?:the|our)\s*staff)\b/i },
  { type: 'leadership', pattern: /\b(?:leadership\s*team|executive\s*team|executives|management\s*team|board\s*of\s*directors|advisory\s*board|officers)\b/i },
  { type: 'team', pattern: /\b(?:our\s*team|meet\s*(?:the|our)\s*team|the\s*team|meet\s*our\s*people|our\s*people|team\s*members)\b/i },
  { type: 'members', pattern: /\b(?:member\s*directory|members\s*list|directory\s*of\s*members|partner\s*directory)\b/i },
  { type: 'attorneys', pattern: /\b(?:our\s*attorneys|attorney\s*directory|our\s*lawyers|our\s*partners)\b/i },
  { type: 'doctors', pattern: /\b(?:find\s*a\s*doctor|our\s*physicians|medical\s*staff|our\s*providers)\b/i },
]

const NEGATIVE_CONTENT_PATTERNS = [
  /\b(?:job\s*openings|open\s*positions|career\s*opportunities|apply\s*now|job\s*description|how\s*to\s*apply|responsibilities\s*and\s*requirements)\b/i,
  /\b(?:our\s*services|pricing\s*plans|terms\s*of\s*service|privacy\s*policy|cookie\s*policy|acceptable\s*use)\b/i,
  /\b(?:frequently\s*asked\s*questions|faq|knowledge\s*base)\b/i,
]

export function detectDirectoryPage($, html, sourceUrl, entities = []) {
  const result = {
    isDirectory: false,
    directoryType: null,
    confidence: 0,
    personCount: 0,
    hasRepeatedCards: false,
    hasPersonnelTable: false,
    hasPagination: false,
  }

  // Count valid person entities already identified on this page
  const personEntities = entities.filter(e => e.candidateType === 'person' && e.fields?.full_name && isValidPersonName(e.fields.full_name))
  result.personCount = personEntities.length

  // Check URL context
  let urlScore = 0
  let urlType = null
  try {
    const pathname = new URL(sourceUrl).pathname.toLowerCase()
    for (const { type, pattern } of DIRECTORY_HEADING_PATTERNS) {
      if (pattern.test(pathname)) {
        urlScore += 2
        urlType = type
        break
      }
    }
    if (/\b(?:directory|staff|team|faculty|people|leadership|members|attorneys|doctors|employees)\b/i.test(pathname)) {
      urlScore += 1
    }
  } catch { /* ignore URL parse error */ }

  // Check Page Title and Headings
  const title = cleanText($('title').first().text()) || ''
  const h1 = cleanText($('h1').first().text()) || ''
  const h2s = $('h2').toArray().map(el => cleanText($(el).text())).join(' ')

  let headingScore = 0
  let headingType = null

  const headingText = `${title} ${h1} ${h2s}`
  for (const { type, pattern } of DIRECTORY_HEADING_PATTERNS) {
    if (pattern.test(h1) || pattern.test(title)) {
      headingScore += 3
      headingType = type
      break
    } else if (pattern.test(h2s)) {
      headingScore += 1
      if (!headingType) headingType = type
    }
  }

  // Check for negative signals (Jobs, Services, Legal, FAQs)
  const bodyText = cleanText($('body').text()) || ''
  let negativeScore = 0
  for (const pattern of NEGATIVE_CONTENT_PATTERNS) {
    if (pattern.test(h1) || pattern.test(title)) {
      negativeScore += 5
    } else if (pattern.test(bodyText.slice(0, 3000))) {
      negativeScore += 2
    }
  }

  // Check for Navigation Menu false positive:
  // If the word "team" or "staff" appears ONLY inside <nav> or header, but body has no person records
  const inNavOnly = personEntities.length === 0 &&
    $('main, article, #content, .content, [role="main"]').text().length > 100 &&
    !DIRECTORY_HEADING_PATTERNS.some(({ pattern }) => pattern.test($('main, article, #content, .content, [role="main"]').find('h1, h2, h3').text()))

  if (inNavOnly) {
    negativeScore += 4
  }

  // Check structural signals: Personnel tables
  const personnelTable = $('table').toArray().some(tbl => {
    const ths = $(tbl).find('th, td').toArray().map(el => $(el).text().trim()).join(' ').toLowerCase()
    return /\b(?:name|staff|faculty|employee)\b/i.test(ths) && /\b(?:title|role|position|department|email|phone)\b/i.test(ths)
  })
  if (personnelTable) {
    result.hasPersonnelTable = true
  }

  // Check structural signals: Repeated person cards
  const cardElements = $('[class*="member" i], [class*="team-item" i], [class*="person" i], [class*="profile-card" i], [class*="staff" i], [class*="bio-card" i]')
  if (cardElements.length >= 3) {
    result.hasRepeatedCards = true
  }

  // Check for pagination element
  const paginationElements = $('[class*="pagination" i], [class*="pager" i], nav[role="navigation"][aria-label*="pagination" i], a[rel="next"], link[rel="next"]')
  if (paginationElements.length > 0) {
    result.hasPagination = true
  }

  // Calculate final confidence score
  let score = 0

  // 1. Person entities are the strongest structural proof
  if (result.personCount >= 3) {
    score += 5
  } else if (result.personCount === 2) {
    score += 3
  } else if (result.personCount === 1) {
    score += 1
  }

  // 2. Structural indicators
  if (result.hasPersonnelTable) score += 3
  if (result.hasRepeatedCards) score += 2
  if (result.hasPagination) score += 1

  // 3. Contextual indicators
  score += headingScore
  score += urlScore

  // 4. Deduct negative signals
  score -= negativeScore

  // Directory decision threshold:
  // Must have at least 2 person entities, OR 1 person entity + strong directory heading/table,
  // AND must not be dominated by negative signals (e.g. job listings or navigation menus).
  if (score >= 4 && result.personCount >= 2 && negativeScore < 4) {
    result.isDirectory = true
    result.confidence = Math.min(10, score)
    result.directoryType = headingType || urlType || 'general'
  } else if (score >= 6 && result.hasPersonnelTable && result.personCount >= 1 && negativeScore < 4) {
    result.isDirectory = true
    result.confidence = Math.min(10, score)
    result.directoryType = headingType || urlType || 'faculty'
  }

  return result
}
