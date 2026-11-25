import mongoose from 'mongoose'

const { Schema } = mongoose
export const ScanJob = mongoose.models.ScanJob || mongoose.model('ScanJob', new Schema({
  type: String, target: String, status: { type: String, default: 'queued' }, startedAt: Date, endedAt: Date,
  options: { type: Schema.Types.Mixed, default: () => ({}) },
  workerToken: String,
  pagesProcessed: { type: Number, default: 0 }, leadsFound: { type: Number, default: 0 },
  progress: { type: Schema.Types.Mixed, default: () => ({ stage: 'queued', urlsDiscovered: 0, pagesAttempted: 0, pagesFetched: 0, failedRequests: 0, extractionPagesProcessed: 0, candidatesFound: 0, extractionPagesSkipped: 0, extractionErrors: 0, totalKnown: null }) },
  logs: [Schema.Types.Mixed], error: String, failureReason: String, cancellationRequested: { type: Boolean, default: false },
}, { timestamps: true }))

const scanPageSchema = new Schema({
  scanId: { type: Schema.Types.ObjectId, ref: 'ScanJob', required: true },
  url: { type: String, required: true }, normalizedUrl: { type: String, required: true },
  source: { type: String, enum: ['seed', 'sitemap', 'rss', 'internal-link'], required: true },
  sourceUrl: String, depth: { type: Number, min: 0, default: 0 }, httpStatus: Number, contentType: String,
  title: String, description: String, publishedAt: String, feedGuid: String,
  discoveredAt: { type: Date, default: Date.now }, processingStatus: { type: String, enum: ['discovered', 'queued', 'fetched', 'failed', 'blocked'], default: 'discovered' },
})
scanPageSchema.index({ scanId: 1, normalizedUrl: 1 }, { unique: true })
scanPageSchema.index({ scanId: 1, source: 1 })
export const ScanPage = mongoose.models.ScanPage || mongoose.model('ScanPage', scanPageSchema)

const candidateProvenanceSchema = new Schema({
  fieldName: { type: String, required: true }, value: Schema.Types.Mixed, sourceUrl: { type: String, required: true },
  method: { type: String, enum: ['json_ld', 'meta_tag', 'semantic_html', 'mailto', 'tel', 'pattern_match', 'page_metadata'], required: true },
  evidence: { type: String, maxlength: 180 }, extractedAt: { type: Date, required: true },
  ruleVersion: { type: String, required: true }, validationStatus: { type: String, enum: ['syntax_valid', 'invalid', 'unverified', 'needs_review', 'missing'] },
}, { _id: false })
const candidateRecordSchema = new Schema({
  scanJobId: { type: Schema.Types.ObjectId, ref: 'ScanJob', required: true },
  pageId: { type: Schema.Types.ObjectId, ref: 'ScanPage', required: true },
  candidateKey: { type: String, required: true },
  candidateType: { type: String, enum: ['person', 'company', 'organization', 'unknown'], required: true },
  fields: { type: Schema.Types.Mixed, required: true },
  confidenceScore: { type: Number, default: 0 },
  shortlisted: { type: Boolean, default: false },
  promoted: { type: Boolean, default: false },
  promotedAt: Date,
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
  provenance: { type: [candidateProvenanceSchema], default: [] },
  extractionStatus: { type: String, enum: ['candidate', 'pending', 'extracting', 'completed', 'needs_review', 'validated', 'rejected', 'failed'], default: 'candidate' },
  validationStatus: { type: String, enum: ['syntax_valid', 'needs_review', 'unverified'], default: 'unverified' },
  classification: { type: String, enum: ['verified', 'unverified'], default: 'unverified' },
  sourceUrl: { type: String, required: true }, sourceDomain: String,
  extractedAt: { type: Date, required: true }, parserVersion: { type: String, required: true },
}, { timestamps: true })
candidateRecordSchema.index({ scanJobId: 1, pageId: 1, candidateKey: 1 }, { unique: true })
candidateRecordSchema.index({ scanJobId: 1, candidateKey: 1 }, { unique: true })
candidateRecordSchema.index({ scanJobId: 1, candidateType: 1, extractionStatus: 1 })
candidateRecordSchema.index({ scanJobId: 1, candidateType: 1, confidenceScore: -1 })
candidateRecordSchema.index({ scanJobId: 1, shortlisted: 1 })
candidateRecordSchema.index({ scanJobId: 1, promoted: 1 })
candidateRecordSchema.index({ scanJobId: 1, classification: 1 })
export const CandidateRecord = mongoose.models.CandidateRecord || mongoose.model('CandidateRecord', candidateRecordSchema)

const leadSchema = new Schema({
  name: String, email: String, phone: String, company: String,
  title: String, linkedinUrl: String, entityType: { type: String, default: 'person' },
  status: { type: String, enum: ['new', 'contacted', 'qualified', 'unqualified', 'archived'], default: 'new' },
  notes: String, sourceUrl: String, sourceWebsite: String, discoveredAt: { type: Date, default: Date.now },
  biography: String,
  provenance: { type: [candidateProvenanceSchema], default: [] },
  confidenceScore: { type: Number, default: 0 },
  validationStatus: { type: String, enum: ['syntax_valid', 'needs_review', 'unverified'], default: 'unverified' },
  scanId: { type: Schema.Types.ObjectId, ref: 'ScanJob' },
  candidateKey: String,
  companyId: { type: Schema.Types.ObjectId, ref: 'CompanyProfile' },
}, { timestamps: true })
leadSchema.index({ scanId: 1, candidateKey: 1 })
leadSchema.index({ email: 1 })
leadSchema.index({ linkedinUrl: 1 })
leadSchema.index({ companyId: 1 })
export const Lead = mongoose.models.Lead || mongoose.model('Lead', leadSchema)

const personProfileSchema = new Schema({
  name: String, title: String, organization: String, links: [String],
  email: String, phone: String, linkedinUrl: String, sourceUrl: String,
  biography: String,
  scanId: Schema.Types.ObjectId, candidateKey: String,
}, { timestamps: true })
personProfileSchema.index({ scanId: 1, candidateKey: 1 })
export const PersonProfile = mongoose.models.PersonProfile || mongoose.model('PersonProfile', personProfileSchema)

const companyProfileSchema = new Schema({
  name: String, website: String, domain: String, industry: String, description: String,
  contacts: [String], email: String, phone: String, linkedinUrl: String,
  people: [Schema.Types.ObjectId], scanId: Schema.Types.ObjectId, candidateKey: String,
  totalLeads: { type: Number, default: 0 },
  lastCrawledAt: Date,
}, { timestamps: true })
companyProfileSchema.index({ scanId: 1, candidateKey: 1 })
companyProfileSchema.index({ domain: 1 })
companyProfileSchema.index({ name: 1 })
export const CompanyProfile = mongoose.models.CompanyProfile || mongoose.model('CompanyProfile', companyProfileSchema)
export const AppSettings = mongoose.models.AppSettings || mongoose.model('AppSettings', new Schema({
  key: { type: String, unique: true }, defaultPageLimit: Number, crawlDepth: Number, requestDelay: Number,
  seleniumFallback: Boolean, concurrency: Number, requestTimeoutMs: Number, sitemapDiscovery: Boolean, internalLinkCrawling: Boolean,
  queryParameterPolicy: { type: String, enum: ['preserve', 'remove-tracking', 'remove-all'] },
}, { timestamps: true }))
