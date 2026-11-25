import { createHash } from 'node:crypto'
import { EXTRACTION_VERSION, isValidPersonName, isValidDesignation, normalizeEmail, normalizeFax, normalizeName, normalizePhone, normalizeHttpUrl, normalizeLinkedInUrl, sourceDomain, splitUnambiguousName } from './normalization.js'
import { parseHtmlPage } from './pageParser.js'

const nonEmpty = value => value !== null && value !== undefined && value !== ''
const lowerKey = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
const provenanceFor = (fieldName, value, sourceUrl, method, evidence, extra = {}) => ({ fieldName, value, sourceUrl, method, evidence: String(evidence || '').slice(0, 180), extractedAt: extra.extractedAt, ruleVersion: EXTRACTION_VERSION, validationStatus: extra.validationStatus || 'unverified' })

function candidateKey(type, fields, sourceUrl) {
  const identity = type === 'person'
    ? fields.linkedin_url || fields.email || (isValidPersonName(fields.full_name) ? fields.full_name : null) || fields.profile_url || sourceUrl
    : type === 'company' || type === 'organization'
      ? fields.website || fields.company_name || fields.linkedin_url || fields.email || sourceUrl
      : fields.email || fields.phone || fields.fax || fields.linkedin_url || sourceUrl
  return createHash('sha256').update(`${type}|${lowerKey(identity)}`).digest('hex')
}

function makeCandidate(type, fields, provenance, sourceUrl, extractedAt, validationStatus = 'needs_review') {
  const shape = type === 'person'
    ? { full_name: null, first_name: null, last_name: null, designation: null, company: null, company_website: null, email: null, email_original: null, phone: null, phone_normalized: null, fax: null, fax_normalized: null, linkedin_url: null, profile_url: null, location: null, source_url: sourceUrl }
    : { company_name: null, website: null, email: null, email_original: null, phone: null, phone_normalized: null, fax: null, fax_normalized: null, location: null, linkedin_url: null, source_url: sourceUrl }
  const resultFields = { ...shape, ...fields, source_url: sourceUrl }
  for (const key of Object.keys(resultFields)) if (key !== 'source_url' && !nonEmpty(resultFields[key])) resultFields[key] = null
  if (type === 'person' && resultFields.full_name && resultFields.designation) {
    if (!isValidDesignation(resultFields.designation, resultFields.full_name)) {
      resultFields.designation = null
    }
  }
  const score = Number(fields.score) || (type === 'person' ? 1 : 0)
  const candidate = {
    candidateKey: candidateKey(type, resultFields, sourceUrl), candidateType: type, fields: resultFields,
    confidenceScore: score,
    shortlisted: false,
    provenance: provenance.map(item => ({ ...item, extractedAt, ruleVersion: EXTRACTION_VERSION })),
    extractionStatus: type === 'unknown' ? 'needs_review' : 'candidate', validationStatus,
    sourceUrl, sourceDomain: sourceDomain(sourceUrl), extractedAt, parserVersion: EXTRACTION_VERSION,
  }
  return candidate
}

function normalizeContact(field, contact, extractedAt) {
  if (field === 'email') {
    const normalized = normalizeEmail(contact.value)
    if (!normalized.value) return null
    return { value: normalized.value, original: normalized.original, validationStatus: normalized.validationStatus, provenance: provenanceFor('email', normalized.value, contact.sourceUrl, contact.method, contact.evidence, { extractedAt, validationStatus: normalized.validationStatus }) }
  }
  if (field === 'fax') {
    const normalized = normalizeFax(contact.value)
    if (!normalized.value) return null
    return { value: normalized.value, normalized: normalized.normalized, original: normalized.original, validationStatus: normalized.validationStatus, provenance: provenanceFor('fax', normalized.value, contact.sourceUrl, contact.method, contact.evidence, { extractedAt, validationStatus: normalized.validationStatus }) }
  }
  const normalized = normalizePhone(contact.value)
  if (!normalized.value) return null
  return { value: normalized.value, normalized: normalized.normalized, original: normalized.original, validationStatus: normalized.validationStatus, provenance: provenanceFor('phone', normalized.value, contact.sourceUrl, contact.method, contact.evidence, { extractedAt, validationStatus: normalized.validationStatus }) }
}

