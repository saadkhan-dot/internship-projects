import { CandidateRecord, ScanJob } from '../models/index.js'
import { safeFetch } from '../discovery/fetch.js'
import { extractCandidates } from '../extraction/candidateExtractor.js'
import { parseHtmlPage } from '../extraction/pageParser.js'
import {
  normalizeEmail,
  normalizePhone,
  normalizeLinkedInUrl,
  cleanText,
  EXTRACTION_VERSION,
} from '../extraction/normalization.js'

const EMAIL_REGEX = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

/**
 * Validates whether an email string has valid syntax.
 */
export function isValidEmailSyntax(email) {
  if (!email || typeof email !== 'string') return false
  return EMAIL_REGEX.test(email.trim())
}

/**
 * Validates whether a phone number has valid digits.
 */
export function isValidPhoneSyntax(phone) {
  if (!phone || typeof phone !== 'string') return false
  const digits = phone.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15
}

/**
 * Classifies a candidate as 'verified' or 'unverified' based on:
 * - At least one usable contact method (email or phone) is extracted.
 * - The contact passes basic validation.
 * - Supporting source evidence exists in provenance.
 * - Extraction did not fail.
 */
export function isCandidateVerified(candidate) {
  if (!candidate) return false
  if (candidate.extractionStatus === 'failed') return false

  const fields = candidate.fields || {}
  const provenance = Array.isArray(candidate.provenance) ? candidate.provenance : []

  const hasValidEmail = Boolean(fields.email && typeof fields.email === 'string' && isValidEmailSyntax(fields.email))
  const hasValidPhone = Boolean(fields.phone && typeof fields.phone === 'string' && isValidPhoneSyntax(fields.phone))

  if (!hasValidEmail && !hasValidPhone) return false

  const hasEmailEvidence = hasValidEmail && provenance.some(
    p => p.fieldName === 'email' && (p.evidence || p.value || p.sourceUrl)
  )
  const hasPhoneEvidence = hasValidPhone && provenance.some(
    p => p.fieldName === 'phone' && (p.evidence || p.value || p.sourceUrl)
  )

  return Boolean(hasEmailEvidence || hasPhoneEvidence)
}

export function getCandidateClassification(candidate) {
  return isCandidateVerified(candidate) ? 'verified' : 'unverified'
}

/**
 * Normalizes and extracts contact details for a single candidate.
 */
