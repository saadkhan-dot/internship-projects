import { Lead, PersonProfile, CompanyProfile, ScanJob } from '../models/index.js'
import { normalizeDomain } from '../utils/domain.js'
import { parseLinkedInProfileSlug, cleanText, makeWhitespaceFlexibleRegex } from '../extraction/normalization.js'

async function syncCrmModels({ LeadModel = Lead, PersonProfileModel = PersonProfile, CompanyProfileModel = CompanyProfile, ScanJobModel = ScanJob, scanJobId, candidate }) {
  try {
    const fields = candidate.fields || {}
    const candidateKey = candidate.candidateKey
    const now = candidate.extractedAt || new Date()
    const domain = normalizeDomain(candidate.sourceUrl || fields.website || '')

    let company = null
    if (typeof CompanyProfileModel?.findOne === 'function') {
      if (domain) {
        company = await CompanyProfileModel.findOne({ domain })
      }
      if (!company && fields.company) {
        const compRegex = makeWhitespaceFlexibleRegex(fields.company)
        if (compRegex) {
          company = await CompanyProfileModel.findOne({ name: compRegex })
        }
      }
    }

    if (candidate.candidateType === 'person' && fields.full_name) {
      // Upsert / Link CompanyProfile if we have domain or company name
      if (!company && (domain || fields.company) && typeof CompanyProfileModel?.updateOne === 'function') {
        const companyName = cleanText(fields.company) || domain
        const compDomain = domain || normalizeDomain(companyName)
        try {
          await CompanyProfileModel.updateOne(
            { domain: compDomain },
            {
              $set: {
                name: companyName,
                website: domain ? `https://${domain}` : candidate.sourceUrl,
                domain: compDomain,
                lastCrawledAt: now,
              },
              $setOnInsert: { createdAt: now },
            },
            { upsert: true }
          )
          if (typeof CompanyProfileModel.findOne === 'function') {
            company = await CompanyProfileModel.findOne({ domain: compDomain })
          }
        } catch {
          // Ignore duplicate key race condition
        }
      }

      if (typeof PersonProfileModel?.updateOne === 'function') {
        const profileSet = {
          name: cleanText(fields.full_name) || fields.full_name.trim(),
          sourceUrl: candidate.sourceUrl,
          scanId: scanJobId,
          candidateKey,
        }
        if (fields.designation) profileSet.title = cleanText(fields.designation) || fields.designation
        if (fields.company || company?.name) profileSet.organization = cleanText(fields.company || company?.name)
        if (fields.email) profileSet.email = fields.email
        if (fields.phone) profileSet.phone = fields.phone
        if (fields.linkedin_url) profileSet.linkedinUrl = fields.linkedin_url
        if (fields.linkedin_url || fields.profile_url) profileSet.links = [fields.linkedin_url, fields.profile_url].filter(Boolean)

        await PersonProfileModel.updateOne(
          { scanId: scanJobId, candidateKey },
          {
            $set: profileSet,
            $setOnInsert: { createdAt: now },
          },
          { upsert: true }
        )
      }

      if (typeof LeadModel?.updateOne === 'function') {
        let existingLead = null
        if (typeof LeadModel.findOne === 'function') {
          // Multi-tier Resolution:
          // Tier 1: LinkedIn URL
          const linkedinSlug = parseLinkedInProfileSlug(fields.linkedin_url)
          if (linkedinSlug) {
            const escapedSlug = linkedinSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            existingLead = await LeadModel.findOne({
              linkedinUrl: new RegExp(`^(https?:\\/\\/)?((?:[a-z0-9_-]+\\.)+)?linkedin\\.com\\/(?:in|pub)\\/${escapedSlug}([/?#].*)?$`, 'i'),
            })
          }
          // Tier 2: Email
          if (!existingLead && fields.email) {
            const cleanEmail = fields.email.trim().toLowerCase()
            existingLead = await LeadModel.findOne({
              email: new RegExp(`^${cleanEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
            })
          }
          // Tier 3: Name + Company / Domain
          if (!existingLead && fields.full_name && (fields.company || domain)) {
            const nameRegex = makeWhitespaceFlexibleRegex(fields.full_name)
            const compRegex = makeWhitespaceFlexibleRegex(fields.company || domain)
            if (nameRegex && compRegex) {
              existingLead = await LeadModel.findOne({
                name: nameRegex,
                company: compRegex,
              })
            }
          }
        }

        if (existingLead) {
          // Enrich existing lead with newly found fields without overwriting existing data
          const updateSet = {}
          if (!existingLead.email && fields.email) updateSet.email = fields.email
          if (!existingLead.phone && fields.phone) updateSet.phone = fields.phone
          if (!existingLead.title && fields.designation) updateSet.title = cleanText(fields.designation) || fields.designation
          if (!existingLead.company && (fields.company || company?.name)) updateSet.company = cleanText(fields.company || company?.name)
          if (!existingLead.linkedinUrl && fields.linkedin_url) updateSet.linkedinUrl = fields.linkedin_url
          if (!existingLead.companyId && company?._id) updateSet.companyId = company._id
          if (!existingLead.sourceUrl && candidate.sourceUrl) updateSet.sourceUrl = candidate.sourceUrl
          updateSet.scanId = scanJobId
          updateSet.candidateKey = candidateKey

          await LeadModel.updateOne(
            { _id: existingLead._id },
            { $set: updateSet }
          )
        } else {
          // New Lead
          const leadSet = {
            name: cleanText(fields.full_name) || fields.full_name.trim(),
            entityType: 'person',
            sourceUrl: candidate.sourceUrl,
            scanId: scanJobId,
            candidateKey,
          }
          if (fields.email) leadSet.email = fields.email
          if (fields.phone) leadSet.phone = fields.phone
          if (fields.company || company?.name) leadSet.company = cleanText(fields.company || company?.name)
          if (fields.designation) leadSet.title = cleanText(fields.designation) || fields.designation
          if (fields.linkedin_url) leadSet.linkedinUrl = fields.linkedin_url
          if (company?._id) leadSet.companyId = company._id

          await LeadModel.updateOne(
            { scanId: scanJobId, candidateKey },
            {
              $set: leadSet,
              $setOnInsert: { status: 'new', createdAt: now, discoveredAt: now },
            },
            { upsert: true }
          )
        }
      }
    } else if ((candidate.candidateType === 'company' || candidate.candidateType === 'organization') && fields.company_name) {
      const compName = cleanText(fields.company_name) || fields.company_name.trim()
      const compDomain = domain || normalizeDomain(fields.website || compName)
      if (typeof CompanyProfileModel?.updateOne === 'function') {
        await CompanyProfileModel.updateOne(
          compDomain ? { domain: compDomain } : { scanId: scanJobId, candidateKey },
          {
            $set: {
              name: compName,
              website: fields.website || null,
              domain: compDomain || null,
              contacts: [fields.email, fields.phone, fields.linkedin_url].filter(Boolean),
              email: fields.email || null,
              phone: fields.phone || null,
              sourceUrl: candidate.sourceUrl,
              scanId: scanJobId,
              candidateKey,
              lastCrawledAt: now,
            },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true }
        )
      }
      if ((fields.email || fields.phone) && typeof LeadModel?.updateOne === 'function') {
        await LeadModel.updateOne(
          { scanId: scanJobId, candidateKey },
          {
            $set: {
              name: compName,
              email: fields.email || null,
              phone: fields.phone || null,
              company: compName,
              entityType: 'company',
              sourceUrl: candidate.sourceUrl,
              discoveredAt: now,
              scanId: scanJobId,
              candidateKey,
            },
            $setOnInsert: { status: 'new', createdAt: now },
          },
          { upsert: true }
        )
      }
    } else if (candidate.candidateType === 'unknown' && (fields.email || fields.phone)) {
      if (typeof LeadModel?.updateOne === 'function') {
        await LeadModel.updateOne(
          { scanId: scanJobId, candidateKey },
          {
            $set: {
              name: fields.email ? fields.email.split('@')[0] : 'General Contact',
              email: fields.email || null,
              phone: fields.phone || null,
              entityType: 'contact',
              sourceUrl: candidate.sourceUrl,
              discoveredAt: now,
              scanId: scanJobId,
              candidateKey,
            },
            $setOnInsert: { status: 'new', createdAt: now },
          },
          { upsert: true }
        )
      }
    }

    if (company?._id && typeof CompanyProfileModel?.updateOne === 'function' && typeof LeadModel?.countDocuments === 'function') {
      const companyLeadsCount = await LeadModel.countDocuments({ companyId: company._id })
      await CompanyProfileModel.updateOne({ _id: company._id }, { totalLeads: companyLeadsCount })
    }

    if (typeof ScanJobModel?.updateOne === 'function' && typeof LeadModel?.countDocuments === 'function') {
      const count = await LeadModel.countDocuments({ scanId: scanJobId })
      await ScanJobModel.updateOne({ _id: scanJobId }, { leadsFound: count })
    }
  } catch {
    // Isolate CRM sync errors from candidate persistence
  }
}

export async function persistCandidate(args) {
  const {
    CandidateRecordModel,
    ScanPageModel,
    LeadModel = Lead,
    PersonProfileModel = PersonProfile,
    CompanyProfileModel = CompanyProfile,
    ScanJobModel = ScanJob,
    scanJobId,
    candidate,
    syncCrm,
  } = args || {}

  const pageQuery = ScanPageModel.findOne({ scanId: scanJobId, normalizedUrl: candidate.sourceUrl })
  const page = typeof pageQuery?.select === 'function' ? await pageQuery.select('_id') : await pageQuery
  if (!page) throw new Error('Candidate source page was not persisted')

  let existing = typeof CandidateRecordModel.findOne === 'function'
    ? await CandidateRecordModel.findOne({ scanJobId, candidateKey: candidate.candidateKey })
    : null

  if (!existing && candidate.candidateType === 'person' && candidate.fields?.full_name && typeof CandidateRecordModel.findOne === 'function') {
    if (candidate.fields.profile_url) {
      const matchByProfile = await CandidateRecordModel.findOne({
        scanJobId,
        candidateType: 'person',
        'fields.profile_url': candidate.fields.profile_url,
      })
      if (matchByProfile) existing = matchByProfile
    }

    if (!existing && candidate.sourceUrl) {
      const matchByBioPage = await CandidateRecordModel.findOne({
        scanJobId,
        candidateType: 'person',
        'fields.profile_url': candidate.sourceUrl,
      })
      if (matchByBioPage) existing = matchByBioPage
    }

    if (!existing) {
      const nameRegex = makeWhitespaceFlexibleRegex(candidate.fields.full_name)
      const candidateByName = nameRegex && typeof CandidateRecordModel.findOne === 'function'
        ? await CandidateRecordModel.findOne({
            scanJobId,
            candidateType: 'person',
            'fields.full_name': nameRegex,
          })
        : null
      if (candidateByName) {
        const emailMatch = !candidateByName.fields?.email || !candidate.fields?.email || candidateByName.fields.email.toLowerCase() === candidate.fields.email.toLowerCase()
        const slugA = parseLinkedInProfileSlug(candidateByName.fields?.linkedin_url)
        const slugB = parseLinkedInProfileSlug(candidate.fields?.linkedin_url)
        const linkedinMatch = !candidateByName.fields?.linkedin_url || !candidate.fields?.linkedin_url || (slugA && slugB ? slugA === slugB : candidateByName.fields.linkedin_url.toLowerCase() === candidate.fields.linkedin_url.toLowerCase())
        const profileMatch = !candidateByName.fields?.profile_url || !candidate.fields?.profile_url || candidateByName.fields.profile_url === candidate.fields.profile_url || candidateByName.fields.profile_url === candidate.sourceUrl
        if (emailMatch && linkedinMatch && profileMatch) {
          existing = candidateByName
        }
      }
    }
  }

  let wasInserted = false

  if (!existing) {
    const score = Number(candidate.confidenceScore ?? candidate.fields?.score) || (candidate.candidateType === 'person' ? 1 : 0)
    const record = {
      ...candidate,
      confidenceScore: score,
      shortlisted: Boolean(candidate.shortlisted),
      scanJobId,
      pageId: page._id,
    }
    try {
      const result = await CandidateRecordModel.updateOne(
        { scanJobId, candidateKey: candidate.candidateKey },
        { $setOnInsert: record },
        { upsert: true },
      )
      if (result.upsertedCount > 0) wasInserted = true
    } catch (error) {
      if (error.code !== 11000) throw error
    }
    if (typeof CandidateRecordModel.findOne === 'function') {
      existing = await CandidateRecordModel.findOne({ scanJobId, candidateKey: candidate.candidateKey })
    }
  }

  if (existing) {
    // Candidate already exists in this scan. Merge fields and provenance without overwriting stronger data.
    let modified = false
    const updateFields = {}

    const candidateScore = Number(candidate.confidenceScore ?? candidate.fields?.score) || 0
    if (candidateScore > (existing.confidenceScore || 0)) {
      updateFields.confidenceScore = candidateScore
      existing.confidenceScore = candidateScore
      modified = true
    }

    for (const [key, value] of Object.entries(candidate.fields || {})) {
      if (value != null && value !== '' && (existing.fields?.[key] == null || existing.fields?.[key] === '')) {
        updateFields[`fields.${key}`] = value
        existing.fields[key] = value
        modified = true
      }
    }

    if (candidate.provenance?.some(p => p.evidence?.includes('bio_page:')) && existing.sourceUrl !== candidate.sourceUrl) {
      updateFields.sourceUrl = candidate.sourceUrl
      existing.sourceUrl = candidate.sourceUrl
      modified = true
    }

    const MAX_PROVENANCE_ENTRIES = 50
    const existingProvKeys = new Set((existing.provenance || []).map(p => `${p.fieldName}|${p.method}|${p.sourceUrl}|${p.value}`))
    const newProvItems = []

    for (const prov of candidate.provenance || []) {
      const key = `${prov.fieldName}|${prov.method}|${prov.sourceUrl}|${prov.value}`
      if (!existingProvKeys.has(key)) {
        existingProvKeys.add(key)
        newProvItems.push(prov)
      }
    }

    if (newProvItems.length > 0 && (existing.provenance || []).length < MAX_PROVENANCE_ENTRIES) {
      const sliceCapacity = MAX_PROVENANCE_ENTRIES - (existing.provenance || []).length
      const itemsToAdd = newProvItems.slice(0, sliceCapacity)
      updateFields.provenance = [...(existing.provenance || []), ...itemsToAdd]
      modified = true
    }

    if (modified && typeof CandidateRecordModel.updateOne === 'function') {
      await CandidateRecordModel.updateOne(
        { _id: existing._id },
        { $set: updateFields },
      )
    }
  }

  // Sync to CRM models only if explicitly enabled or if custom LeadModel was passed without syncCrm: false
  const shouldSyncCrm = syncCrm === true || (syncCrm !== false && args && 'LeadModel' in args)
  if (shouldSyncCrm) {
    const candidateToSync = existing || candidate
    await syncCrmModels({ LeadModel, PersonProfileModel, CompanyProfileModel, ScanJobModel, scanJobId, candidate: candidateToSync })
  }

  return wasInserted
}