function normalizeStructured(entity, parsed) {
  const { source_url: sourceUrl } = entity.fields
  const fields = { ...entity.fields }
  const provenance = [...entity.provenance]
  if (entity.candidateType === 'person') {
    if (!isValidPersonName(fields.full_name)) return null
    if (fields.designation && !isValidDesignation(fields.designation, fields.full_name)) {
      fields.designation = null
    }
    const name = splitUnambiguousName(fields.full_name)
    Object.assign(fields, name)
    if (fields.email) {
      const result = normalizeEmail(fields.email); fields.email_original = result.original; fields.email = result.value
      if (result.value) provenance.push(provenanceFor('email', result.value, sourceUrl, 'json_ld', `${entity.path}.email`, { extractedAt: parsed.extractedAt, validationStatus: result.validationStatus }))
    }
    if (fields.phone) {
      const result = normalizePhone(fields.phone); fields.phone = result.value; fields.phone_normalized = result.normalized
      if (result.value) provenance.push(provenanceFor('phone', result.value, sourceUrl, 'json_ld', `${entity.path}.telephone`, { extractedAt: parsed.extractedAt, validationStatus: result.validationStatus }))
    }
    if (fields.fax) {
      const result = normalizeFax(fields.fax); fields.fax = result.value; fields.fax_normalized = result.normalized
      if (result.value) provenance.push(provenanceFor('fax', result.value, sourceUrl, 'json_ld', `${entity.path}.faxNumber`, { extractedAt: parsed.extractedAt, validationStatus: result.validationStatus }))
    }
    fields.linkedin_url = normalizeLinkedInUrl(fields.linkedin_url, sourceUrl)
    if (fields.linkedin_url && (fields.linkedin_url.includes('/company/') || fields.linkedin_url.includes('/school/'))) {
      fields.linkedin_url = null
    }
    if (fields.profile_url) {
      fields.profile_url = normalizeHttpUrl(fields.profile_url, sourceUrl)
    }
    const hasStrongEvidence = fields.designation || fields.email || fields.phone || fields.linkedin_url || fields.profile_url || fields.company
    return hasStrongEvidence && fields.full_name ? makeCandidate('person', fields, provenance, sourceUrl, parsed.extractedAt, 'needs_review') : null
  }
  const orgName = fields.company_name
  if (!orgName) return null
  if (fields.email) {
    const result = normalizeEmail(fields.email); fields.email_original = result.original; fields.email = result.value
    if (result.value) provenance.push(provenanceFor('email', result.value, sourceUrl, 'json_ld', `${entity.path}.email`, { extractedAt: parsed.extractedAt, validationStatus: result.validationStatus }))
  }
  if (fields.phone) {
    const result = normalizePhone(fields.phone); fields.phone = result.value; fields.phone_normalized = result.normalized
  }
  if (fields.fax) {
    const result = normalizeFax(fields.fax); fields.fax = result.value; fields.fax_normalized = result.normalized
  }
  fields.linkedin_url = normalizeLinkedInUrl(fields.linkedin_url, sourceUrl)
  return makeCandidate(entity.candidateType, fields, provenance, sourceUrl, parsed.extractedAt, 'needs_review')
}