export async function extractCandidateContacts(candidate, { pageCache = new Map(), fetchTimeoutMs = 8000, allowLocalFixtures = false } = {}) {
  const fields = { ...(candidate.fields || {}) }
  const provenance = [...(candidate.provenance || [])]
  const targetBioUrl = fields.profile_url || null
  const sourceUrl = candidate.sourceUrl || fields.source_url || ''

  let fetchAttempted = false
  let fetchError = null

  // If a dedicated profile/bio URL exists that differs from sourceUrl, or if contacts are missing,
  // fetch the targeted profile page to extract rich contact information.
  if (targetBioUrl && targetBioUrl !== sourceUrl) {
    fetchAttempted = true
    let html = pageCache.get(targetBioUrl)

    if (!html) {
      try {
        const response = await safeFetch(targetBioUrl, {
          timeoutMs: fetchTimeoutMs,
          allowLocalFixtures: allowLocalFixtures || process.env.NODE_ENV === 'test' || process.env.LEADINTEL_ALLOW_LOCAL_FIXTURES === 'true',
        })
        if (response.ok) {
          html = await response.text()
          pageCache.set(targetBioUrl, html)
        } else {
          fetchError = `HTTP ${response.status} when fetching profile page.`
        }
      } catch (err) {
        fetchError = err.message || 'Failed to fetch candidate profile page.'
      }
    }

    if (html) {
      try {
        const { candidates: pageCandidates, parsed } = extractCandidates(html, {
          sourceUrl: targetBioUrl,
          extractedAt: new Date(),
        })

        // Find candidate on profile page: match by name, or single person on page
        const candidateName = fields.full_name || candidate.name || ''
        const matchingPerson = pageCandidates.find(c =>
          c.candidateType === 'person' &&
          c.fields?.full_name &&
          c.fields.full_name.toLowerCase().trim() === candidateName.toLowerCase().trim()
        ) || (pageCandidates.length === 1 && pageCandidates[0].candidateType === 'person' ? pageCandidates[0] : null)

        if (matchingPerson && matchingPerson.fields) {
          const pf = matchingPerson.fields
          if (pf.email && !fields.email) fields.email = pf.email
          if (pf.phone && !fields.phone) fields.phone = pf.phone
          if (pf.linkedin_url && !fields.linkedin_url) fields.linkedin_url = pf.linkedin_url
          if (pf.biography && !fields.biography) fields.biography = pf.biography
          if (pf.designation && !fields.designation) fields.designation = pf.designation
          if (pf.company && !fields.company) fields.company = pf.company
          if (pf.profile_image_url && !fields.profile_image_url) fields.profile_image_url = pf.profile_image_url

          if (Array.isArray(matchingPerson.provenance)) {
            for (const p of matchingPerson.provenance) {
              if (!provenance.some(existing => existing.fieldName === p.fieldName && existing.sourceUrl === p.sourceUrl)) {
                provenance.push(p)
              }
            }
          }
        } else if (parsed?.contacts) {
          // Page-level contacts if this is a dedicated bio page
          if (!fields.email && parsed.contacts.emails?.length === 1) {
            const e = parsed.contacts.emails[0]
            fields.email = e.value
            provenance.push({
              fieldName: 'email',
              value: e.value,
              sourceUrl: targetBioUrl,
              method: e.method || 'pattern_match',
              evidence: e.evidence || e.value,
              extractedAt: new Date(),
              ruleVersion: EXTRACTION_VERSION,
              validationStatus: 'syntax_valid',
            })
          }
          if (!fields.phone && parsed.contacts.phones?.length === 1) {
            const p = parsed.contacts.phones[0]
            fields.phone = p.value
            provenance.push({
              fieldName: 'phone',
              value: p.value,
              sourceUrl: targetBioUrl,
              method: p.method || 'tel',
              evidence: p.evidence || p.value,
              extractedAt: new Date(),
              ruleVersion: EXTRACTION_VERSION,
              validationStatus: 'syntax_valid',
            })
          }
          if (!fields.linkedin_url && parsed.contacts.linkedInUrls?.length === 1) {
            const l = parsed.contacts.linkedInUrls[0]
            fields.linkedin_url = l.value
            provenance.push({
              fieldName: 'linkedin_url',
              value: l.value,
              sourceUrl: targetBioUrl,
              method: 'semantic_html',
              evidence: l.value,
              extractedAt: new Date(),
              ruleVersion: EXTRACTION_VERSION,
              validationStatus: 'syntax_valid',
            })
          }
        }
      } catch (err) {
        fetchError = err.message || 'Failed to parse candidate profile page.'
      }
    }
  }

  // Normalize and validate contact fields
  let hasValidEmail = false
  if (fields.email) {
    const normResult = normalizeEmail(fields.email)
    const normEmail = normResult?.value || (typeof fields.email === 'string' ? fields.email.trim().toLowerCase() : null)
    if (normEmail && isValidEmailSyntax(normEmail)) {
      fields.email = normEmail
      hasValidEmail = true
      if (!provenance.some(p => p.fieldName === 'email')) {
        provenance.push({
          fieldName: 'email',
          value: normEmail,
          sourceUrl: targetBioUrl || sourceUrl,
          method: 'pattern_match',
          evidence: normEmail,
          extractedAt: new Date(),
          ruleVersion: EXTRACTION_VERSION,
          validationStatus: 'syntax_valid',
        })
      }
    } else {
      fields.email = null // Discard invalid email syntax
    }
  }

  let hasValidPhone = false
  if (fields.phone) {
    const normResult = normalizePhone(fields.phone)
    const normPhone = normResult?.normalized || normResult?.value || (typeof fields.phone === 'string' ? fields.phone.trim() : null)
    if (normPhone && isValidPhoneSyntax(normPhone)) {
      fields.phone = normPhone
      hasValidPhone = true
      if (!provenance.some(p => p.fieldName === 'phone')) {
        provenance.push({
          fieldName: 'phone',
          value: normPhone,
          sourceUrl: targetBioUrl || sourceUrl,
          method: 'tel',
          evidence: normPhone,
          extractedAt: new Date(),
          ruleVersion: EXTRACTION_VERSION,
          validationStatus: 'syntax_valid',
        })
      }
    } else {
      fields.phone = null
    }
  }

  let hasValidLinkedIn = false
  if (fields.linkedin_url) {
    const normLinkedIn = normalizeLinkedInUrl(fields.linkedin_url, targetBioUrl || sourceUrl)
    if (normLinkedIn) {
      fields.linkedin_url = normLinkedIn
      hasValidLinkedIn = true
      if (!provenance.some(p => p.fieldName === 'linkedin_url')) {
        provenance.push({
          fieldName: 'linkedin_url',
          value: normLinkedIn,
          sourceUrl: targetBioUrl || sourceUrl,
          method: 'semantic_html',
          evidence: normLinkedIn,
          extractedAt: new Date(),
          ruleVersion: EXTRACTION_VERSION,
          validationStatus: 'syntax_valid',
        })
      }
    } else {
      fields.linkedin_url = null
    }
  }

  if (fields.biography) {
    fields.biography = cleanText(fields.biography)
  }

  // Calculate Level 2 extraction status and confidence score
  let extractionStatus = 'completed'
  let validationStatus = 'unverified'
  let score = candidate.confidenceScore || 1

  if (fetchError && !hasValidEmail && !hasValidPhone && !hasValidLinkedIn) {
    extractionStatus = 'failed'
    fields.extractionError = fetchError
  } else if (hasValidEmail && (hasValidPhone || hasValidLinkedIn)) {
    score = 3
    extractionStatus = 'completed'
    validationStatus = 'syntax_valid'
    delete fields.extractionError
  } else if (hasValidEmail || hasValidPhone || hasValidLinkedIn) {
    score = Math.max(score, 2)
    extractionStatus = 'completed'
    validationStatus = 'syntax_valid'
    delete fields.extractionError
  } else {
    // Extracted from page, but no contact channels found
    extractionStatus = 'needs_review'
    validationStatus = 'needs_review'
    delete fields.extractionError
  }

  const classification = isCandidateVerified({
    ...candidate,
    fields,
    provenance,
    extractionStatus,
  }) ? 'verified' : 'unverified'

  fields.classification = classification
  fields.score = score

  // Update candidate document
  candidate.fields = fields
  candidate.confidenceScore = score
  candidate.extractionStatus = extractionStatus
  candidate.validationStatus = validationStatus
  candidate.classification = classification
  candidate.provenance = provenance

  await candidate.save()

  return candidate
}

