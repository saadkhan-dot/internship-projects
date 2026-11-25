import mongoose from 'mongoose'
import { CandidateRecord } from '../models/index.js'

export async function inspectDuplicates() {
  const indexes = await CandidateRecord.collection.indexes()
  const duplicates = await CandidateRecord.aggregate([
    { $group: { _id: { scanJobId: '$scanJobId', candidateKey: '$candidateKey' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } }
  ])

  return {
    indexes,
    duplicateCount: duplicates.length,
    duplicates,
    canCreateUniqueIndexImmediately: duplicates.length === 0
  }
}

export async function migrateDuplicates({ apply = false } = {}) {
  const inspection = await inspectDuplicates()
  console.log(`CandidateRecord Migration Inspection:`)
  console.log(`- Total duplicate sets found: ${inspection.duplicateCount}`)
  console.log(`- Can create unique index immediately: ${inspection.canCreateUniqueIndexImmediately}`)

  if (inspection.duplicateCount === 0) {
    console.log('No duplicates exist.')
    if (apply) {
      console.log('Replacing index with unique index { scanJobId: 1, candidateKey: 1 }...')
      try {
        await CandidateRecord.collection.dropIndex('scanJobId_1_candidateKey_1')
      } catch (err) {
        // Ignore if index didn't exist
      }
      await CandidateRecord.collection.createIndex({ scanJobId: 1, candidateKey: 1 }, { unique: true })
      console.log('Unique index created successfully.')
    }
    return { applied: apply, mergedSets: 0 }
  }

  console.log('\nDuplicate sets details:')
  for (const group of inspection.duplicates) {
    console.log(`  Scan: ${group._id.scanJobId}, Key: ${group._id.candidateKey}, Duplicate Count: ${group.count}`)
  }

  if (!apply) {
    console.log('\n[DRY RUN] No changes were made. Pass --apply to merge duplicates and build unique index.')
    return { applied: false, duplicateSets: inspection.duplicateCount }
  }

  console.log('\n[APPLY] Safely consolidating duplicate records...')
  let mergedSets = 0

  for (const group of inspection.duplicates) {
    const docs = await CandidateRecord.find({ _id: { $in: group.ids } }).sort({ createdAt: 1 })
    if (docs.length <= 1) continue

    const primary = docs[0]
    const duplicatesToRemove = docs.slice(1)

    // Merge missing fields into primary
    const mergedFields = { ...primary.fields }
    for (const dup of duplicatesToRemove) {
      for (const [k, v] of Object.entries(dup.fields || {})) {
        if (v != null && v !== '' && (mergedFields[k] == null || mergedFields[k] === '')) {
          mergedFields[k] = v
        }
      }
    }

    // Merge provenance without duplicates
    const provKeys = new Set(primary.provenance.map(p => `${p.fieldName}|${p.method}|${p.sourceUrl}|${p.value}`))
    const mergedProvenance = [...primary.provenance]
    for (const dup of duplicatesToRemove) {
      for (const p of dup.provenance || []) {
        const k = `${p.fieldName}|${p.method}|${p.sourceUrl}|${p.value}`
        if (!provKeys.has(k)) {
          provKeys.add(k)
          mergedProvenance.push(p)
        }
      }
    }

    // Update primary record
    await CandidateRecord.updateOne(
      { _id: primary._id },
      { $set: { fields: mergedFields, provenance: mergedProvenance.slice(0, 50) } }
    )

    // Remove merged duplicate records
    await CandidateRecord.deleteMany({ _id: { $in: duplicatesToRemove.map(d => d._id) } })
    mergedSets++
  }

  console.log(`Consolidated ${mergedSets} duplicate sets.`)

  // Now create the unique index
  console.log('Creating unique index { scanJobId: 1, candidateKey: 1 }...')
  try {
    await CandidateRecord.collection.dropIndex('scanJobId_1_candidateKey_1')
  } catch (err) {
    // Ignore if index didn't exist
  }
  await CandidateRecord.collection.createIndex({ scanJobId: 1, candidateKey: 1 }, { unique: true })
  console.log('Unique index created successfully.')

  return { applied: true, mergedSets }
}

if (process.argv[1]?.endsWith('deduplicateCandidates.js')) {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/leadintel'
  const apply = process.argv.includes('--apply')
  mongoose.connect(uri)
    .then(() => migrateDuplicates({ apply }))
    .then(() => mongoose.disconnect())
    .catch(err => { console.error('Migration error:', err); process.exit(1) })
}
