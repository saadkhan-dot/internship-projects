import { Lead, PersonProfile, CompanyProfile, ScanJob, CandidateRecord } from '../models/index.js'
import { normalizeDomain } from '../utils/domain.js'
import { isCandidateVerified } from './contactExtraction.js'
import {
  parseLinkedInProfileSlug,
  cleanText,
  makeWhitespaceFlexibleRegex,
  normalizeEmail,
  normalizePhone,
  normalizeLinkedInUrl,
} from '../extraction/normalization.js'

/**
 * Promotes a single candidate record to a CRM Lead with multi-tier deduplication,
 * company linking, person profile association, and provenance preservation.
 */
export async function promoteSingleCandidate(candidate, {
  scanJobId,
  LeadModel = Lead,
  PersonProfileModel = PersonProfile,
  CompanyProfileModel = CompanyProfile,
  CandidateRecordModel = CandidateRecord,
} = {}) {
  if (!candidate) {
    return { success: false, status: 'failed', error: 'Candidate record required.' }
  }

  // 1. Ownership validation
  if (scanJobId && String(candidate.scanJobId) !== String(scanJobId)) {
    return {
      success: false,
      status: 'failed',
      candidateId: candidate._id,
      error: 'Candidate does not belong to the specified scan.',
    }
  }

  // 2. Check idempotency: already promoted
  if (candidate.promoted && candidate.leadId) {
    const existing = await LeadModel.findById(candidate.leadId)
    if (existing) {
      return {
        success: true,
        status: 'already_promoted',
        leadId: existing._id,
        lead: existing,
        candidateId: candidate._id,
        candidateName: candidate.fields?.full_name || candidate.name,
        message: 'Candidate is already promoted to CRM.',
      }
    }
  }

  const fields = candidate.fields || {}
  const fullName = cleanText(fields.full_name || candidate.name)

  if (!fullName) {
    return {
      success: false,
      status: 'failed',
      candidateId: candidate._id,
      error: 'Candidate missing full name.',
    }
  }

  // 3. Normalization of contact channels
  const email = fields.email
    ? (normalizeEmail(fields.email)?.value || (typeof fields.email === 'string' ? fields.email.trim().toLowerCase() : null))
    : null
  const phone = fields.phone
    ? (normalizePhone(fields.phone)?.normalized || normalizePhone(fields.phone)?.value || (typeof fields.phone === 'string' ? fields.phone.trim() : null))
    : null
  const linkedinUrl = fields.linkedin_url
    ? normalizeLinkedInUrl(fields.linkedin_url, candidate.sourceUrl)
    : null
  const companyName = cleanText(fields.company) || null
  const title = cleanText(fields.designation || fields.title) || null
  const biography = cleanText(fields.biography) || null
  const sourceUrl = candidate.sourceUrl || fields.profile_url || null
  const domain = normalizeDomain(sourceUrl || fields.website || '')
  const sourceWebsite = domain ? `https://${domain}` : null
  const now = new Date()

  // 4. Company Profile Resolution and Deduplication
  let company = null
  if (companyName && typeof CompanyProfileModel?.findOne === 'function') {
    const compRegex = makeWhitespaceFlexibleRegex(companyName)
    if (compRegex) {
      company = await CompanyProfileModel.findOne({ name: compRegex })
    }
  }
  if (!company && domain && typeof CompanyProfileModel?.findOne === 'function') {
    const domainComp = await CompanyProfileModel.findOne({ domain })
    if (domainComp && (!companyName || domainComp.name.toLowerCase() === companyName.toLowerCase())) {
      company = domainComp
    }
  }

  if (company && typeof CompanyProfileModel?.updateOne === 'function') {
    // Enrich existing company without overwriting existing data
    const compEnrich = {}
    if (!company.domain && domain) compEnrich.domain = domain
    if (!company.website && sourceWebsite) compEnrich.website = sourceWebsite
    if (Object.keys(compEnrich).length > 0) {
      await CompanyProfileModel.updateOne({ _id: company._id }, { $set: compEnrich })
    }
  } else if (!company && (companyName || domain) && typeof CompanyProfileModel?.updateOne === 'function') {
    const cName = companyName || domain
    const cDomain = (companyName ? normalizeDomain(companyName) : null) || domain
    try {
      await CompanyProfileModel.updateOne(
        { name: cName },
        {
          $set: {
            name: cName,
            domain: cDomain,
            website: sourceWebsite || (cDomain ? `https://${cDomain}` : null),
            lastCrawledAt: now,
            scanId: scanJobId || candidate.scanJobId,
          },
          $setOnInsert: { createdAt: now, totalLeads: 0, people: [] },
        },
        { upsert: true }
      )
      company = await CompanyProfileModel.findOne({ name: cName })
    } catch {
      // Handle race condition
      company = await CompanyProfileModel.findOne({ name: cName })
    }
  }

  // 5. Multi-tier Lead Deduplication & Reuse
  // Order: 1. Normalized email -> 2. Canonical LinkedIn URL -> 3. Existing PersonProfile relationships -> 4. Normalized name + company as fallback
  let existingLead = null
  if (typeof LeadModel?.findOne === 'function') {
    // Tier 1: Normalized Email
    if (email) {
      const cleanEmail = email.trim().toLowerCase()
      existingLead = await LeadModel.findOne({
        email: new RegExp(`^${cleanEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      })
    }

    // Tier 2: Canonical LinkedIn URL
    if (!existingLead && linkedinUrl) {
      const linkedinSlug = parseLinkedInProfileSlug(linkedinUrl)
      if (linkedinSlug) {
        const escapedSlug = linkedinSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        existingLead = await LeadModel.findOne({
          linkedinUrl: new RegExp(`^(https?:\\/\\/)?((?:[a-z0-9_-]+\\.)+)?linkedin\\.com\\/(?:in|pub)\\/${escapedSlug}([/?#].*)?$`, 'i'),
        })
      }
    }

    // Tier 3: Existing PersonProfile relationships
    if (!existingLead && typeof PersonProfileModel?.findOne === 'function') {
      let matchedPerson = null
      if (email) {
        matchedPerson = await PersonProfileModel.findOne({
          email: new RegExp(`^${email.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        })
      }
      if (!matchedPerson && linkedinUrl) {
        const slug = parseLinkedInProfileSlug(linkedinUrl)
        if (slug) {
          matchedPerson = await PersonProfileModel.findOne({
            linkedinUrl: new RegExp(`linkedin\\.com\\/(?:in|pub)\\/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
          })
        }
      }
      if (!matchedPerson && candidate.candidateKey) {
        matchedPerson = await PersonProfileModel.findOne({
          candidateKey: candidate.candidateKey,
        })
      }
      if (!matchedPerson && fullName && (companyName || company?.name)) {
        const pNameRegex = makeWhitespaceFlexibleRegex(fullName)
        const pOrgRegex = makeWhitespaceFlexibleRegex(companyName || company?.name)
        if (pNameRegex && pOrgRegex) {
          matchedPerson = await PersonProfileModel.findOne({
            name: pNameRegex,
            organization: pOrgRegex,
          })
        }
      }

      if (matchedPerson) {
        const personMatchCriteria = []
        if (matchedPerson.email) {
          personMatchCriteria.push({
            email: new RegExp(`^${matchedPerson.email.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
          })
        }
        if (matchedPerson.linkedinUrl) {
          const pSlug = parseLinkedInProfileSlug(matchedPerson.linkedinUrl)
          if (pSlug) {
            personMatchCriteria.push({
              linkedinUrl: new RegExp(`^(https?:\\/\\/)?((?:[a-z0-9_-]+\\.)+)?linkedin\\.com\\/(?:in|pub)\\/${pSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([/?#].*)?$`, 'i'),
            })
          }
        }
        if (matchedPerson.candidateKey) {
          personMatchCriteria.push({ candidateKey: matchedPerson.candidateKey })
        }
        if (matchedPerson.name && (companyName || matchedPerson.organization)) {
          const pNameRegex = makeWhitespaceFlexibleRegex(matchedPerson.name)
          const pCompRegex = makeWhitespaceFlexibleRegex(companyName || matchedPerson.organization)
          if (pNameRegex && pCompRegex) {
            personMatchCriteria.push({ name: pNameRegex, company: pCompRegex })
          }
        }
        if (personMatchCriteria.length > 0) {
          existingLead = await LeadModel.findOne({ $or: personMatchCriteria })
        }
      }
    }

    // Tier 4: Normalized Name + Company / Domain as fallback
    if (!existingLead && fullName && (companyName || domain)) {
      const nameRegex = makeWhitespaceFlexibleRegex(fullName)
      const compRegex = makeWhitespaceFlexibleRegex(companyName || domain)
      if (nameRegex && compRegex) {
        existingLead = await LeadModel.findOne({
          name: nameRegex,
          $or: [
            { company: compRegex },
            ...(company?._id ? [{ companyId: company._id }] : []),
          ],
        })
      }
    }

    // Tier 5: Fallback by candidateKey and scanId
    if (!existingLead && candidate.candidateKey && (scanJobId || candidate.scanJobId)) {
      existingLead = await LeadModel.findOne({
        scanId: scanJobId || candidate.scanJobId,
        candidateKey: candidate.candidateKey,
      })
    }
  }

  let finalLead = null
  let action = 'created'

  if (existingLead) {
    action = 'reused'
    // Enrich without overwriting valuable existing contact information
    let changed = false
    if (!existingLead.email && email) { existingLead.email = email; changed = true }
    if (!existingLead.phone && phone) { existingLead.phone = phone; changed = true }
    if (!existingLead.title && title) { existingLead.title = title; changed = true }
    if (!existingLead.company && (companyName || company?.name)) {
      existingLead.company = companyName || company?.name
      changed = true
    }
    if (!existingLead.companyId && company?._id) { existingLead.companyId = company._id; changed = true }
    if (!existingLead.linkedinUrl && linkedinUrl) { existingLead.linkedinUrl = linkedinUrl; changed = true }
    if (!existingLead.biography && biography) { existingLead.biography = biography; changed = true }
    if (!existingLead.sourceUrl && sourceUrl) { existingLead.sourceUrl = sourceUrl; changed = true }
    if (!existingLead.sourceWebsite && sourceWebsite) { existingLead.sourceWebsite = sourceWebsite; changed = true }

    // Preserve provenance evidence if existing lead has none
    if ((!existingLead.provenance || existingLead.provenance.length === 0) && candidate.provenance?.length) {
      existingLead.provenance = candidate.provenance
      changed = true
    }

    if (changed) {
      await existingLead.save()
    }
    finalLead = existingLead
  } else {
    // Create new lead
    finalLead = await LeadModel.create({
      name: fullName,
      title,
      company: companyName || company?.name || null,
      companyId: company?._id || null,
      email,
      phone,
      linkedinUrl,
      biography,
      sourceUrl,
      sourceWebsite,
      entityType: 'person',
      status: 'new',
      scanId: scanJobId || candidate.scanJobId,
      candidateKey: candidate.candidateKey,
      discoveredAt: now,
      provenance: candidate.provenance || [],
      confidenceScore: candidate.confidenceScore || 1,
      validationStatus: candidate.validationStatus || 'unverified',
    })
  }

  // 6. PersonProfile Resolution and Deduplication
  if (typeof PersonProfileModel?.findOne === 'function' && typeof PersonProfileModel?.updateOne === 'function') {
    let existingPerson = null
    if (email) {
      existingPerson = await PersonProfileModel.findOne({
        email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      })
    }
    if (!existingPerson && linkedinUrl) {
      const slug = parseLinkedInProfileSlug(linkedinUrl)
      if (slug) {
        existingPerson = await PersonProfileModel.findOne({
          linkedinUrl: new RegExp(`linkedin\\.com\\/(?:in|pub)\\/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
        })
      }
    }
    if (!existingPerson && candidate.candidateKey) {
      existingPerson = await PersonProfileModel.findOne({
        scanId: scanJobId || candidate.scanJobId,
        candidateKey: candidate.candidateKey,
      })
    }
    if (!existingPerson && fullName && (companyName || company?.name)) {
      const pNameRegex = makeWhitespaceFlexibleRegex(fullName)
      const pOrgRegex = makeWhitespaceFlexibleRegex(companyName || company?.name)
      if (pNameRegex && pOrgRegex) {
        existingPerson = await PersonProfileModel.findOne({
          name: pNameRegex,
          organization: pOrgRegex,
        })
      }
    }

    const personData = {
      name: fullName,
      title: title || existingPerson?.title || null,
      organization: companyName || company?.name || existingPerson?.organization || null,
      email: email || existingPerson?.email || null,
      phone: phone || existingPerson?.phone || null,
      linkedinUrl: linkedinUrl || existingPerson?.linkedinUrl || null,
      biography: biography || existingPerson?.biography || null,
      sourceUrl: sourceUrl || existingPerson?.sourceUrl || null,
      links: [...new Set([linkedinUrl, sourceUrl, ...(existingPerson?.links || [])].filter(Boolean))],
      scanId: scanJobId || candidate.scanJobId || existingPerson?.scanId,
      candidateKey: candidate.candidateKey || existingPerson?.candidateKey,
    }

    let resolvedPersonId = existingPerson?._id
    if (existingPerson) {
      await PersonProfileModel.updateOne({ _id: existingPerson._id }, { $set: personData })
    } else {
      const createdPerson = await PersonProfileModel.create({ ...personData, createdAt: now })
      resolvedPersonId = createdPerson?._id
    }

    // Link Person to Company.people array if company exists
    if (company?._id && resolvedPersonId && typeof CompanyProfileModel?.updateOne === 'function') {
      await CompanyProfileModel.updateOne(
        { _id: company._id },
        { $addToSet: { people: resolvedPersonId } }
      )
    }
  }

  // 7. Update Company Lead Count
  if (company?._id && typeof CompanyProfileModel?.updateOne === 'function' && typeof LeadModel?.countDocuments === 'function') {
    const companyLeadsCount = await LeadModel.countDocuments({ companyId: company._id })
    await CompanyProfileModel.updateOne({ _id: company._id }, { totalLeads: companyLeadsCount })
  }

  // 8. Update CandidateRecord promotion state
  candidate.promoted = true
  candidate.promotedAt = now
  candidate.leadId = finalLead._id
  if (typeof candidate.save === 'function') {
    await candidate.save()
  } else if (typeof CandidateRecordModel?.updateOne === 'function') {
    await CandidateRecordModel.updateOne(
      { _id: candidate._id },
      { $set: { promoted: true, promotedAt: now, leadId: finalLead._id } }
    )
  }

  return {
    success: true,
    status: action,
    leadId: finalLead._id,
    lead: finalLead,
    candidateId: candidate._id,
    candidateName: fullName,
    companyId: company?._id || null,
    companyName: company?.name || companyName || null,
  }
}

/**
 * Promotes multiple candidates to CRM with validation, error isolation,
 * and summary reporting.
 */
export async function promoteCandidates({
  scanJobId,
  candidateIds,
  allShortlisted = false,
  category = null,
  LeadModel = Lead,
  PersonProfileModel = PersonProfile,
  CompanyProfileModel = CompanyProfile,
  CandidateRecordModel = CandidateRecord,
  ScanJobModel = ScanJob,
} = {}) {
  let candidates = []

  if (Array.isArray(candidateIds) && candidateIds.length > 0) {
    candidates = await CandidateRecordModel.find({ _id: { $in: candidateIds } })

    // Ownership check: all candidates must belong to the scan
    if (scanJobId) {
      const foreign = candidates.some(c => String(c.scanJobId) !== String(scanJobId))
      if (foreign || candidates.length !== candidateIds.length) {
        throw new Error('One or more requested candidates do not belong to this scan.')
      }
    }
  } else if (category && scanJobId) {
    const all = await CandidateRecordModel.find({
      scanJobId,
      candidateType: 'person',
    })
    if (category === 'verified') {
      candidates = all.filter(c => isCandidateVerified(c))
    } else if (category === 'unverified') {
      candidates = all.filter(c => !isCandidateVerified(c))
    } else if (category === 'both' || category === 'all') {
      candidates = all
    } else {
      throw new Error(`Invalid promotion category: "${category}". Expected "verified", "unverified", or "both".`)
    }
  } else if (allShortlisted && scanJobId) {
    candidates = await CandidateRecordModel.find({
      scanJobId,
      candidateType: 'person',
      shortlisted: true,
    })
  } else {
    throw new Error('Must provide candidateIds array, category ("verified" | "unverified" | "both"), or set allShortlisted: true with scanJobId.')
  }

  const results = []
  let createdCount = 0
  let reusedCount = 0
  let alreadyPromotedCount = 0
  let failedCount = 0

  for (const c of candidates) {
    try {
      const res = await promoteSingleCandidate(c, {
        scanJobId,
        LeadModel,
        PersonProfileModel,
        CompanyProfileModel,
        CandidateRecordModel,
      })
      results.push(res)
      if (res.status === 'created') createdCount++
      else if (res.status === 'reused') reusedCount++
      else if (res.status === 'already_promoted') alreadyPromotedCount++
      else if (!res.success) failedCount++
    } catch (err) {
      results.push({
        success: false,
        status: 'failed',
        candidateId: c._id,
        candidateName: c.fields?.full_name || c.name,
        error: err.message || 'Promotion failed',
      })
      failedCount++
    }
  }

  // Update ScanJob.leadsFound if scanJobId provided
  if (scanJobId && typeof ScanJobModel?.updateOne === 'function' && typeof LeadModel?.countDocuments === 'function') {
    const totalLeadsForScan = await LeadModel.countDocuments({ scanId: scanJobId })
    await ScanJobModel.updateOne({ _id: scanJobId }, { leadsFound: totalLeadsForScan })
  }

  return {
    success: true,
    total: candidates.length,
    promoted: createdCount,
    reused: reusedCount,
    alreadyPromoted: alreadyPromotedCount,
    failed: failedCount,
    items: results,
  }
}