/**
 * Executes Level 2 contact extraction across an array of candidates with controlled concurrency.
 */
export async function executeContactExtraction(candidates, { concurrency = 3, fetchTimeoutMs = 8000, allowLocalFixtures = false } = {}) {
  const pageCache = new Map()
  const results = []
  let completedCount = 0
  let needsReviewCount = 0
  let failedCount = 0

  // Controlled concurrency queue
  let currentIndex = 0
  const worker = async () => {
    while (currentIndex < candidates.length) {
      const idx = currentIndex++
      const candidate = candidates[idx]
      try {
        const updated = await extractCandidateContacts(candidate, {
          pageCache,
          fetchTimeoutMs,
          allowLocalFixtures,
        })
        results[idx] = updated
        if (updated.extractionStatus === 'completed') completedCount++
        else if (updated.extractionStatus === 'needs_review') needsReviewCount++
        else if (updated.extractionStatus === 'failed') failedCount++
      } catch (err) {
        candidate.extractionStatus = 'failed'
        candidate.classification = 'unverified'
        candidate.fields = { ...(candidate.fields || {}), extractionError: err.message || 'Unexpected extraction failure', classification: 'unverified' }
        try { await candidate.save() } catch {}
        results[idx] = candidate
        failedCount++
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker())
  await Promise.all(workers)

  return {
    total: candidates.length,
    completed: completedCount,
    needsReview: needsReviewCount,
    failed: failedCount,
    items: results,
  }
}
