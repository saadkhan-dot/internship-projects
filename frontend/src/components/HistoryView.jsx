import { useState, useEffect, useCallback } from 'react'

const date = value => value ? new Date(value).toLocaleString() : '—'

export function HistoryView({ request, onRetry, onCancel, onCleared }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [limit] = useState(20)
  const [totalPages, setTotalPages] = useState(1)
  const [summary, setSummary] = useState({ total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0 })
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedJob, setSelectedJob] = useState(null)
  const [showClearModal, setShowClearModal] = useState(false)
  const [confirmDeleteJob, setConfirmDeleteJob] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const hasActiveScans = (summary.running || 0) > 0 || (summary.queued || 0) > 0

  const reload = useCallback(() => {
    setReloadKey(k => k + 1)
  }, [])

  useEffect(() => {
    let active = true
    const fetchHistory = async () => {
      try {
        const qs = new URLSearchParams({
          page: String(page),
          limit: String(limit),
        })
        if (statusFilter) qs.set('status', statusFilter)
        if (search) qs.set('search', search)

        const res = await request(`/history?${qs}`)
        if (active) {
          setItems(res.items || [])
          setTotal(res.total || 0)
          setTotalPages(res.totalPages || 1)
          if (res.summary) setSummary(res.summary)
          setLoading(false)
        }
      } catch (e) {
        if (active) {
          setError(e.message)
          setLoading(false)
        }
      }
    }
    void fetchHistory()
    return () => { active = false }
  }, [page, limit, statusFilter, search, reloadKey, request])

  const handleClearHistory = async () => {
    setClearing(true)
    setError('')
    try {
      const res = await request('/history', { method: 'DELETE' })
      setShowClearModal(false)
      setNotice(res.message || 'All scan history and CRM data cleared successfully.')
      setPage(1)
      reload()
      onCleared?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setClearing(false)
    }
  }

  const handleDeleteSession = (job, e) => {
    e?.stopPropagation()
    setConfirmDeleteJob(job)
  }

  const executeDeleteSession = async () => {
    if (!confirmDeleteJob?._id) return
    setDeleting(true)
    setError('')
    try {
      const res = await request(`/history/${confirmDeleteJob._id}`, { method: 'DELETE' })
      setConfirmDeleteJob(null)
      if (selectedJob?._id === confirmDeleteJob._id) setSelectedJob(null)
      setNotice(res.message || 'Crawl session deleted from history.')
      if (items.length <= 1 && page > 1) {
        setPage(p => p - 1)
      } else {
        reload()
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setDeleting(false)
    }
  }

  const openDetails = async (job) => {
    try {
      const fullJob = await request(`/history/${job._id}`)
      setSelectedJob(fullJob)
    } catch {
      setSelectedJob(job)
    }
  }

  return (
    <section className="panel data-panel">
      {error && <div className="alert error" style={{ margin: '14px' }}>{error}<button onClick={() => setError('')}>×</button></div>}
      {notice && <div className="alert success" style={{ margin: '14px' }}>{notice}<button onClick={() => setNotice('')}>×</button></div>}

      <div style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #edf0f2', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="search" style={{ maxWidth: '240px' }}>
            <span>⌕</span>
            <input
              placeholder="Search website target..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
            style={{ height: '36px', border: '1px solid #e3e7eb', borderRadius: '5px', padding: '0 8px', fontSize: '11px', background: '#fff' }}
          >
            <option value="">All statuses ({summary.total})</option>
            <option value="completed">Completed ({summary.completed})</option>
            <option value="running">Running ({summary.running})</option>
            <option value="queued">Queued ({summary.queued})</option>
            <option value="failed">Failed ({summary.failed})</option>
            <option value="cancelled">Cancelled ({summary.cancelled})</option>
          </select>
          <button className="secondary" onClick={reload} title="Refresh">↻ Refresh</button>
        </div>

        <button
          className="danger"
          style={{ marginTop: 0 }}
          onClick={() => setShowClearModal(true)}
          title="Clear all past crawl history and CRM records"
        >
          🗑 Clear All History
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {['Target website', 'Status', 'Started at', 'Duration', 'Pages (Att/Fetch)', 'Leads', 'Actions'].map(h => <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading && !items.length ? (
              <tr><td colSpan="7" style={{ textAlign: 'center', padding: '30px' }}>Loading crawl history...</td></tr>
            ) : items.length ? (
              items.map(job => (
                <tr key={job._id} onClick={() => openDetails(job)}>
                  <td><b>{job.target}</b></td>
                  <td><span className={`status ${job.status}`}>{job.status}</span></td>
                  <td>{date(job.startedAt || job.createdAt)}</td>
                  <td>{job.durationFormatted || '—'}</td>
                  <td>
                    {job.progress?.pagesAttempted ?? job.pagesProcessed ?? 0} / {job.progress?.pagesFetched ?? '—'}
                  </td>
                  <td><b>{job.leadsFound || 0}</b></td>
                  <td>
                    <button
                      className="text-button"
                      style={{ marginRight: '6px' }}
                      onClick={(e) => { e.stopPropagation(); openDetails(job) }}
                    >
                      Details
                    </button>
                    {job.status === 'failed' && (
                      <button
                        className="action-btn retry"
                        onClick={(e) => { e.stopPropagation(); onRetry?.(job._id) }}
                      >
                        ↻ Retry
                      </button>
                    )}
                    {['queued', 'running'].includes(job.status) && (
                      <button
                        className="action-btn cancel"
                        onClick={(e) => { e.stopPropagation(); onCancel?.(job._id) }}
                      >
                        Cancel
                      </button>
                    )}
                    {!['queued', 'running', 'cancelling'].includes(job.status) && (
                      <button
                        className="text-button"
                        style={{ color: '#c33', fontSize: '13px' }}
                        title="Delete session"
                        onClick={(e) => handleDeleteSession(job, e)}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '35px', color: '#88929c' }}>
                  No crawl history records match your search or filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination-bar">
        <span>Showing {items.length} of {total} crawl session(s)</span>
        <div className="pagination-controls">
          <button
            className="page-btn"
            disabled={page <= 1 || loading}
            onClick={() => setPage(p => Math.max(1, p - 1))}
          >
            ← Previous
          </button>
          <span>Page {page} of {totalPages}</span>
          <button
            className="page-btn"
            disabled={page >= totalPages || loading}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          >
            Next →
          </button>
        </div>
      </div>

      {/* Individual Session Delete Confirmation Modal */}
      {confirmDeleteJob && (
        <div className="modal-backdrop" onClick={() => setConfirmDeleteJob(null)}>
          <div className="detail-modal" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => setConfirmDeleteJob(null)}>×</button>
            <div className="eyebrow" style={{ color: '#c33' }}>CONFIRM SESSION DELETION</div>
            <h2>Delete Crawl Session</h2>
            <p style={{ fontSize: '12px', color: '#556270', lineHeight: 1.6 }}>
              Are you sure you want to delete the crawl session for <b>{confirmDeleteJob.target}</b>?
            </p>
            <div className="warning-box">
              <strong>DATA INTEGRITY & CLEANUP GUARANTEE:</strong>
              <br />
              Deleting this crawl session will permanently remove its history record, crawled page cache, and temporary discovery candidates.
              <br /><br />
              <b>Shared CRM data is strictly preserved:</b> Any qualified leads, active CRM profiles, and companies referenced by other scans or user activities will remain safe and intact.
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setConfirmDeleteJob(null)} disabled={deleting}>
                Cancel
              </button>
              <button className="danger-button" onClick={executeDeleteSession} disabled={deleting}>
                {deleting ? 'Deleting Session...' : 'Confirm & Delete Session'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear All History Confirmation Modal */}
      {showClearModal && (
        <div className="modal-backdrop" onClick={() => !clearing && setShowClearModal(false)}>
          <div className="detail-modal" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => !clearing && setShowClearModal(false)}>×</button>
            <div className="eyebrow" style={{ color: '#c33' }}>PERMANENT DATA RESET WARNING</div>
            <h2>Clear All History & Reset Data</h2>
            <p style={{ fontSize: '12px', color: '#556270', lineHeight: 1.6 }}>
              Are you sure you want to completely clear all history? This action permanently wipes <b>ALL</b> scan sessions, discovered candidates, crawled page data, and <b>ALL CRM records</b> (including all leads, people profiles, and company profiles).
            </p>
            <div className="warning-box" style={{ borderColor: '#e03131', background: '#fff5f5' }}>
              <strong style={{ color: '#c92a2a' }}>COMPLETE SYSTEM RESET:</strong>
              <br />
              All history, discovered candidates, qualified leads, people profiles, and company profiles will be permanently erased.
              <br /><br />
              {hasActiveScans ? (
                <span style={{ color: '#c92a2a', fontWeight: 'bold' }}>
                  ⚠️ Cannot clear history while scans are actively running or queued ({summary.running || 0} running, {summary.queued || 0} queued). Please cancel or allow active scans to finish first.
                </span>
              ) : (
                <span>After this action, all scan and CRM counts will reset to 0. This action cannot be undone.</span>
              )}
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowClearModal(false)} disabled={clearing}>
                Cancel
              </button>
              <button
                className="danger-button"
                onClick={handleClearHistory}
                disabled={clearing || hasActiveScans}
              >
                {clearing ? 'Clearing All Data...' : 'Confirm & Wipe All Data'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session Details Modal */}
      {selectedJob && (
        <div className="modal-backdrop" onClick={() => setSelectedJob(null)}>
          <div className="detail-modal wide-modal" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => setSelectedJob(null)}>×</button>
            <div className="eyebrow">CRAWL SESSION DETAILS</div>
            <h2>{selectedJob.target}</h2>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px' }}>
              <span className={`status ${selectedJob.status}`}>{selectedJob.status}</span>
              <span style={{ fontSize: '11px', color: '#88929c' }}>Duration: {selectedJob.durationFormatted || '—'}</span>
            </div>

            <div className="detail-grid">
              <div>
                <small>Website Target</small>
                <b>{selectedJob.target}</b>
              </div>
              <div>
                <small>Started At</small>
                <b>{date(selectedJob.startedAt || selectedJob.createdAt)}</b>
              </div>
              <div>
                <small>Ended At</small>
                <b>{date(selectedJob.endedAt)}</b>
              </div>
              <div>
                <small>Pages Discovered</small>
                <b>{selectedJob.progress?.urlsDiscovered || 0}</b>
              </div>
              <div>
                <small>Pages Attempted / Fetched</small>
                <b>{selectedJob.progress?.pagesAttempted || selectedJob.pagesProcessed || 0} / {selectedJob.progress?.pagesFetched || 0}</b>
              </div>
              <div>
                <small>Failed HTTP Requests</small>
                <b>{selectedJob.progress?.failedRequests || 0}</b>
              </div>
              <div>
                <small>Leads Discovered</small>
                <b>{selectedJob.leadsFound || selectedJob.leadsCount || 0}</b>
              </div>
              <div>
                <small>Max Pages / Depth</small>
                <b>{selectedJob.options?.maxPages || 100} / {selectedJob.options?.maxDepth ?? 3}</b>
              </div>
            </div>

            {selectedJob.failureReason && (
              <div className="alert error" style={{ marginTop: '16px' }}>
                <b>Failure Reason:</b> {selectedJob.failureReason}
              </div>
            )}

            <div style={{ marginTop: '20px' }}>
              <div className="panel-head">
                <div>
                  <h3 style={{ margin: 0, fontSize: '13px' }}>Session Activity Logs ({selectedJob.logs?.length || 0})</h3>
                </div>
              </div>
              <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid #eff1f3', borderRadius: '5px', padding: '10px', background: '#fafbfc' }}>
                {selectedJob.logs?.length ? (
                  selectedJob.logs.map((l, idx) => (
                    <div key={idx} style={{ fontSize: '10px', lineHeight: 1.6, color: '#495057', borderBottom: '1px solid #f1f3f5', padding: '4px 0' }}>
                      <span style={{ color: '#88929c', marginRight: '8px' }}>{date(l.at)}</span>
                      <span>{l.message}</span>
                    </div>
                  ))
                ) : (
                  <div style={{ fontSize: '11px', color: '#9aa3ad', textAlign: 'center', padding: '10px' }}>No logs recorded.</div>
                )}
              </div>
            </div>

            {!['queued', 'running', 'cancelling'].includes(selectedJob.status) && (
              <div style={{ marginTop: '20px', borderTop: '1px solid #eff1f3', paddingTop: '15px', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  className="danger"
                  style={{ marginTop: 0 }}
                  onClick={() => {
                    const job = selectedJob
                    setSelectedJob(null)
                    setConfirmDeleteJob(job)
                  }}
                >
                  🗑 Delete This Crawl Session
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