function semanticCandidate(parsed) {
  const values = Object.fromEntries(parsed.labeledValues.map(item => [item.field, item]))
  const email = values.email ? normalizeEmail(values.email.value) : normalizeEmail(parsed.contacts.emails[0]?.value)
  const phone = values.phone ? normalizePhone(values.phone.value) : normalizePhone(parsed.contacts.phones[0]?.value)
  const fax = values.fax ? normalizeFax(values.fax.value) : normalizeFax(parsed.contacts.faxes?.[0]?.value)
  const profileLink = parsed.contacts.linkedProfiles[0]
  const displayName = values.name?.value || parsed.profileName
  if (displayName && isValidPersonName(displayName) && (email.value || phone.value || profileLink || parsed.profileName)) {
    const name = splitUnambiguousName(displayName)
    const rawDesignation = normalizeName(values.designation?.value)
    const designation = isValidDesignation(rawDesignation, displayName) ? rawDesignation : null
    const rawLinkedin = normalizeLinkedInUrl(profileLink?.value, parsed.page.source_url)
    const personLinkedin = (rawLinkedin && !/\/company\/|\/school\//i.test(rawLinkedin)) ? rawLinkedin : null
    const fields = { ...name, designation, company: normalizeName(values.company?.value), company_website: normalizeHttpUrl(values.website?.value, parsed.page.source_url), email: email.value, email_original: email.original, phone: phone.value, phone_normalized: phone.normalized, fax: fax.value, fax_normalized: fax.normalized, linkedin_url: personLinkedin, location: normalizeName(values.location?.value) }
    const provenance = parsed.labeledValues.map(item => provenanceFor(item.field === 'name' ? 'full_name' : item.field, item.value, parsed.page.source_url, item.method, item.evidence, { extractedAt: parsed.extractedAt }))
    if (parsed.profileName && !values.name) provenance.push(provenanceFor('full_name', parsed.profileName, parsed.page.source_url, 'meta_tag', parsed.page.og_type, { extractedAt: parsed.extractedAt }))
    if (fields.email) provenance.push(provenanceFor('email', fields.email, parsed.page.source_url, values.email?.method || parsed.contacts.emails[0]?.method || 'pattern_match', values.email?.evidence || parsed.contacts.emails[0]?.evidence, { extractedAt: parsed.extractedAt, validationStatus: email.validationStatus }))
    if (fields.phone) provenance.push(provenanceFor('phone', fields.phone, parsed.page.source_url, values.phone?.method || parsed.contacts.phones[0]?.method || 'pattern_match', values.phone?.evidence || parsed.contacts.phones[0]?.evidence, { extractedAt: parsed.extractedAt, validationStatus: phone.validationStatus }))
    if (fields.fax) provenance.push(provenanceFor('fax', fields.fax, parsed.page.source_url, values.fax?.method || parsed.contacts.faxes?.[0]?.method || 'pattern_match', values.fax?.evidence || parsed.contacts.faxes?.[0]?.evidence, { extractedAt: parsed.extractedAt, validationStatus: fax.validationStatus }))
    if (fields.linkedin_url) provenance.push(provenanceFor('linkedin_url', fields.linkedin_url, parsed.page.source_url, profileLink.method, profileLink.evidence, { extractedAt: parsed.extractedAt }))
    return makeCandidate('person', fields, provenance, parsed.page.source_url, parsed.extractedAt)
  }
  if (values.company && (values.website || values.email || values.phone || parsed.contacts.emails.length || parsed.contacts.phones.length)) {
    const fields = { company_name: normalizeName(values.company.value), website: normalizeHttpUrl(values.website?.value, parsed.page.source_url), email: email.value, email_original: email.original, phone: phone.value, phone_normalized: phone.normalized, fax: fax.value, fax_normalized: fax.normalized, linkedin_url: normalizeLinkedInUrl(profileLink?.value, parsed.page.source_url), location: normalizeName(values.location?.value) }
    const provenance = parsed.labeledValues.map(item => provenanceFor(item.field === 'company' ? 'company_name' : item.field, item.value, parsed.page.source_url, item.method, item.evidence, { extractedAt: parsed.extractedAt }))
    if (fields.email) provenance.push(provenanceFor('email', fields.email, parsed.page.source_url, parsed.contacts.emails[0]?.method || 'pattern_match', parsed.contacts.emails[0]?.evidence, { extractedAt: parsed.extractedAt, validationStatus: email.validationStatus }))
    if (fields.phone) provenance.push(provenanceFor('phone', fields.phone, parsed.page.source_url, parsed.contacts.phones[0]?.method || 'pattern_match', parsed.contacts.phones[0]?.evidence, { extractedAt: parsed.extractedAt, validationStatus: phone.validationStatus }))
    if (fields.fax) provenance.push(provenanceFor('fax', fields.fax, parsed.page.source_url, parsed.contacts.faxes?.[0]?.method || 'pattern_match', parsed.contacts.faxes?.[0]?.evidence, { extractedAt: parsed.extractedAt, validationStatus: fax.validationStatus }))
    return makeCandidate('organization', fields, provenance, parsed.page.source_url, parsed.extractedAt)
  }
  return null
}

function mergeCandidate(existing, incoming) {
  for (const [field, value] of Object.entries(incoming.fields)) if (!nonEmpty(existing.fields[field]) && nonEmpty(value)) existing.fields[field] = value
  if (incoming.confidenceScore && (!existing.confidenceScore || incoming.confidenceScore > existing.confidenceScore)) {
    existing.confidenceScore = incoming.confidenceScore
  }
  if (incoming.fields?.score && (!existing.fields?.score || incoming.fields.score > existing.fields.score)) {
    existing.fields.score = incoming.fields.score
  }
  const seen = new Set(existing.provenance.map(item => `${item.fieldName}|${item.method}|${item.value}`))
  for (const item of incoming.provenance) if (!seen.has(`${item.fieldName}|${item.method}|${item.value}`)) existing.provenance.push(item)
  return existing
}

export function extractCandidatesFromParsedPage(parsed) {
  const rawCandidates = []
  for (const entity of parsed.entities) {
    const candidate = normalizeStructured(entity, parsed)
    if (candidate) rawCandidates.push(candidate)
  }
  const semantic = semanticCandidate(parsed)
  if (semantic) rawCandidates.push(semantic)

  // Consolidate person candidates on the same page with matching full_name and non-conflicting contacts
  const candidates = []
  for (const candidate of rawCandidates) {
    if (candidate.candidateType === 'person' && candidate.fields.full_name) {
      const existingMatch = candidates.find(c =>
        c.candidateType === 'person' &&
        c.fields.full_name &&
        c.fields.full_name.toLowerCase() === candidate.fields.full_name.toLowerCase() &&
        (!c.fields.email || !candidate.fields.email || c.fields.email.toLowerCase() === candidate.fields.email.toLowerCase()) &&
        (!c.fields.linkedin_url || !candidate.fields.linkedin_url || c.fields.linkedin_url.toLowerCase() === candidate.fields.linkedin_url.toLowerCase()) &&
        (!c.fields.profile_url || !candidate.fields.profile_url || c.fields.profile_url === candidate.fields.profile_url)
      )
      if (existingMatch) {
        mergeCandidate(existingMatch, candidate)
        continue
      }
    }
    candidates.push(candidate)
  }

  const seenValues = new Set()
  for (const contact of parsed.contacts.emails) {
    const result = normalizeContact('email', contact, parsed.extractedAt)
    if (!result || seenValues.has(`email|${result.value}`)) continue
    seenValues.add(`email|${result.value}`)
    candidates.push(makeCandidate('unknown', { email: result.value, email_original: result.original }, [result.provenance], parsed.page.source_url, parsed.extractedAt))
  }
  for (const contact of parsed.contacts.phones) {
    const result = normalizeContact('phone', contact, parsed.extractedAt)
    if (!result || seenValues.has(`phone|${result.value}`)) continue
    seenValues.add(`phone|${result.value}`)
    candidates.push(makeCandidate('unknown', { phone: result.value, phone_normalized: result.normalized }, [result.provenance], parsed.page.source_url, parsed.extractedAt))
  }
  for (const contact of parsed.contacts.faxes || []) {
    const result = normalizeContact('fax', contact, parsed.extractedAt)
    if (!result || seenValues.has(`fax|${result.value}`)) continue
    seenValues.add(`fax|${result.value}`)
    candidates.push(makeCandidate('unknown', { fax: result.value, fax_normalized: result.normalized }, [result.provenance], parsed.page.source_url, parsed.extractedAt))
  }
  for (const profile of parsed.contacts.linkedProfiles) {
    const url = normalizeLinkedInUrl(profile.value, parsed.page.source_url)
    if (!url || seenValues.has(`linkedin|${url}`)) continue
    seenValues.add(`linkedin|${url}`)
    candidates.push(makeCandidate('unknown', { linkedin_url: url }, [provenanceFor('linkedin_url', url, profile.sourceUrl, profile.method, profile.evidence, { extractedAt: parsed.extractedAt })], parsed.page.source_url, parsed.extractedAt))
  }

  const knownContacts = new Set(candidates.filter(item => item.candidateType !== 'unknown').flatMap(item => [
    item.fields.email && `email|${item.fields.email.toLowerCase()}`,
    item.fields.email_original && `email|${item.fields.email_original.toLowerCase()}`,
    item.fields.phone && `phone|${item.fields.phone}`,
    item.fields.phone_normalized && `phone|${item.fields.phone_normalized}`,
    item.fields.fax && `fax|${item.fields.fax}`,
    item.fields.fax_normalized && `fax|${item.fields.fax_normalized}`,
    item.fields.linkedin_url && `linkedin|${item.fields.linkedin_url.toLowerCase()}`
  ].filter(Boolean)))

  const output = new Map()
  for (const candidate of candidates) {
    if (candidate.candidateType === 'unknown' && Object.keys(candidate.fields).some(key => key === 'email' || key === 'phone' || key === 'fax' || key === 'linkedin_url')) {
      const emailMatch = candidate.fields.email && (knownContacts.has(`email|${candidate.fields.email.toLowerCase()}`) || (candidate.fields.email_original && knownContacts.has(`email|${candidate.fields.email_original.toLowerCase()}`)))
      const phoneMatch = candidate.fields.phone && (knownContacts.has(`phone|${candidate.fields.phone}`) || (candidate.fields.phone_normalized && knownContacts.has(`phone|${candidate.fields.phone_normalized}`)))
      const faxMatch = candidate.fields.fax && (knownContacts.has(`fax|${candidate.fields.fax}`) || (candidate.fields.fax_normalized && knownContacts.has(`fax|${candidate.fields.fax_normalized}`)))
      const linkedinMatch = candidate.fields.linkedin_url && knownContacts.has(`linkedin|${candidate.fields.linkedin_url.toLowerCase()}`)
      if (emailMatch || phoneMatch || faxMatch || linkedinMatch) continue
    }
    const existing = output.get(candidate.candidateKey)
    output.set(candidate.candidateKey, existing ? mergeCandidate(existing, candidate) : candidate)
  }
  return [...output.values()]
}

export function extractCandidates(html, metadata) {
  const parsed = parseHtmlPage(html, metadata)
  return { parsed, candidates: extractCandidatesFromParsedPage(parsed) }
}
