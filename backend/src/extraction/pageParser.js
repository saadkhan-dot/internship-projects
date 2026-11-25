import * as cheerio from 'cheerio'
import { cleanText, EXTRACTION_VERSION, isValidPersonName, isValidDesignation, normalizePhone, normalizeHttpUrl, normalizeLinkedInUrl, GENERIC_EXCLUSION_PHRASES, GENERIC_HEADING_PATTERNS } from './normalization.js'
import { extractPersonnelTables } from './tableExtractor.js'
import { detectDirectoryPage } from './directoryDetector.js'

const MAX_EVIDENCE = 180
const recognizedTypes = new Map([
  ['person', 'Person'], ['organization', 'Organization'], ['localbusiness', 'LocalBusiness'],
  ['profilepage', 'ProfilePage'], ['webpage', 'WebPage'], ['article', 'Article'], ['newsarticle', 'Article'],
])
const labelAliases = new Map([
  ['name', 'name'], ['full name', 'name'], ['contact name', 'name'], ['person name', 'name'],
  ['job title', 'designation'], ['title', 'designation'], ['position', 'designation'], ['designation', 'designation'],
  ['company', 'company'], ['organization', 'company'], ['organisation', 'company'], ['employer', 'company'],
  ['website', 'website'], ['company website', 'website'], ['email', 'email'], ['e-mail', 'email'],
  ['phone', 'phone'], ['telephone', 'phone'], ['tel', 'phone'],
  ['fax', 'fax'], ['facsimile', 'fax'], ['telefax', 'fax'],
  ['location', 'location'], ['address', 'location'],
])
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value]
const evidence = value => cleanText(value)?.slice(0, MAX_EVIDENCE) || null
const schemaType = value => String(value || '').split(/[\/#]/).at(-1).toLowerCase()
const unwrap = value => {
  if (Array.isArray(value)) return value[0] ?? null
  if (value && typeof value === 'object') return value['@value'] ?? value['@id'] ?? value.name ?? null
  return value ?? null
}
const text = value => cleanText(unwrap(value))
const structuredAddress = value => {
  const address = Array.isArray(value) ? value[0] : value && typeof value === 'object' ? value['@value'] ?? value : value
  if (!address || typeof address !== 'object') return text(address)
  return ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'].map(key => text(address[key])).filter(Boolean).join(', ') || null
}
const socialLinks = value => asArray(value).map(unwrap).filter(x => typeof x === 'string')
const isIgnoredContext = element => element.closest('nav,footer,aside,blockquote,code,pre,kbd,samp,[role="navigation"],[role="contentinfo"],[class*="comment" i],[id*="comment" i],[class*="testimonial" i]').length > 0

function addStructuredObjects(node, sourceUrl, entities, path = '$', seen = new WeakSet()) {
  if (!node || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) { node.forEach((item, index) => addStructuredObjects(item, sourceUrl, entities, `${path}[${index}]`, seen)); return }
  const types = asArray(node['@type']).map(schemaType)
  for (const type of types) {
    const candidateType = recognizedTypes.get(type)
    if (!candidateType) continue
    const isPerson = candidateType === 'Person'
    const isOrg = candidateType === 'Organization' || candidateType === 'LocalBusiness'
    const fields = isPerson ? {
      full_name: text(node.name), designation: text(node.jobTitle), email: text(node.email), phone: text(node.telephone), fax: text(node.faxNumber),
      linkedin_url: socialLinks(node.sameAs).map(url => normalizeLinkedInUrl(url, sourceUrl)).find(Boolean) || null,
      location: structuredAddress(node.address), company: text(node.worksFor?.name), company_website: normalizeHttpUrl(node.worksFor?.url, sourceUrl),
      source_url: sourceUrl,
    } : isOrg ? {
      company_name: text(node.name), website: normalizeHttpUrl(node.url, sourceUrl), email: text(node.email), phone: text(node.telephone), fax: text(node.faxNumber),
      location: structuredAddress(node.address), linkedin_url: socialLinks(node.sameAs).map(url => normalizeLinkedInUrl(url, sourceUrl)).find(Boolean) || null,
      source_url: sourceUrl,
    } : null
    if (fields) {
      const provenance = Object.entries(fields).filter(([key, value]) => value && key !== 'source_url').map(([fieldName, value]) => ({ fieldName, value, sourceUrl, method: 'json_ld', evidence: `${path}.${fieldName}`, ruleVersion: EXTRACTION_VERSION }))
      entities.push({ schemaType: candidateType, candidateType: type === 'localbusiness' ? 'company' : isPerson ? 'person' : 'organization', fields, provenance, path })
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '@context' || key === '@type') continue
    addStructuredObjects(value, sourceUrl, entities, `${path}.${key}`, seen)
  }
}

function extractLabeledValues($, root, sourceUrl) {
  const found = []
  const push = (label, value, snippet) => {
    const key = cleanText(label)?.toLowerCase().replace(/\s+/g, ' ').replace(/:$/, '')
    const field = labelAliases.get(key)
    const normalized = cleanText(value)
    if (!field || !normalized) return
    // Validate that person name values are human-like names, not types or documentation placeholders
    if (field === 'name' && !isValidPersonName(normalized)) return
    if (field === 'designation' && !isValidDesignation(normalized)) return
    // Validate phone / fax values have at least 7 digits
    if ((field === 'phone' || field === 'fax') && normalized.replace(/\D/g, '').length < 7) return
    // Validate location values are not type descriptions
    if (field === 'location' && (/\b(?:postaladdress|text|virtuallocation|place)\b/i.test(normalized) && /\b(?:or|and)\b/i.test(normalized))) return
    if (!found.some(item => item.field === field && item.value === normalized)) {
      found.push({ field, value: normalized, sourceUrl, method: 'semantic_html', evidence: evidence(snippet || `${label}: ${normalized}`) })
    }
  }
  root.find('dt').each((_, el) => { if (!isIgnoredContext($(el))) push($(el).text(), $(el).next('dd').text(), $(el).parent().text()) })
  root.find('tr').each((_, el) => {
    if (isIgnoredContext($(el))) return
    const heading = $(el).find('th').first().text()
    if (heading) push(heading, $(el).find('td').first().text(), $(el).text())
  })
  root.find('strong, b, label').each((_, el) => {
    if (isIgnoredContext($(el))) return
    const label = cleanText($(el).text())
    if (!label || !labelAliases.has(label.toLowerCase().replace(/\s+/g, ' ').replace(/:$/, ''))) return
    const next = $(el).get(0)?.nextSibling
    const siblingText = next?.type === 'text' ? next.data : $(el).next().text()
    const value = cleanText(String(siblingText || '').replace(/^\s*:\s*/, ''))
    push(label, value, `${label}: ${value || ''}`)
  })
  return found
}

function extractMicrodata($, root, sourceUrl, entities) {
  root.find('[itemscope]').addBack('[itemscope]').each((_, el) => {
    if (isIgnoredContext($(el))) return
    const itemType = $(el).attr('itemtype') || ''
    const type = schemaType(itemType)
    const candidateType = recognizedTypes.get(type)
    if (!candidateType) return
    const isPerson = candidateType === 'Person'
    const isOrg = candidateType === 'Organization' || candidateType === 'LocalBusiness'
    if (!isPerson && !isOrg) return

    const getProp = prop => {
      const target = $(el).find(`[itemprop="${prop}"]`).first()
      if (!target.length) return null
      return cleanText(target.attr('content') || target.attr('href') || target.text())
    }

    if (isPerson) {
      const name = getProp('name')
      const jobTitle = getProp('jobTitle') || getProp('title')
      const email = getProp('email')
      const phone = getProp('telephone') || getProp('phone')
      const sameAs = getProp('sameAs')
      const worksFor = getProp('worksFor')
      const address = getProp('address')
      if (name && isValidPersonName(name) && (jobTitle || email || phone || sameAs || worksFor)) {
        const designation = isValidDesignation(jobTitle, name) ? jobTitle : null
        const fields = {
          full_name: name,
          designation,
          email: email?.replace(/^mailto:/i, '') || null,
          phone: phone?.replace(/^tel:/i, '') || null,
          fax: null,
          linkedin_url: normalizeLinkedInUrl(sameAs, sourceUrl),
          location: address,
          company: worksFor,
          company_website: null,
          source_url: sourceUrl,
        }
        const provenance = Object.entries(fields)
          .filter(([k, v]) => v && k !== 'source_url')
          .map(([fieldName, value]) => ({ fieldName, value, sourceUrl, method: 'semantic_html', evidence: evidence(`itemprop:${fieldName}=${value}`), ruleVersion: EXTRACTION_VERSION }))
        entities.push({ schemaType: 'Person', candidateType: 'person', fields, provenance, path: '$microdata' })
      }
    } else if (isOrg) {
      const name = getProp('name')
      if (name) {
        const fields = {
          company_name: name,
          website: normalizeHttpUrl(getProp('url'), sourceUrl),
          email: getProp('email')?.replace(/^mailto:/i, '') || null,
          phone: getProp('telephone')?.replace(/^tel:/i, '') || null,
          fax: null,
          location: getProp('address'),
          linkedin_url: normalizeLinkedInUrl(getProp('sameAs'), sourceUrl),
          source_url: sourceUrl,
        }
        const provenance = Object.entries(fields)
          .filter(([k, v]) => v && k !== 'source_url')
          .map(([fieldName, value]) => ({ fieldName, value, sourceUrl, method: 'semantic_html', evidence: evidence(`itemprop:${fieldName}=${value}`), ruleVersion: EXTRACTION_VERSION }))
        entities.push({ schemaType: candidateType, candidateType: type === 'localbusiness' ? 'company' : 'organization', fields, provenance, path: '$microdata' })
      }
    }
  })
}

function extractMicroformats($, root, sourceUrl, entities) {
  root.find('.h-card, .vcard').addBack('.h-card, .vcard').each((_, el) => {
    if (isIgnoredContext($(el))) return
    const name = cleanText($(el).find('.p-name, .fn').first().text())
    const title = cleanText($(el).find('.p-job-title, .title').first().text())
    const org = cleanText($(el).find('.p-org, .org').first().text())
    const email = cleanText($(el).find('.u-email, [href^="mailto:"]').first().attr('href')?.replace(/^mailto:/i, '') || $(el).find('.u-email').first().text())
    const phone = cleanText($(el).find('.p-tel, [href^="tel:"]').first().attr('href')?.replace(/^tel:/i, '') || $(el).find('.p-tel').first().text())
    const sameAs = $(el).find('a[href*="linkedin.com"]').first().attr('href')
    if (name && isValidPersonName(name) && (title || email || phone || sameAs || org)) {
      const designation = isValidDesignation(title, name) ? title : null
      const fields = {
        full_name: name,
        designation,
        company: org,
        company_website: null,
        email: email || null,
        phone: phone || null,
        fax: null,
        linkedin_url: normalizeLinkedInUrl(sameAs, sourceUrl),
        location: null,
        source_url: sourceUrl,
      }
      const provenance = Object.entries(fields)
        .filter(([k, v]) => v && k !== 'source_url')
        .map(([fieldName, value]) => ({ fieldName, value, sourceUrl, method: 'semantic_html', evidence: evidence(`h-card:${fieldName}=${value}`), ruleVersion: EXTRACTION_VERSION }))
      entities.push({ schemaType: 'Person', candidateType: 'person', fields, provenance, path: '$hcard' })
    }
  })
}

const CARD_CONTAINER_SELECTORS = [
  '[class*="member" i]', '[class*="team" i]', '[class*="person" i]', '[class*="profile" i]',
  '[class*="staff" i]', '[class*="bio" i]', '[class*="employee" i]', '[class*="leadership" i]',
  '[class*="speaker" i]', '[class*="attorney" i]', '[class*="doctor" i]', '[class*="faculty" i]',
  '[class*="author" i]', '[class*="card" i]',
  '[class*="views-row" i]', '[class*="wp-block-column" i]', '[class*="wp-block-group" i]',
  '[class*="wp-block-media-text" i]', '[class*="col-" i]', '[class*="column" i]',
  '[class*="grid-item" i]', '[class*="directory-item" i]', '[class*="directory-row" i]',
  '[class*="user-card" i]', 'article'
].join(', ')

const TITLE_SELECTORS = [
  '[class*="job-title" i]', '[class*="jobtitle" i]', '[class*="member-title" i]',
  '[class*="person-title" i]', '[class*="profile-title" i]', '[class*="role" i]',
  '[class*="position" i]', '[class*="designation" i]', '[class*="occupation" i]',
  '[class*="job" i]', '[class*="subtitle" i]',
  '.title:not([class*="card-title" i]):not([class*="entry-title" i]):not([class*="post-title" i]):not([class*="section-title" i]):not([class*="page-title" i])',
  '[class*="title" i]'
].join(', ')

function extractProfileCards($, root, sourceUrl, entities) {
  const seenNames = new Set(entities.filter(e => e.candidateType === 'person' && e.fields?.full_name).map(e => e.fields.full_name.toLowerCase()))
  const cards = []

  root.find(CARD_CONTAINER_SELECTORS).each((_, el) => {
    if (isIgnoredContext($(el))) return
    cards.push($(el))
  })

  root.find('ul, ol').each((_, list) => {
    const listClass = (($(list).attr('class') || '') + ' ' + ($(list).attr('id') || '')).toLowerCase()
    if (/\b(?:team|people|staff|leadership|members|faculty|attorneys|directory|speakers|employees|board)\b/i.test(listClass)) {
      $(list).children('li').each((_, li) => {
        if (!isIgnoredContext($(li))) cards.push($(li))
      })
    }
  })

  root.find('table').each((_, table) => {
    const tableClass = (($(table).attr('class') || '') + ' ' + ($(table).attr('id') || '')).toLowerCase()
    const tableHeaders = $(table).find('th').text()
    if (/\b(?:team|people|staff|leadership|members|faculty|attorneys|directory|contacts|speakers)\b/i.test(tableClass) ||
        /\b(?:name|person|member|staff|title|role|position|email)\b/i.test(tableHeaders)) {
      $(table).find('tbody tr, tr').each((_, tr) => {
        if (!isIgnoredContext($(tr)) && $(tr).find('td').length >= 2) {
          cards.push($(tr))
        }
      })
    }
  })

  root.find('a[href*="linkedin.com/in/"], a[href^="mailto:"]').each((_, link) => {
    if (isIgnoredContext($(link))) return
    const container = $(link).closest('[class*="views-row" i], [class*="wp-block" i], [class*="card" i], [class*="item" i], [class*="member" i], [class*="person" i], [class*="profile" i], article, li, tr')
    if (container.length && !cards.some(c => c.is(container))) {
      cards.push(container)
    }
  })

  // Deduplicate matched container elements
  const processedEls = new Set()
  const uniqueCards = []
  for (const card of cards) {
    const el = card.get(0)
    if (!el || processedEls.has(el)) continue
    processedEls.add(el)
    uniqueCards.push(card)
  }

  for (const card of uniqueCards) {
    const cardText = cleanText(card.text()) || ''
    if (cardText.length > 4000 || cardText.length < 5) continue

    // Find candidate names within this card
    const nameCandidates = []
    card.find('h1, h2, h3, h4, h5, h6, [class*="name" i], strong, b, dt, .views-field-title, .wp-block-heading').each((_, el) => {
      if (isIgnoredContext($(el))) return
      const candidate = cleanText($(el).text())
      if (candidate && isValidPersonName(candidate)) {
        nameCandidates.push({ candidate, el: $(el) })
      }
    })

    if (!nameCandidates.length) continue

    // If card contains multiple distinct person names, it is an outer wrapper/grid of cards, not a single profile card
    const distinctNames = new Set(nameCandidates.map(nc => nc.candidate.toLowerCase()))
    if (distinctNames.size > 1) continue

    const { candidate: name, el: nameEl } = nameCandidates[0]
    if (seenNames.has(name.toLowerCase())) continue

    let title = null
    const titleCandidates = card.find(TITLE_SELECTORS).toArray()
    for (const el of titleCandidates) {
      const $el = $(el)
      if ($el.is(nameEl) || $el.has(nameEl).length > 0 || nameEl.has($el).length > 0) continue
      // Heading tags that repeat or match the name are not titles
      if ($el.is('h1, h2, h3, h4, h5, h6') && cleanText($el.text()).toLowerCase() === name.toLowerCase()) continue
      const candidateTitle = cleanText($el.text())
      if (isValidDesignation(candidateTitle, name)) {
        title = candidateTitle
        break
      }
    }

    if (!title) {
      let nextNode = nameEl.next('p, span, div, h4, h5, h6')
      if (!nextNode.length && nameEl.parent().is('a, span, div, .views-field-title')) {
        nextNode = nameEl.parent().next('p, span, div, .views-field')
      }
      if (!nextNode.length && card.is('tr')) {
        nextNode = nameEl.closest('td').next('td')
      }
      if (nextNode.length) {
        const candidateTitle = cleanText(nextNode.text())
        if (isValidDesignation(candidateTitle, name)) {
          title = candidateTitle
        }
      }
    }

    let email = null
    const mailto = card.find('a[href^="mailto:"]').first().attr('href')
    if (mailto) {
      email = cleanText(mailto.replace(/^mailto:/i, '').split('?')[0])
    }
    if (!email) {
      const emailMatch = cardText.match(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)
      if (emailMatch) email = emailMatch[0]
    }

    let phone = null
    const tel = card.find('a[href^="tel:"]').first().attr('href')
    if (tel) {
      phone = cleanText(tel.replace(/^tel:/i, ''))
    }
    if (!phone) {
      const phoneMatch = cardText.match(/(?:\+?\d[\d\s().-]{6,}\d)/)
      if (phoneMatch && phoneMatch[0].replace(/\D/g, '').length >= 7) {
        phone = phoneMatch[0]
      }
    }

    const linkedin = card.find('a[href*="linkedin.com/in/"], a[href*="linkedin.com/pub/"]').first().attr('href')
    const linkedinUrl = linkedin ? normalizeLinkedInUrl(linkedin, sourceUrl) : null

    let profileUrl = null
    const nameLink = nameEl.is('a[href]') ? nameEl : nameEl.find('a[href]').first()
    if (nameLink.length) {
      const href = nameLink.attr('href')
      const norm = normalizeHttpUrl(href, sourceUrl)
      if (norm && !norm.includes('mailto:') && !norm.includes('tel:') && !norm.includes('javascript:')) {
        profileUrl = norm
      }
    }
    if (!profileUrl) {
      card.find('a[href]').each((_, a) => {
        if (profileUrl) return
        const href = $(a).attr('href')
        const linkText = cleanText($(a).text()).toLowerCase()
        if (/\b(?:view\s*(?:bio|profile|more)|full\s*bio|profile|biography|read\s*more)\b/i.test(linkText) ||
            linkText.includes(name.toLowerCase().split(' ')[0])) {
          const norm = normalizeHttpUrl(href, sourceUrl)
          if (norm && !norm.includes('mailto:') && !norm.includes('tel:') && !norm.includes('linkedin.com')) {
            profileUrl = norm
          }
        }
      })
    }

    if (title || email || phone || linkedinUrl || profileUrl) {
      seenNames.add(name.toLowerCase())
      const cardScore = (profileUrl ? 1 : 0) + (title ? 1 : 0) + (linkedinUrl ? 1 : 0) + (email || phone ? 1 : 0)
      const score = Math.max(1, Math.min(3, cardScore))
      const fields = {
        full_name: name,
        designation: title,
        company: null,
        company_website: null,
        email: email || null,
        phone: phone || null,
        fax: null,
        linkedin_url: linkedinUrl,
        profile_url: profileUrl || null,
        location: null,
        source_url: sourceUrl,
        score,
      }
      const provenance = Object.entries(fields)
        .filter(([k, v]) => v && k !== 'source_url')
        .map(([fieldName, value]) => ({ fieldName, value, sourceUrl, method: 'semantic_html', evidence: evidence(`card:${fieldName}=${value}`), ruleVersion: EXTRACTION_VERSION }))
      entities.push({ schemaType: 'Person', candidateType: 'person', fields, provenance, path: '$profile_card' })
    }
  }
}

const GENERIC_EMAIL_PREFIXES = new Set([
  'info', 'support', 'sales', 'contact', 'press', 'media', 'jobs', 'careers',
  'billing', 'help', 'marketing', 'admin', 'administrator', 'webmaster', 'privacy',
  'security', 'inquiries', 'general', 'hello', 'office'
])

function extractIndividualBioPage($, root, sourceUrl, entities) {
  // If multiple person entities are already found, this is a team directory or listing page, not an individual bio page
  const personEntities = entities.filter(e => e.candidateType === 'person')
  if (personEntities.length > 1) return

  // 1. Check for negative page titles or headings
  const firstH1 = $('h1').first()
  const rawH1 = cleanText(firstH1.text()) || ''

  // If H1 is explicitly a generic page heading like "Contact Us", "About Us", "Our Team", reject immediately
  if (firstH1.length && (!isValidPersonName(rawH1) && !/^(?:about|profile|bio|biography|meet|dr\.?|mr\.?|ms\.?|mrs\.?)\s*[:-]?\s+[a-zA-Z]/i.test(rawH1))) {
    const normalizedH1 = rawH1.toLowerCase().replace(/[^\w\s'-]/g, '').trim()
    if (GENERIC_EXCLUSION_PHRASES.has(normalizedH1) || GENERIC_HEADING_PATTERNS.some(p => p.test(rawH1))) {
      return
    }
  }

  // If there are multiple H1s with distinct valid names, it is a directory page
  const h1Names = []
  $('h1').each((_, el) => {
    const t = cleanText($(el).text())
    if (t && isValidPersonName(t)) h1Names.push(t.toLowerCase())
  })
  if (new Set(h1Names).size > 1) return

  // 2. Identify candidate person name
  let name = null
  let nameNode = null

  if (rawH1 && isValidPersonName(rawH1)) {
    name = rawH1
    nameNode = firstH1
  } else if (rawH1) {
    const stripped = rawH1.replace(/^(?:about|profile|bio|biography|meet|dr\.?|mr\.?|ms\.?|mrs\.?)\s*[:-]?\s*/i, '').trim()
    if (stripped && isValidPersonName(stripped)) {
      name = stripped
      nameNode = firstH1
    }
  }

  if (!name) {
    // Fallback: Check profile name selectors
    const nameEl = root.find('[class*="profile-name" i], [class*="bio-name" i], [class*="author-name" i], [class*="person-name" i], [itemprop="name"]').first()
    if (nameEl.length) {
      const candidate = cleanText(nameEl.text())
      if (candidate && isValidPersonName(candidate)) {
        name = candidate
        nameNode = nameEl
      }
    }
  }

  if (!name) {
    // Fallback: Check OpenGraph profile metadata
    const ogType = (cleanText($('meta[property="og:type"]').first().attr('content')) || '').toLowerCase()
    if (ogType === 'profile') {
      const first = cleanText($('meta[property="profile:first_name"]').first().attr('content'))
      const last = cleanText($('meta[property="profile:last_name"]').first().attr('content'))
      const ogFullName = [first, last].filter(Boolean).join(' ')
      if (ogFullName && isValidPersonName(ogFullName)) {
        name = ogFullName
      }
    }
  }

  // Without a valid human name, this cannot be an individual profile page
  if (!name) return

  // 3. Compute Profile Confidence Score
  let score = 0

  try {
    const parsedUrl = new URL(sourceUrl)
    const pathname = parsedUrl.pathname.toLowerCase()
    const BIO_URL_PATTERN = /\/(?:team|people|staff|leadership|employee|faculty|author|bio|profile|members?|attorneys?|doctors?|speakers?)\/([a-z0-9_-]+)/i
    const match = pathname.match(BIO_URL_PATTERN)
    if (match && match[1]) {
      const slug = match[1].toLowerCase()
      const indexKeywords = new Set(['team', 'people', 'staff', 'index', 'all', 'category', 'archive', 'search', 'page', 'list', 'directory', 'about'])
      if (!indexKeywords.has(slug)) {
        const nameTokens = name.toLowerCase().split(/\s+/).filter(t => t.length > 2)
        const matchesName = nameTokens.some(t => slug.includes(t))
        if (matchesName) {
          score += 3
        } else {
          score += 1
        }
      }
    }
  } catch { /* ignore URL parse error */ }

  // Check Designation / Role near heading or in profile
  let title = null
  if (nameNode && nameNode.length) {
    const nextEl = nameNode.next('p, h2, h3, h4, div, span')
    if (nextEl.length) {
      const candidateTitle = cleanText(nextEl.text())
      if (candidateTitle && isValidDesignation(candidateTitle, name)) {
        title = candidateTitle
        score += 2
      }
    }
  }
  if (!title) {
    const titleEl = root.find(TITLE_SELECTORS).first()
    if (titleEl.length && (!nameNode || (!titleEl.is(nameNode) && !titleEl.has(nameNode).length))) {
      const candidateTitle = cleanText(titleEl.text())
      if (candidateTitle && isValidDesignation(candidateTitle, name)) {
        title = candidateTitle
        score += 2
      }
    }
  }

  // Check Email
  let email = null
  const mailtoLinks = []
  root.find('a[href^="mailto:"]').each((_, el) => {
    const raw = $(el).attr('href')?.replace(/^mailto:/i, '').split('?')[0].trim()
    if (raw) mailtoLinks.push(raw)
  })
  if (mailtoLinks.length > 0) {
    const nameTokens = name.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    const personalEmail = mailtoLinks.find(e => {
      const user = e.split('@')[0].toLowerCase()
      return nameTokens.some(token => user.includes(token)) && !GENERIC_EMAIL_PREFIXES.has(user)
    })
    const nonGenericEmail = mailtoLinks.find(e => !GENERIC_EMAIL_PREFIXES.has(e.split('@')[0].toLowerCase()))
    email = personalEmail || nonGenericEmail || null
    if (email) {
      score += (personalEmail ? 2 : 1)
    }
  }
  if (!email) {
    const emailMatch = root.text().match(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)
    if (emailMatch && !GENERIC_EMAIL_PREFIXES.has(emailMatch[0].split('@')[0].toLowerCase())) {
      email = emailMatch[0]
      score += 1
    }
  }

  // Check Phone
  let phone = null
  const telAnchor = root.find('a[href^="tel:"]').first()
  if (telAnchor.length) {
    const raw = cleanText(telAnchor.attr('href')?.replace(/^tel:/i, ''))
    const visibleText = cleanText(telAnchor.text())
    if (raw && normalizePhone(raw).value) {
      phone = raw
      score += 1
    } else if (visibleText && normalizePhone(visibleText).value) {
      phone = visibleText
      score += 1
    }
  }
  if (!phone) {
    const phoneLabeled = root.text().match(/\b(?:phone|tel|telephone|mobile|office|direct)\s*[:#-]?\s*(\+?\d[\d\s().-]{6,}\d)/i)
    if (phoneLabeled && phoneLabeled[1]) {
      const candidatePhone = cleanText(phoneLabeled[1])
      if (candidatePhone && normalizePhone(candidatePhone).value) {
        phone = candidatePhone
        score += 1
      }
    }
  }

  // Check Personal LinkedIn Profile (STRICT: /in/ or /pub/, NOT /company/ or /school/)
  let linkedinUrl = null
  root.find('a[href*="linkedin.com/in/"], a[href*="linkedin.com/pub/"]').each((_, el) => {
    const href = $(el).attr('href')
    const normalized = normalizeLinkedInUrl(href, sourceUrl)
    if (normalized && !/\/company\/|\/school\//i.test(normalized)) {
      linkedinUrl = normalized
      score += 2
      return false
    }
  })

  // Check Biography Section or narrative text
  let biography = null
  const bioContainer = root.find('[class*="bio" i], [class*="biography" i], [id*="bio" i], [id*="biography" i], .about-me, .profile-text').first()
  if (bioContainer.length) {
    const bioText = cleanText(bioContainer.text())
    if (bioText && bioText.length > 30) {
      biography = bioText.slice(0, 500)
      score += 1
    }
  }
  if (!biography && nameNode && nameNode.length) {
    nameNode.siblings('p').each((_, p) => {
      const pText = cleanText($(p).text())
      if (pText && pText.length > 50 && pText.toLowerCase().includes(name.toLowerCase().split(' ')[0])) {
        biography = pText.slice(0, 500)
        score += 1
        return false
      }
    })
  }

  // Check Profile Image
  let profileImageUrl = null
  root.find('img').each((_, el) => {
    const alt = cleanText($(el).attr('alt')) || ''
    const src = $(el).attr('src') || ''
    const cls = ($(el).attr('class') || '') + ' ' + ($(el).attr('id') || '')
    if (alt.toLowerCase().includes(name.toLowerCase()) || /\b(avatar|portrait|headshot|profile|author|team-member)\b/i.test(cls)) {
      profileImageUrl = normalizeHttpUrl(src, sourceUrl)
      score += 1
      return false
    }
  })

  // Check Breadcrumbs
  const breadcrumbText = root.find('[class*="breadcrumb" i], nav[aria-label*="breadcrumb" i]').text()
  if (/\b(team|people|staff|leadership|faculty|directory|our-team)\b/i.test(breadcrumbText)) {
    score += 1
  }

  // Threshold evaluation:
  // Must have a minimum confidence score of 3 (e.g. URL slug + Title, or Title + Email, or LinkedIn + Title, or URL + Bio + Image)
  // A name alone scores 0 and is rejected.
  if (score < 3) return

  // Check for company name
  let company = null
  const orgJsonLd = entities.find(e => (e.candidateType === 'organization' || e.candidateType === 'company') && e.fields?.company_name)
  if (orgJsonLd) {
    company = orgJsonLd.fields.company_name
  }
  if (!company) {
    const siteTitle = cleanText($('meta[property="og:site_name"]').attr('content')) ||
                      cleanText($('title').first().text().split(/[-|:–—]/).pop())
    if (siteTitle && siteTitle.length < 50 && !isValidPersonName(siteTitle) && !GENERIC_EXCLUSION_PHRASES.has(siteTitle.toLowerCase())) {
      company = siteTitle
    }
  }

  // Deduplication check: If this person was already extracted (e.g. by structured data on this same page),
  // enrich missing fields in the existing entity rather than pushing a duplicate.
  const existingEntity = entities.find(e => e.candidateType === 'person' && e.fields?.full_name?.toLowerCase() === name.toLowerCase())
  if (existingEntity) {
    if (!existingEntity.fields.designation && title) existingEntity.fields.designation = title
    if (!existingEntity.fields.email && email) existingEntity.fields.email = email
    if (!existingEntity.fields.phone && phone) existingEntity.fields.phone = phone
    if (!existingEntity.fields.linkedin_url && linkedinUrl) existingEntity.fields.linkedin_url = linkedinUrl
    if (!existingEntity.fields.company && company) existingEntity.fields.company = company
    if (!existingEntity.fields.biography && biography) existingEntity.fields.biography = biography
    if (!existingEntity.fields.profile_image_url && profileImageUrl) existingEntity.fields.profile_image_url = profileImageUrl
    return
  }

  // Build new person entity
  const fields = {
    full_name: name,
    designation: title,
    company: company || null,
    company_website: null,
    email: email || null,
    phone: phone || null,
    fax: null,
    linkedin_url: linkedinUrl,
    location: null,
    biography: biography || null,
    profile_image_url: profileImageUrl || null,
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
      evidence: evidence(`bio_page:${fieldName}=${value}`),
      ruleVersion: EXTRACTION_VERSION
    }))

  entities.push({ schemaType: 'Person', candidateType: 'person', fields, provenance, path: '$bio_page' })
}

export function parseHtmlPage(html, { sourceUrl, contentType = null, extractedAt = new Date() } = {}) {
  const $ = cheerio.load(String(html || ''))
  const meta = selector => cleanText($(selector).first().attr('content'))
  const canonicalHref = $('link[rel~="canonical"]').first().attr('href')
  const canonicalUrl = canonicalHref ? normalizeHttpUrl(canonicalHref, sourceUrl) : null
  const visible = $('body').clone()
  visible.find('script,style,noscript,svg,nav,footer,aside,blockquote,code,pre,kbd,samp,[role="navigation"],[role="contentinfo"],[class*="comment" i],[id*="comment" i],[class*="testimonial" i]').remove()
  visible.find('br,p,div,li,h1,h2,h3,h4,section,article,address,dt,dd,tr,td,th').prepend(' ').append(' ')
  const visibleText = cleanText(visible.text()) || ''
  const entities = []
  $('script[type="application/ld+json"]').each((index, element) => {
    try { addStructuredObjects(JSON.parse($(element).contents().text()), sourceUrl, entities, `$jsonld[${index}]`) }
    catch { /* A malformed JSON-LD block does not invalidate the HTML page. */ }
  })
  extractMicrodata($, visible, sourceUrl, entities)
  extractMicroformats($, visible, sourceUrl, entities)
  extractPersonnelTables($, visible, sourceUrl, entities)
  extractProfileCards($, visible, sourceUrl, entities)
  extractIndividualBioPage($, visible, sourceUrl, entities)

  const emails = []
  visible.find('a[href^="mailto:"]').each((_, element) => {
    const raw = $(element).attr('href')?.slice(7).split('?')[0]
    if (raw) emails.push({ value: raw, sourceUrl, method: 'mailto', evidence: evidence($(element).text() || raw) })
  })
  const emailPattern = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/ig
  for (const match of visibleText.matchAll(emailPattern)) emails.push({ value: match[0], sourceUrl, method: 'pattern_match', evidence: evidence(match[0]) })

  const phones = []
  const faxes = []
  visible.find('a[href^="tel:"]').each((_, element) => {
    const raw = $(element).attr('href')?.slice(4)
    if (!raw) return
    const textContext = $(element).parent().text()
    const isFax = /\b(?:fax|facsimile|telefax)\b/i.test(textContext)
    const entry = { value: raw, sourceUrl, method: 'tel', evidence: evidence($(element).text() || raw) }
    if (isFax) faxes.push(entry)
    else phones.push(entry)
  })

  const phonePattern = /(?:\+?\d[\d\s().-]{5,}\d)/g
  for (const match of visibleText.matchAll(phonePattern)) {
    const digits = match[0].replace(/\D/g, '').length
    if (digits < 7 || digits > 15) continue

    const preText = visibleText.slice(Math.max(0, match.index - 35), match.index)
    const postText = visibleText.slice(match.index + match[0].length, match.index + match[0].length + 25)
    const context = visibleText.slice(Math.max(0, match.index - 48), match.index + match[0].length + 24)

    const isFaxSuffix = /^\s*\((?:fax|facsimile|telefax)\)/i.test(postText)
    const isFaxPrefix = /\b(?:fax|facsimile|telefax)\b\s*[:#-]?\s*$/i.test(preText.trim())
    const isFax = isFaxSuffix || isFaxPrefix

    const isPhoneSuffix = /^\s*\((?:phone|tel|telephone|mobile|office)\)/i.test(postText)
    const isPhonePrefix = /\b(?:phone|telephone|tel|call|contact|office|mobile)\b\s*[:#-]?\s*$/i.test(preText.trim())
    const hasGeneralPhoneKeyword = /\b(?:phone|telephone|tel|call|contact|office|mobile)\b/i.test(context)

    if (isFax) {
      faxes.push({ value: match[0], sourceUrl, method: 'pattern_match', evidence: evidence(context) })
    } else if (isPhoneSuffix || isPhonePrefix || (hasGeneralPhoneKeyword && !/\b(?:fax|facsimile|telefax)\b/i.test(preText))) {
      phones.push({ value: match[0], sourceUrl, method: 'pattern_match', evidence: evidence(context) })
    }
  }

  const linkedProfiles = []
  visible.find('a[href]').each((_, element) => {
    const href = $(element).attr('href')
    const url = normalizeLinkedInUrl(href, sourceUrl)
    if (url) linkedProfiles.push({ value: url, sourceUrl, method: 'semantic_html', evidence: evidence($(element).text() || url) })
  })
  const headings = visible.find('h1,h2,h3').toArray().map(el => cleanText($(el).text())).filter(Boolean).slice(0, 50)
  const labeledValues = extractLabeledValues($, visible, sourceUrl)
  const profileType = (meta('meta[property="og:type"]') || '').toLowerCase()
  const profileName = [meta('meta[property="profile:first_name"]'), meta('meta[property="profile:last_name"]')].filter(Boolean).join(' ')
  const directory = detectDirectoryPage($, html, sourceUrl, entities)
  return {
    page: {
      source_url: sourceUrl,
      content_type: contentType,
      title: cleanText($('title').first().text()),
      meta_description: meta('meta[name="description"]'),
      canonical_url: canonicalUrl,
      og_title: meta('meta[property="og:title"]'),
      og_description: meta('meta[property="og:description"]'),
      og_url: normalizeHttpUrl(meta('meta[property="og:url"]'), sourceUrl),
      og_type: profileType || null,
    },
    directory,
    entities,
    contacts: { emails, phones, faxes, linkedProfiles },
    headings,
    labeledValues,
    profileName: profileType === 'profile' ? profileName || null : null,
    visibleText: visibleText.slice(0, 100_000),
    extractedAt,
    parserVersion: EXTRACTION_VERSION,
  }
}
