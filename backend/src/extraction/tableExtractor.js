import * as cheerio from 'cheerio'
import {
  cleanText,
  EXTRACTION_VERSION,
  isValidPersonName,
  isValidDesignation,
  normalizeEmail,
  normalizePhone,
  normalizeHttpUrl,
  normalizeLinkedInUrl,
  GENERIC_EXCLUSION_PHRASES,
  GENERIC_HEADING_PATTERNS
} from './normalization.js'

const MAX_EVIDENCE = 180
const evidence = value => cleanText(value)?.slice(0, MAX_EVIDENCE) || null

const HEADER_ROLE_PATTERNS = {
  phone: /^(?:contact\s*phone|phone|telephone|tel|ext(?:ension)?|office\s*phone|direct(?:\s*line)?|mobile|cell|work\s*phone)$/i,
  email: /^(?:e-?mail|email\s*address|e-mail\s*address|contact\s*email)$/i,
  name: /^(?:name|full\s*name|employee(?:\s*name)?|staff(?:\s*name)?|faculty(?:\s*name)?|member(?:\s*name)?|person|individual|contact(?:\s*name)?|provider|attorney|doctor|speaker)$/i,
  designation: /^(?:title|job\s*title|position|role|designation|rank|occupation|professional\s*title|faculty\s*rank|academic\s*title)$/i,
  department: /^(?:department|dept|division|unit|office|section|specialty|group|program)$/i,
  profile: /^(?:profile|bio|biography|details|page|link|view|cv|more\s*info|curriculum\s*vitae)$/i,
  linkedin: /^(?:linkedin|linkedin\s*profile|social)$/i,
}

const NON_PERSONNEL_TABLE_PATTERNS = /\b(?:pricing|price|tier|invoice|cart|payment|order|specs|specifications|features|comparison|schedule|timetable|metrics|statistics)\b/i

