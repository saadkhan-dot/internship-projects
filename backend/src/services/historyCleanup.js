import mongoose from 'mongoose'
import { ScanJob, ScanPage, CandidateRecord, Lead, PersonProfile, CompanyProfile } from '../models/index.js'

/**
 * Safely cleans up scan history and orphaned data while preserving
 * shared CRM records, active data, and preventing dangling references.
 *
 * @param {Array<string|mongoose.Types.ObjectId>} scanIds - Array of ScanJob IDs to delete
 * @param {Object} [models] - Optional injected models for testing
 * @returns {Promise<Object>} Summary of deleted records
 */
export async function cleanupScanData(scanIds, models = {}) {
  const {
    ScanJobModel = ScanJob,
    ScanPageModel = ScanPage,
    CandidateRecordModel = CandidateRecord,
    LeadModel = Lead,
    PersonProfileModel = PersonProfile,
    CompanyProfileModel = CompanyProfile,
  } = models

  if (!Array.isArray(scanIds) || scanIds.length === 0) {
    return {
      deletedScans: 0,
      deletedPages: 0,
      deletedCandidates: 0,
      deletedLeads: 0,
      deletedPeople: 0,
      deletedCompanies: 0,
    }
  }

  const targetObjectIds = scanIds.map(id => (typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id))

  // 1. Delete scan-specific pages and candidate staging records
  const [pagesResult, candidatesResult] = await Promise.all([
    ScanPageModel.deleteMany({ scanId: { $in: targetObjectIds } }),
    CandidateRecordModel.deleteMany({ scanJobId: { $in: targetObjectIds } }),
  ])

  // 2. Identify remaining/retained scans to determine shared context
  const remainingScans = await ScanJobModel.find({ _id: { $nin: targetObjectIds } }).select('_id domain target')
  const remainingScanIds = remainingScans.map(s => s._id)
  const remainingDomains = new Set(
    remainingScans
      .map(s => s.domain || (s.target ? s.target.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase() : null))
      .filter(Boolean)
  )

  // 3. Evaluate Leads associated with the target scans
  const candidateLeads = await LeadModel.find({ scanId: { $in: targetObjectIds } })
  const leadIdsToDelete = []
  const leadIdsToPreserve = []

  for (const lead of candidateLeads) {
    // A. User-curated CRM data: non-new status or user notes
    const isCurated = (lead.status && lead.status !== 'new') || (lead.notes && String(lead.notes).trim().length > 0)

    // B. Manual CRM lead: no candidateKey (was created directly in CRM)
    const isManual = !lead.candidateKey

    // C. Legitimate CRM contact: has valid email or phone or linkedinUrl or is linked to a valid company
    const hasContactInfo = Boolean(lead.email || lead.phone || lead.linkedinUrl)
    const hasCompany = Boolean(lead.companyId || (lead.company && lead.company.trim().length > 0))
    const isLegitimateLead = Boolean(lead.name && (hasContactInfo || hasCompany))

    // D. Shared with remaining scans: matching candidate records exist in retained scans
    let isSharedWithRetainedScan = false
    if (remainingScanIds.length > 0) {
      const matchCriteria = []
      if (lead.email) matchCriteria.push({ 'fields.email': lead.email })
      if (lead.linkedinUrl) matchCriteria.push({ 'fields.linkedin_url': lead.linkedinUrl })
      if (lead.candidateKey) matchCriteria.push({ candidateKey: lead.candidateKey })

      if (matchCriteria.length > 0) {
        const retainedCandidateCount = await CandidateRecordModel.countDocuments({
          scanJobId: { $in: remainingScanIds },
          $or: matchCriteria,
        })
        if (retainedCandidateCount > 0) {
          isSharedWithRetainedScan = true
        }
      }
    }

    if (isCurated || isManual || isLegitimateLead || isSharedWithRetainedScan) {
      leadIdsToPreserve.push(lead._id)
    } else {
      leadIdsToDelete.push(lead._id)
    }
  }

  // Delete orphaned leads
  let deletedLeadsCount = 0
  if (leadIdsToDelete.length > 0) {
    const res = await LeadModel.deleteMany({ _id: { $in: leadIdsToDelete } })
    deletedLeadsCount = res.deletedCount || 0
  }

  // PREVENT DANGLING REFERENCES on preserved leads:
  // Unset scanId so it no longer points to deleted scans
  await LeadModel.updateMany(
    { scanId: { $in: targetObjectIds } },
    { $unset: { scanId: 1 } }
  )

  // 4. Evaluate PersonProfiles associated with the target scans
  const candidatePeople = await PersonProfileModel.find({ scanId: { $in: targetObjectIds } })
  const personIdsToDelete = []
  const personIdsToPreserve = []

  for (const person of candidatePeople) {
    const isManual = !person.candidateKey
    const hasIdentity = Boolean(person.name || person.email || person.phone || person.linkedinUrl)

    // Check if referenced in any retained Lead
    const matchCriteria = []
    if (person.email) matchCriteria.push({ email: person.email })
    if (person.linkedinUrl) matchCriteria.push({ linkedinUrl: person.linkedinUrl })
    if (person.candidateKey) matchCriteria.push({ candidateKey: person.candidateKey })

    let leadMatch = false
    if (matchCriteria.length > 0) {
      const count = await LeadModel.countDocuments({ $or: matchCriteria })
      leadMatch = count > 0
    }

    // Check if referenced in any retained CompanyProfile.people
    let companyMatch = false
    const companyWithPerson = await CompanyProfileModel.findOne({ people: person._id })
    if (companyWithPerson) {
      companyMatch = true
    }

    // Check if shared with any retained CandidateRecord
    let candidateMatch = false
    if (person.candidateKey && remainingScanIds.length > 0) {
      const count = await CandidateRecordModel.countDocuments({
        scanJobId: { $in: remainingScanIds },
        candidateKey: person.candidateKey,
      })
      candidateMatch = count > 0
    }

    if (isManual || hasIdentity || leadMatch || companyMatch || candidateMatch) {
      personIdsToPreserve.push(person._id)
    } else {
      personIdsToDelete.push(person._id)
    }
  }

  let deletedPeopleCount = 0
  if (personIdsToDelete.length > 0) {
    const res = await PersonProfileModel.deleteMany({ _id: { $in: personIdsToDelete } })
    deletedPeopleCount = res.deletedCount || 0
  }

  // PREVENT DANGLING REFERENCES on preserved people:
  await PersonProfileModel.updateMany(
    { scanId: { $in: targetObjectIds } },
    { $unset: { scanId: 1 } }
  )

  // 5. Evaluate CompanyProfiles associated with target scans
  const candidateCompanies = await CompanyProfileModel.find({
    $or: [
      { scanId: { $in: targetObjectIds } },
      { scanId: { $exists: false } },
      { scanId: null },
    ],
  })

  const companyIdsToDelete = []
  const companyIdsToPreserve = []

  for (const company of candidateCompanies) {
    const isManual = !company.candidateKey && !company.scanId
    const hasIdentity = Boolean(company.name || company.domain || company.website)

    // Check if any leads currently reference this company
    const remainingLeadCount = await LeadModel.countDocuments({ companyId: company._id })

    // Check if any retained scan matches this company's domain
    const scanMatch = company.domain && remainingDomains.has(company.domain)

    // Check if any remaining people are referenced in company.people
    let remainingPeopleCount = 0
    if (Array.isArray(company.people) && company.people.length > 0) {
      const validPeopleIds = company.people.filter(pId => !personIdsToDelete.some(dId => String(dId) === String(pId)))
      if (validPeopleIds.length > 0) {
        remainingPeopleCount = await PersonProfileModel.countDocuments({ _id: { $in: validPeopleIds } })
      }
    }

    // Check if any retained candidate record mentions this company
    let retainedCandidateCount = 0
    if (remainingScanIds.length > 0 && company.name) {
      retainedCandidateCount = await CandidateRecordModel.countDocuments({
        scanJobId: { $in: remainingScanIds },
        'fields.company': company.name,
      })
    }

    if (isManual || (hasIdentity && (remainingLeadCount > 0 || scanMatch || remainingPeopleCount > 0 || retainedCandidateCount > 0 || company.domain || company.website))) {
      companyIdsToPreserve.push(company._id)
    } else if (company.scanId && targetObjectIds.some(id => String(id) === String(company.scanId))) {
      companyIdsToDelete.push(company._id)
    } else {
      companyIdsToPreserve.push(company._id)
    }
  }

  let deletedCompaniesCount = 0
  if (companyIdsToDelete.length > 0) {
    const res = await CompanyProfileModel.deleteMany({ _id: { $in: companyIdsToDelete } })
    deletedCompaniesCount = res.deletedCount || 0
  }

  // PREVENT DANGLING REFERENCES on preserved companies:
  await CompanyProfileModel.updateMany(
    { scanId: { $in: targetObjectIds } },
    { $unset: { scanId: 1 } }
  )

  // Remove deleted people from company.people array
  if (personIdsToDelete.length > 0) {
    await CompanyProfileModel.updateMany(
      { people: { $in: personIdsToDelete } },
      { $pull: { people: { $in: personIdsToDelete } } }
    )
  }

  // Remove deleted company references from leads
  if (companyIdsToDelete.length > 0) {
    await LeadModel.updateMany(
      { companyId: { $in: companyIdsToDelete } },
      { $unset: { companyId: 1 } }
    )
  }

  // Recalculate totalLeads for preserved companies
  for (const compId of companyIdsToPreserve) {
    const count = await LeadModel.countDocuments({ companyId: compId })
    await CompanyProfileModel.updateOne({ _id: compId }, { totalLeads: count })
  }

  // 6. Delete the ScanJob records
  const scanResult = await ScanJobModel.deleteMany({ _id: { $in: targetObjectIds } })

  return {
    deletedScans: scanResult.deletedCount || 0,
    deletedPages: pagesResult.deletedCount || 0,
    deletedCandidates: candidatesResult.deletedCount || 0,
    deletedLeads: deletedLeadsCount,
    deletedPeople: deletedPeopleCount,
    deletedCompanies: deletedCompaniesCount,
  }
}

