import { useState, useEffect, useCallback } from 'react'

const date = value => value ? new Date(value).toLocaleDateString() : '—'

export function CompaniesView({ request, onSelectCompany }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const [totalPages, setTotalPages] = useState(1)
  const [search, setSearch] = useState('')
  const [hasEmail, setHasEmail] = useState(false)
  const [hasPhone, setHasPhone] = useState(false)
  const [hasLinkedIn, setHasLinkedIn] = useState(false)
  const [sortBy, setSortBy] = useState('totalLeads')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  // Merge modal state
  const [showMergeModal, setShowMergeModal] = useState(false)
  const [allCompanies, setAllCompanies] = useState([])
  const [targetId, setTargetId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [merging, setMerging] = useState(false)

  const reload = useCallback(() => {
    setReloadKey(k => k + 1)
  }, [])

  useEffect(() => {
    let active = true
    const fetchCompanies = async () => {
      try {
        const qs = new URLSearchParams({
          page: String(page),
          limit: String(limit),
          paginated: 'true',
          sortBy,
        })
        if (search) qs.set('q', search)
        if (hasEmail) qs.set('hasEmail', 'true')
        if (hasPhone) qs.set('hasPhone', 'true')
        if (hasLinkedIn) qs.set('hasLinkedIn', 'true')

        const res = await request(`/companies?${qs}`)
        if (active) {
          setItems(res.items || [])
          setTotal(res.total || 0)
          setTotalPages(res.totalPages || 1)
          setLoading(false)
        }
      } catch (e) {
        if (active) {
          setError(e.message)
          setLoading(false)
        }
      }
    }
    void fetchCompanies()
    return () => { active = false }
  }, [page, limit, search, hasEmail, hasPhone, hasLinkedIn, sortBy, reloadKey, request])

  const openMergeModal = async () => {
    try {
      const list = await request('/companies')
      const companies = Array.isArray(list) ? list : list.items || []
      setAllCompanies(companies)
      if (companies.length >= 2) {
        setTargetId(companies[0]._id)
        setSourceId(companies[1]._id)
      }
      setShowMergeModal(true)
    } catch (e) {
      setError(e.message)
    }
  }

  const handleMerge = async () => {
    if (!targetId || !sourceId || targetId === sourceId) {
      setError('Please select two distinct companies to merge.')
      return
    }
    setMerging(true)
    setError('')
    try {
      const res = await request('/companies/merge', {
        method: 'POST',
        body: JSON.stringify({ targetCompanyId: targetId, sourceCompanyId: sourceId }),
      })
      setShowMergeModal(false)
      setNotice(res.message || 'Companies merged successfully.')
      reload()
    } catch (e) {
      setError(e.message)
    } finally {
      setMerging(false)
    }
  }

  const handleDeleteCompany = async (id, name, e) => {
    e?.stopPropagation()
    if (!window.confirm(`Delete company profile for "${name}"?\nAssociated leads will NOT be deleted; they will simply be unlinked.`)) return
    try {
      await request(`/companies/${id}`, { method: 'DELETE' })
      setNotice(`Company "${name}" deleted. Associated leads preserved.`)
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <section className="panel data-panel">
      {error && <div className="alert error" style={{ margin: '14px' }}>{error}<button onClick={() => setError('')}>×</button></div>}
      {notice && <div className="alert success" style={{ margin: '14px' }}>{notice}<button onClick={() => setNotice('')}>×</button></div>}

      <div style={{ padding: '15px 17px', borderBottom: '1px solid #edf0f2', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div className="search" style={{ maxWidth: '300px' }}>
            <span>⌕</span>
            <input
              placeholder="Search companies by name or domain..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button className="secondary" onClick={openMergeModal} title="Merge duplicate companies">
              ⇄ Merge Duplicate Companies
            </button>
            <button className="secondary" onClick={reload} title="Refresh">↻ Refresh</button>
          </div>
        </div>

        <div className="filter-pills">
          <span style={{ fontSize: '11px', color: '#88929c', marginRight: '4px' }}>Filters:</span>
          <button
            type="button"
            className={`filter-pill ${hasEmail ? 'active' : ''}`}
            onClick={() => { setHasEmail(!hasEmail); setPage(1) }}
          >
            ✉ Has Email
          </button>
          <button
            type="button"
            className={`filter-pill ${hasPhone ? 'active' : ''}`}
            onClick={() => { setHasPhone(!hasPhone); setPage(1) }}
          >
            📞 Has Phone
          </button>
          <button
            type="button"
            className={`filter-pill ${hasLinkedIn ? 'active' : ''}`}
            onClick={() => { setHasLinkedIn(!hasLinkedIn); setPage(1) }}
          >
            in Has LinkedIn
          </button>

          <span style={{ fontSize: '11px', color: '#88929c', marginLeft: '12px', marginRight: '4px' }}>Sort by:</span>
          <select
            value={sortBy}
            onChange={e => { setSortBy(e.target.value); setPage(1) }}
            style={{ height: '30px', border: '1px solid #d0d7de', borderRadius: '14px', padding: '0 8px', fontSize: '11px', background: '#fff' }}
          >
            <option value="totalLeads">Most Leads Found</option>
            <option value="name">Company Name (A-Z)</option>
            <option value="lastCrawledAt">Recently Crawled</option>
          </select>

          {(hasEmail || hasPhone || hasLinkedIn || search) && (
            <button
              className="text-button"
              style={{ color: '#c33', fontSize: '11px', padding: '2px 6px' }}
              onClick={() => {
                setHasEmail(false)
                setHasPhone(false)
                setHasLinkedIn(false)
                setSearch('')
                setPage(1)
              }}
            >
              Reset Filters
            </button>
          )}
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {['Company name', 'Domain / Website', 'Total leads', 'Contact coverage', 'Last crawled', 'Actions'].map(h => <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading && !items.length ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: '30px' }}>Loading companies directory...</td></tr>
            ) : items.length ? (
              items.map(comp => (
                <tr key={comp._id} onClick={() => onSelectCompany?.(comp._id)}>
                  <td>
                    <b>{comp.name || '—'}</b>
                    {comp.industry && <small style={{ display: 'block', color: '#88929c', marginTop: '2px' }}>{comp.industry}</small>}
                  </td>
                  <td>
                    {comp.domain || comp.website ? (
                      <a
                        href={comp.website || `https://${comp.domain}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                        style={{ color: '#24534a', fontWeight: '500' }}
                      >
                        {comp.domain || comp.website} ↗
                      </a>
                    ) : '—'}
                  </td>
                  <td>
                    <span className="coverage-badge" style={{ background: '#eaf4ee', color: '#23584d', fontWeight: '700' }}>
                      {comp.totalLeads || 0} Lead{comp.totalLeads === 1 ? '' : 's'}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      <span className="coverage-badge email" title="Leads with email">
                        ✉ {comp.emailCount || 0}
                      </span>
                      <span className="coverage-badge phone" title="Leads with phone">
                        📞 {comp.phoneCount || 0}
                      </span>
                      <span className="coverage-badge linkedin" title="Leads with LinkedIn profile">
                        in {comp.linkedInCount || 0}
                      </span>
                    </div>
                  </td>
                  <td>{date(comp.lastCrawledAt || comp.updatedAt || comp.createdAt)}</td>
                  <td>
                    <button
                      className="text-button"
                      style={{ marginRight: '8px' }}
                      onClick={(e) => { e.stopPropagation(); onSelectCompany?.(comp._id) }}
                    >
                      View Profile →
                    </button>
                    <button
                      className="text-button"
                      style={{ color: '#c33', fontSize: '13px' }}
                      title="Delete company"
                      onClick={(e) => handleDeleteCompany(comp._id, comp.name, e)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="6" style={{ textAlign: 'center', padding: '35px', color: '#88929c' }}>
                  No companies found matching your search or filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination-bar">
        <span>Showing {items.length} of {total} companies</span>
        <div className="pagination-controls">
          <select
            value={limit}
            onChange={e => { setLimit(Number(e.target.value)); setPage(1) }}
            style={{ height: '26px', border: '1px solid #d0d7de', borderRadius: '4px', fontSize: '11px', marginRight: '8px' }}
          >
            <option value="15">15 per page</option>
            <option value="25">25 per page</option>
            <option value="50">50 per page</option>
          </select>
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

      {/* Merge Companies Modal */}
      {showMergeModal && (
        <div className="modal-backdrop" onClick={() => setShowMergeModal(false)}>
          <div className="detail-modal" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => setShowMergeModal(false)}>×</button>
            <div className="eyebrow">CONSOLIDATE DUPLICATES</div>
            <h2>Merge Companies</h2>
            <p style={{ fontSize: '12px', color: '#556270', lineHeight: 1.5 }}>
              Consolidate duplicate companies into one canonical company profile. All associated leads, contact information, and metadata will be merged.
            </p>

            <div className="form-group" style={{ marginTop: '16px' }}>
              <label>Target Company (Keep and consolidate into):</label>
              <select value={targetId} onChange={e => setTargetId(e.target.value)}>
                {allCompanies.map(c => (
                  <option key={c._id} value={c._id}>
                    {c.name} {c.domain ? `(${c.domain})` : ''} — {c.totalLeads || 0} leads
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>Source Company (Duplicate to merge from and remove):</label>
              <select value={sourceId} onChange={e => setSourceId(e.target.value)}>
                {allCompanies.map(c => (
                  <option key={c._id} value={c._id} disabled={c._id === targetId}>
                    {c.name} {c.domain ? `(${c.domain})` : ''} — {c.totalLeads || 0} leads
                  </option>
                ))}
              </select>
            </div>

            <div className="warning-box">
              <strong>Merge Policy:</strong> All leads currently linked to the Source Company will be reassigned to the Target Company. Contact details and website info will be combined without duplicates, and the Source Company record will be safely removed.
            </div>

            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowMergeModal(false)} disabled={merging}>
                Cancel
              </button>
              <button className="primary" onClick={handleMerge} disabled={merging || targetId === sourceId}>
                {merging ? 'Merging...' : 'Confirm & Merge Companies'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