// Check if a header text matches any role
function classifyColumnHeader(headerText) {
  const normalized = cleanText(headerText)?.toLowerCase().replace(/\s+/g, ' ').replace(/[:*#]$/, '').trim()
  if (!normalized) return null

  // 1. Direct regex match against known roles (order matters: phone and email before name so "contact phone" -> phone)
  for (const [role, pattern] of Object.entries(HEADER_ROLE_PATTERNS)) {
    if (pattern.test(normalized)) return role
  }

  // 2. Substring checks for composite headers
  if (/\b(?:phone|tel|telephone)\b/i.test(normalized) && !/\b(?:fax)\b/i.test(normalized)) {
    return 'phone'
  }
  if (/\b(?:e-?mail)\b/i.test(normalized)) {
    return 'email'
  }
  if (/\b(?:name|staff|faculty|employee)\b/i.test(normalized) && !/\b(?:company|department|org|dept|file|user|group|tier|item)\b/i.test(normalized)) {
    return 'name'
  }
  if (/\b(?:title|position|designation|role)\b/i.test(normalized) && !/\b(?:page|job\s*id|code|header)\b/i.test(normalized)) {
    return 'designation'
  }
  if (/\b(?:department|dept|division)\b/i.test(normalized)) {
    return 'department'
  }
  if (/\b(?:profile|biography|bio)\b/i.test(normalized)) {
    return 'profile'
  }
  return null
}

function isIgnoredRow(rowText, cellCount) {
  if (cellCount < 2) return true
  const lower = rowText.toLowerCase()
  if (/\b(?:total|subtotal|grand\s*total|showing\s+\d+|page\s+\d+\s+of\s+\d+|all\s+rights\s+reserved)\b/i.test(lower)) {
    return true
  }
  return false
}

export function extractPersonnelTables($, root, sourceUrl, entities) {
  const seenNames = new Set(
    entities
      .filter(e => e.candidateType === 'person' && e.fields?.full_name)
      .map(e => e.fields.full_name.toLowerCase())
  )

  root.find('table').each((_, table) => {
    const $table = $(table)

    // Ignore tables nested inside code, pre, navigation, footer
    if ($table.closest('nav, footer, aside, blockquote, code, pre, kbd, samp, [role="navigation"]').length > 0) {
      return
    }

    const tableClass = (($table.attr('class') || '') + ' ' + ($table.attr('id') || '')).toLowerCase()
    if (NON_PERSONNEL_TABLE_PATTERNS.test(tableClass)) {
      return
    }

    // 1. Analyze column headers
    let headerRow = $table.find('thead tr').first()
    if (!headerRow.length) {
      const firstTr = $table.find('tr').first()
      if (firstTr.find('th').length > 0) {
        headerRow = firstTr
      }
    }

    const columnMap = new Map() // index (number) -> role (string)
    let hasHeaderMapping = false

    if (headerRow.length) {
      const headerCells = headerRow.find('th, td')
      const headerTexts = []
      headerCells.each((idx, cell) => {
        const text = $(cell).text()
        headerTexts.push(text)
        const role = classifyColumnHeader(text)
        if (role) {
          columnMap.set(idx, role)
        }
      })

      const allHeaderConcat = headerTexts.join(' ').toLowerCase()
      if (NON_PERSONNEL_TABLE_PATTERNS.test(allHeaderConcat) && !columnMap.has('name') && !columnMap.has('email')) {
        return
      }

      const roles = new Set(columnMap.values())
      hasHeaderMapping = roles.has('name') || (roles.has('designation') && (roles.has('email') || roles.has('phone')))

      // If the table has explicit headers but NONE of them are person-related, it is not a personnel table
      if (headerCells.length >= 3 && roles.size === 0) {
        return
      }
    }

    // 2. Identify candidate data rows
    const rows = $table.find('tbody tr').length > 0
      ? $table.find('tbody tr')
      : $table.find('tr')

    rows.each((_, tr) => {
      const $tr = $(tr)

      // Skip the header row itself
      if (headerRow.length && $tr.is(headerRow)) return
      if ($tr.find('th').length > 0 && $tr.find('td').length === 0) return

      const cells = $tr.find('td')
      if (cells.length < 2) return

      // Space-separated cell text to prevent concatenating adjacent fields
      const cellTexts = cells.toArray().map(el => cleanText($(el).text())).filter(Boolean)
      const rowText = cellTexts.join(' ')
      if (rowText.length < 5 || rowText.length > 3000) return
      if (isIgnoredRow(rowText, cells.length)) return

      let name = null
      let nameCellIdx = -1
      let title = null
      let department = null
      let email = null
      let phone = null
      let profileUrl = null
      let linkedinUrl = null

      if (hasHeaderMapping) {
        // Strategy A: Header-guided extraction
        cells.each((idx, td) => {
          const role = columnMap.get(idx)
          const $td = $(td)
          const cellText = cleanText($td.text())

          if (role === 'name') {
            const link = $td.find('a[href]').first()
            const linkText = cleanText(link.text())
            const candidateName = linkText && isValidPersonName(linkText) ? linkText : cellText

            if (candidateName && isValidPersonName(candidateName)) {
              name = candidateName
              nameCellIdx = idx
              if (link.length) {
                const href = link.attr('href')
                const norm = normalizeHttpUrl(href, sourceUrl)
                if (norm && !norm.includes('mailto:') && !norm.includes('tel:') && !norm.includes('javascript:')) {
                  profileUrl = norm
                }
              }
            }
          } else if (role === 'designation') {
            if (cellText && (!name || isValidDesignation(cellText, name))) {
              title = cellText
            }
          } else if (role === 'department') {
            if (cellText && cellText.length < 100) {
              department = cellText
            }
          } else if (role === 'email') {
            const mailto = $td.find('a[href^="mailto:"]').first().attr('href')
            const rawEmail = mailto ? mailto.replace(/^mailto:/i, '').split('?')[0] : cellText
            const norm = normalizeEmail(rawEmail)
            if (norm.value) email = norm.value
          } else if (role === 'phone') {
            const tel = $td.find('a[href^="tel:"]').first().attr('href')
            const rawPhone = tel ? tel.replace(/^tel:/i, '') : cellText
            const norm = normalizePhone(rawPhone)
            if (norm.value) phone = norm.value
          } else if (role === 'profile') {
            const link = $td.find('a[href]').first()
            if (link.length) {
              const href = link.attr('href')
              const norm = normalizeHttpUrl(href, sourceUrl)
              if (norm && !norm.includes('mailto:') && !norm.includes('tel:')) {
                profileUrl = norm
              }
            }
          } else if (role === 'linkedin') {
            const link = $td.find('a[href*="linkedin.com"]').first().attr('href')
            if (link) {
              const norm = normalizeLinkedInUrl(link, sourceUrl)
              if (norm && !norm.includes('/company/')) linkedinUrl = norm
            }
          }
        })
      }

      // Strategy B: Fallback heuristic if headers were absent or didn't yield a name
      if (!name) {
        cells.each((idx, td) => {
          if (name) return
          const $td = $(td)
          const link = $td.find('a[href]').first()
          const candidateText = cleanText(link.length ? link.text() : $td.text())

          if (candidateText && isValidPersonName(candidateText)) {
            name = candidateText
            nameCellIdx = idx
            if (link.length) {
              const href = link.attr('href')
              const norm = normalizeHttpUrl(href, sourceUrl)
              if (norm && !norm.includes('mailto:') && !norm.includes('tel:')) {
                profileUrl = norm
              }
            }
          }
        })
      }

      if (!name) return

      // If title was not found from header, check other cells
      if (!title && nameCellIdx >= 0) {
        cells.each((idx, td) => {
          if (idx === nameCellIdx || title) return
          const cellText = cleanText($(td).text())
          if (cellText && isValidDesignation(cellText, name)) {
            title = cellText
          }
        })
      }

      // Check for email if not found
      if (!email) {
        const mailto = $tr.find('a[href^="mailto:"]').first().attr('href')
        if (mailto) {
          const raw = mailto.replace(/^mailto:/i, '').split('?')[0]
          const norm = normalizeEmail(raw)
          if (norm.value) email = norm.value
        } else {
          for (const text of cellTexts) {
            const emailMatch = text.match(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)
            if (emailMatch) {
              const norm = normalizeEmail(emailMatch[0])
              if (norm.value) { email = norm.value; break }
            }
          }
        }
      }

      // Check for phone if not found
      if (!phone) {
        const tel = $tr.find('a[href^="tel:"]').first().attr('href')
        if (tel) {
          const raw = tel.replace(/^tel:/i, '')
          const norm = normalizePhone(raw)
          if (norm.value) phone = norm.value
        } else {
          for (const text of cellTexts) {
            const phoneMatch = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/)
            if (phoneMatch) {
              const norm = normalizePhone(phoneMatch[0])
              if (norm.value) { phone = norm.value; break }
            }
          }
        }
      }

      // Check for LinkedIn if not found
      if (!linkedinUrl) {
        const link = $tr.find('a[href*="linkedin.com/in/"], a[href*="linkedin.com/pub/"]').first().attr('href')
        if (link) {
          const norm = normalizeLinkedInUrl(link, sourceUrl)
          if (norm && !norm.includes('/company/')) linkedinUrl = norm
        }
      }

      // Check for profile link in row if not found
      if (!profileUrl) {
        $tr.find('a[href]').each((_, a) => {
          if (profileUrl) return
          const href = $(a).attr('href')
          const text = cleanText($(a).text()).toLowerCase()
          if (/\b(?:view|profile|bio|biography|details|page)\b/i.test(text) || text.includes(name.toLowerCase().split(' ')[0])) {
            const norm = normalizeHttpUrl(href, sourceUrl)
            if (norm && !norm.includes('mailto:') && !norm.includes('tel:')) {
              profileUrl = norm
            }
          }
        })
      }

      const hasCorroboratingSignal = Boolean(title || email || phone || linkedinUrl || profileUrl || department)
      if (!hasCorroboratingSignal) return

      if (seenNames.has(name.toLowerCase())) {
        const existing = entities.find(e => e.candidateType === 'person' && e.fields?.full_name?.toLowerCase() === name.toLowerCase())
        if (existing) {
          if (!existing.fields.designation && title) existing.fields.designation = title
          if (!existing.fields.email && email) existing.fields.email = email
          if (!existing.fields.phone && phone) existing.fields.phone = phone
          if (!existing.fields.linkedin_url && linkedinUrl) existing.fields.linkedin_url = linkedinUrl
          if (!existing.fields.profile_url && profileUrl) existing.fields.profile_url = profileUrl
          if (!existing.fields.company && department) existing.fields.company = department
        }
        return
      }

      seenNames.add(name.toLowerCase())

      const tableScore = (profileUrl ? 1 : 0) + (title ? 1 : 0) + (linkedinUrl ? 1 : 0) + (email || phone ? 1 : 0)
      const score = Math.max(1, Math.min(3, tableScore))
      const fields = {
        full_name: name,
        designation: title || null,
        company: department || null,
        company_website: null,
        email: email || null,
        phone: phone || null,
        fax: null,
        linkedin_url: linkedinUrl || null,
        profile_url: profileUrl || null,
        location: null,
        source_url: sourceUrl,
        score,
      }

      const provenance = Object.entries(fields)
        .filter(([k, v]) => v && k !== 'source_url')
        .map(([fieldName, value]) => ({
          fieldName,
          value,
          sourceUrl,
          method: 'semantic_html',
          evidence: evidence(`table_row:${fieldName}=${value}`),
          ruleVersion: EXTRACTION_VERSION,
        }))

      entities.push({
        schemaType: 'Person',
        candidateType: 'person',
        fields,
        provenance,
        path: '$personnel_table',
      })
    })
  })
}