/**
 * Completely resets and clears all scan history, crawl cache, candidate records,
 * and all CRM data (leads, people profiles, companies).
 *
 * Enforces active scan protection: rejects with 409 if any scans are currently
 * running, queued, or cancelling.
 *
 * @param {Object} [models] - Optional injected models for testing
 * @returns {Promise<Object>} Summary of deleted records
 */
export async function resetAllHistoryAndCrmData(models = {}) {
  const {
    ScanJobModel = ScanJob,
    ScanPageModel = ScanPage,
    CandidateRecordModel = CandidateRecord,
    LeadModel = Lead,
    PersonProfileModel = PersonProfile,
    CompanyProfileModel = CompanyProfile,
  } = models

  const activeCount = await ScanJobModel.countDocuments({
    status: { $in: ['queued', 'running', 'cancelling'] },
  })

  if (activeCount > 0) {
    const error = new Error('Cannot clear history while scans are actively running or queued. Please cancel or allow active scans to finish first.')
    error.statusCode = 409
    error.activeCount = activeCount
    throw error
  }

  const [scansRes, pagesRes, candidatesRes, leadsRes, peopleRes, companiesRes] = await Promise.all([
    ScanJobModel.deleteMany({}),
    ScanPageModel.deleteMany({}),
    CandidateRecordModel.deleteMany({}),
    LeadModel.deleteMany({}),
    PersonProfileModel.deleteMany({}),
    CompanyProfileModel.deleteMany({}),
  ])

  return {
    deletedScans: scansRes.deletedCount || 0,
    deletedPages: pagesRes.deletedCount || 0,
    deletedCandidates: candidatesRes.deletedCount || 0,
    deletedLeads: leadsRes.deletedCount || 0,
    deletedPeople: peopleRes.deletedCount || 0,
    deletedCompanies: companiesRes.deletedCount || 0,
  }
}
