const terminal = new Set(['completed', 'failed', 'cancelled'])
const rank = { queued: 0, running: 1, cancelling: 2, completed: 3, failed: 3, cancelled: 3 }

export function preferNewerJob(previous, incoming) {
  if (!incoming) return previous
  if (!previous || previous._id !== incoming._id) return previous || incoming
  const oldTime = Date.parse(previous.updatedAt || '')
  const newTime = Date.parse(incoming.updatedAt || '')
  if (Number.isFinite(oldTime) && Number.isFinite(newTime) && newTime < oldTime) return previous
  if (terminal.has(previous.status) && !terminal.has(incoming.status)) return previous
  if (oldTime === newTime && (rank[previous.status] || 0) > (rank[incoming.status] || 0)) return previous
  return incoming
}
