import { useState, useEffect, useCallback } from 'react'

const date = value => value ? new Date(value).toLocaleString() : '—'

export function CompanyDetailView({ API, request, companyId, onBack, onSelectLead }) {
  const [company, setCompany] = useState(null)
  const [leads, setLeads] = useState([])
  const [totalLeads, setTotalLeads] = useState(0)
  const [leadsPage, setLeadsPage] = useState(1)
  const [leadsLimit] = useState(25)
  const [leadsTotalPages, setLeadsTotalPages] = useState(1)
  const [search, setSearch] = useState('')
  const [hasEmail, setHasEmail] = useState(false)
  const [hasPhone, setHasPhone] = useState(false)
  const [hasLinkedIn, setHasLinkedIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => {
    setReloadKey(k => k + 1)
  }, [])

  useEffect(() => {
    let active = true
    const fetchData = async () => {
      try {
        const qs = new URLSearchParams({
          page: String(leadsPage),
          limit: String(leadsLimit),
          paginated: 'true',
        })
        if (search) qs.set('q', search)
        if (hasEmail) qs.set('hasEmail', 'true')
        if (hasPhone) qs.set('hasPhone', 'true')
        if (hasLinkedIn) qs.set('hasLinkedIn', 'true')

        const [compData, leadsData] = await Promise.all([
          request(`/companies/${companyId}`),
          request(`/companies/${companyId}/leads?${qs}`),
        ])

        if (active) {
          setCompany(compData)
          setLeads(leadsData.items || [])
          setTotalLeads(leadsData.total || 0)
          setLeadsTotalPages(leadsData.totalPages || 1)
          setLoading(false)
        }
      } catch (e) {
        if (active) {
          setError(e.message)
          setLoading(false)
        }
      }
    }
    void fetchData()
    return () => { active = false }
  }, [companyId, leadsPage, leadsLimit, search, hasEmail, hasPhone, hasLinkedIn, reloadKey, request])

  const handleUpdateStatus = async (id, status) => {
    try {
      await request(`/leads/${id}`, { method: 'PUT', body: JSON.stringify({ status }) })
      setLeads(old => old.map(l => l._id === id ? { ...l, status } : l))
      setNotice('Lead status updated.')
    } catch (e) {
      setError(e.message)
    }
  }

  const handleDeleteLead = async (id, e) => {
    e?.stopPropagation()
    if (!window.confirm('Delete this lead?')) return
    try {
      await request(`/leads/${id}`, { method: 'DELETE' })
      setLeads(old => old.filter(l => l._id !== id))
      setTotalLeads(t => Math.max(0, t - 1))
      setNotice('Lead deleted.')
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  const handleExportCsv = async () => {
    setExporting(true)
    setError('')
    try {
      const response = await fetch(`${API}/companies/${companyId}/export`)
      if (!response.ok) throw new Error('Failed to export company leads CSV.')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const cleanName = (company?.name || 'company').toLowerCase().replace(/[^a-z0-9_-]/g, '_')
      a.download = `leadintel-${cleanName}-leads-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setNotice('Export complete. Download started.')
    } catch (e) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

  const handleDeleteCompany = async () => {
    try {
      await request(`/companies/${companyId}`, { method: 'DELETE' })
      onBack()
    } catch (e) {
      setError(e.message)
      setShowDeleteModal(false)
    }
  }

  if (loading && !company) {
    return <div className="panel data-panel" style={{ padding: '40px', textAlign: 'center' }}>Loading company profile...</div>
  }

  if (!company) {
    return (
      <div className="panel data-panel" style={{ padding: '30px', textAlign: 'center' }}>
        <p>Company profile not found.</p>
        <button className="primary" onClick={onBack}>← Back to Companies</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '16px' }}>
        <button className="text-button" onClick={onBack} style={{ fontSize: '12px' }}>
          ← Back to Companies Directory
        </button>
      </div>

      {error && <div className="alert error">{error}<button onClick={() => setError('')}>×</button></div>}
      {notice && <div className="alert success">{notice}<button onClick={() => setNotice('')}>×</button></div>}

      {/* Company Header Card */}
      <div className="company-header-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '14px' }}>
          <div>
            <div className="eyebrow" style={{ color: '#24534a' }}>COMPANY PROFILE</div>
            <h2>{company.name}</h2>
            {company.description && <p>{company.description}</p>}
            <div className="company-meta-row">
              {company.domain && (
                <span>
                  <b>Domain:</b> {company.domain}
                </span>
              )}
              {company.website && (
                <span>
                  <b>Website:</b>{' '}
                  <a href={company.website} target="_blank" rel="noreferrer">
                    {company.website} ↗
                  </a>
                </span>
              )}
              {company.industry && (
                <span>
                  <b>Industry:</b> {company.industry}
                </span>
              )}
              <span>
                <b>Last Discovered:</b> {date(company.lastCrawledAt || company.updatedAt)}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button className="secondary" onClick={handleExportCsv} disabled={exporting || totalLeads === 0}>
              {exporting ? 'Exporting...' : '↓ Export Company Leads (CSV)'}
            </button>
            <button className="danger" style={{ marginTop: 0 }} onClick={() => setShowDeleteModal(true)}>
              Delete Company
            </button>
          </div>
        </div>

        {/* Coverage Badges Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginTop: '22px', borderTop: '1px solid #eff1f3', paddingTop: '16px' }}>
          <div style={{ background: '#f8faf9', padding: '12px', borderRadius: '6px' }}>
            <small style={{ fontSize: '10px', color: '#88929c', textTransform: 'uppercase' }}>Total Discovered</small>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#202a37', marginTop: '4px' }}>
              {company.totalLeads || totalLeads || 0}
            </div>
          </div>
          <div style={{ background: '#f0f7fc', padding: '12px', borderRadius: '6px' }}>
            <small style={{ fontSize: '10px', color: '#1971c2', textTransform: 'uppercase' }}>With Email</small>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#1971c2', marginTop: '4px' }}>
              {company.emailCount || 0}
            </div>
          </div>
          <div style={{ background: '#f0f9f3', padding: '12px', borderRadius: '6px' }}>
            <small style={{ fontSize: '10px', color: '#2b8a3e', textTransform: 'uppercase' }}>With Phone</small>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#2b8a3e', marginTop: '4px' }}>
              {company.phoneCount || 0}
            </div>
          </div>
          <div style={{ background: '#f0f7fe', padding: '12px', borderRadius: '6px' }}>
            <small style={{ fontSize: '10px', color: '#0077b5', textTransform: 'uppercase' }}>With LinkedIn</small>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#0077b5', marginTop: '4px' }}>
              {company.linkedInCount || 0}
            </div>
          </div>
        </div>
      </div>

      {/* Associated Leads Table */}
      <section className="panel data-panel" style={{ marginBottom: '24px' }}>
        <div style={{ padding: '15px 17px', borderBottom: '1px solid #edf0f2', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div className="search" style={{ maxWidth: '280px' }}>
            <span>⌕</span>
            <input
              placeholder="Search leads in this company..."
              value={search}
              onChange={e => { setSearch(e.target.value); setLeadsPage(1) }}
            />
          </div>

          <div className="filter-pills">
            <button
              type="button"
              className={`filter-pill ${hasEmail ? 'active' : ''}`}
              onClick={() => { setHasEmail(!hasEmail); setLeadsPage(1) }}
            >
              ✉ Has Email
            </button>
            <button
              type="button"
              className={`filter-pill ${hasPhone ? 'active' : ''}`}
              onClick={() => { setHasPhone(!hasPhone); setLeadsPage(1) }}
            >
              📞 Has Phone
            </button>
            <button
              type="button"
              className={`filter-pill ${hasLinkedIn ? 'active' : ''}`}
              onClick={() => { setHasLinkedIn(!hasLinkedIn); setLeadsPage(1) }}
            >
              in Has LinkedIn
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {['Name', 'Title / Role', 'Email', 'Phone', 'LinkedIn', 'Status', 'Discovered', 'Action'].map(h => <th key={h}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {leads.length ? (
                leads.map(l => (
                  <tr key={l._id} onClick={() => onSelectLead?.(l)}>
                    <td><b>{l.name}</b></td>
                    <td>{l.title || '—'}</td>
                    <td>
                      {l.email ? (
                        <a href={`mailto:${l.email}`} onClick={e => e.stopPropagation()}>
                          {l.email}
                        </a>
                      ) : '—'}
                    </td>
                    <td>
                      {l.phone ? (
                        <a href={`tel:${l.phone}`} onClick={e => e.stopPropagation()}>
                          {l.phone}
                        </a>
                      ) : '—'}
                    </td>
                    <td>
                      {l.linkedinUrl ? (
                        <a
                          href={l.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          style={{ color: '#0077b5' }}
                        >
                          Profile ↗
                        </a>
                      ) : '—'}
                    </td>
                    <td>
                      <select
                        value={l.status || 'new'}
                        onChange={e => handleUpdateStatus(l._id, e.target.value)}
                        onClick={e => e.stopPropagation()}
                        style={{
                          padding: '2px 6px',
                          fontSize: '11px',
                          borderRadius: '4px',
                          textTransform: 'capitalize',
                          border: '1px solid #d0d7de',
                          background: '#fff',
                        }}
                      >
                        <option value="new">New</option>
                        <option value="contacted">Contacted</option>
                        <option value="qualified">Qualified</option>
                        <option value="unqualified">Unqualified</option>
                        <option value="archived">Archived</option>
                      </select>
                    </td>
                    <td>{date(l.discoveredAt)}</td>
                    <td>
                      <button
                        className="text-button"
                        style={{ color: '#c33', fontSize: '13px' }}
                        title="Delete lead"
                        onClick={(e) => handleDeleteLead(l._id, e)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="8" style={{ textAlign: 'center', padding: '30px', color: '#88929c' }}>
                    No leads registered for this company yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="pagination-bar">
          <span>Showing {leads.length} of {totalLeads} lead(s) for {company.name}</span>
          <div className="pagination-controls">
            <button
              className="page-btn"
              disabled={leadsPage <= 1}
              onClick={() => setLeadsPage(p => Math.max(1, p - 1))}
            >
              ← Previous
            </button>
            <span>Page {leadsPage} of {leadsTotalPages}</span>
            <button
              className="page-btn"
              disabled={leadsPage >= leadsTotalPages}
              onClick={() => setLeadsPage(p => Math.min(leadsTotalPages, p + 1))}
            >
              Next →
            </button>
          </div>
        </div>
      </section>

      {/* Associated Crawl History */}
      {company.recentScans?.length > 0 && (
        <section className="panel data-panel">
          <div className="panel-head" style={{ padding: '16px 17px 0' }}>
            <div>
              <h2>Associated Crawl History</h2>
              <p>Past scan sessions targeting this company domain</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {['Target', 'Status', 'Date', 'Pages Processed', 'Leads Found'].map(h => <th key={h}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {company.recentScans.map(s => (
                  <tr key={s._id}>
                    <td><b>{s.target}</b></td>
                    <td><span className={`status ${s.status}`}>{s.status}</span></td>
                    <td>{date(s.createdAt)}</td>
                    <td>{s.pagesProcessed || 0}</td>
                    <td><b>{s.leadsFound || 0}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Delete Company Modal */}
      {showDeleteModal && (
        <div className="modal-backdrop" onClick={() => setShowDeleteModal(false)}>
          <div className="detail-modal" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => setShowDeleteModal(false)}>×</button>
            <div className="eyebrow" style={{ color: '#c33' }}>DELETE COMPANY PROFILE</div>
            <h2>Delete "{company.name}"?</h2>
            <p style={{ fontSize: '12px', color: '#556270', lineHeight: 1.6 }}>
              Are you sure you want to delete this company profile?
            </p>
            <div className="warning-box">
              <strong>LEAD PRESERVATION POLICY:</strong>
              <br />
              Deleting this company profile will <b>NOT delete any leads</b>. All associated leads will simply be unlinked and remain fully accessible in the centralized Leads directory.
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowDeleteModal(false)}>
                Cancel
              </button>
              <button className="danger-button" onClick={handleDeleteCompany}>
                Confirm & Delete Company
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
