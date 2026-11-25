export function calculateProgressPercent(progress = {}, status = 'running') {
  if (status === 'completed') return 100
  if (status !== 'running') return null
  const discovered = Number(progress.urlsDiscovered) || 0
  if (discovered <= 0) return null
  const processed = Number(progress.urlsProcessed) || 0
  const actual = Math.max(0, Math.min(100, Math.round(processed * 100 / discovered)))
  // Active work must never communicate that all work finished.
  return Math.min(99, actual)
}

export function syncJobProgress(job) {
  job.progress = { ...(job.progress || {}), percent: calculateProgressPercent(job.progress, job.status) }
  // Keep the history field aligned with URL outcomes; HTTP requests are tracked separately.
  job.pagesProcessed = Number(job.progress.urlsProcessed) || 0
  return job.progress
}
