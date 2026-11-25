import { useState, useEffect, useCallback } from 'react'

const date = value => value ? new Date(value).toLocaleString() : '—'

export function LeadsView({ API, request, onSelectCompany }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(50)
  const [totalPages, setTotalPages] = useState(1)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('discoveredAt')
  const [sortOrder, setSortOrder] = useState('desc')
  const [hasEmail, setHasEmail] = useState(false)
  const [hasPhone, setHasPhone] = useState(false)
  const [hasLinkedIn, setHasLinkedIn] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [companiesList, setCompaniesList] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedLead, setSelectedLead] = useState(null)
  const [isEditingLead, setIsEditingLead] = useState(false)
  const [editForm, setEditForm] = useState({})
  const [savingLead, setSavingLead] = useState(false)
  const [confirmDeleteLead, setConfirmDeleteLead] = useState(null)
  const [deletingLead, setDeletingLead] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [selectedLeadIds, setSelectedLeadIds] = useState([])

  const toggleSelectAll = () => {
    if (items.length > 0 && selectedLeadIds.length === items.length) {
      setSelectedLeadIds([])
    } else {
      setSelectedLeadIds(items.map(l => l._id))
    }
  }

  const toggleSelectLead = (id, e) => {
    e?.stopPropagation()
    setSelectedLeadIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id])
  }

  const reload = useCallback(() => {
    setReloadKey(k => k + 1)
  }, [])

  useEffect(() => {
    // Load companies for the filter dropdown
    request('/companies')
      .then(res => setCompaniesList(Array.isArray(res) ? res : res.items || []))
      .catch(() => {})
  }, [request])

  useEffect(() => {
    let active = true
    const fetchLeads = async () => {
      try {
        const qs = new URLSearchParams({
          page: String(page),
          limit: String(limit),
          paginated: 'true',
          sortBy,
          sortOrder,
        })
        if (search) qs.set('q', search)
        if (hasEmail) qs.set('hasEmail', 'true')
        if (hasPhone) qs.set('hasPhone', 'true')
        if (hasLinkedIn) qs.set('hasLinkedIn', 'true')
        if (statusFilter) qs.set('status', statusFilter)
        if (entityFilter) qs.set('type', entityFilter)
        if (companyFilter) qs.set('companyId', companyFilter)

        const res = await request(`/leads?${qs}`)
        if (active) {
          setItems(res.items || [])
          setTotal(res.total || 0)
          setTotalPages(res.totalPages || 1)
          setSelectedLeadIds([])
          setLoading(false)
        }
      } catch (e) {
        if (active) {
          setError(e.message)
          setLoading(false)
        }
      }
    }
    void fetchLeads()
    return () => { active = false }
  }, [page, limit, search, sortBy, sortOrder, hasEmail, hasPhone, hasLinkedIn, statusFilter, entityFilter, companyFilter, reloadKey, request])

  const handleOpenLead = (lead) => {
    setSelectedLead(lead)
    setIsEditingLead(false)
    setEditForm({
      name: lead.name || '',
      title: lead.title || '',
      company: lead.company || '',
      email: lead.email || '',
      phone: lead.phone || '',
      linkedinUrl: lead.linkedinUrl || '',
      status: lead.status || 'new',
      biography: lead.biography || '',
      notes: lead.notes || '',
    })
  }

  const handleSaveLead = async (e) => {
    e.preventDefault()
    if (!selectedLead?._id) return
    setSavingLead(true)
    setError('')
    try {
      const updated = await request(`/leads/${selectedLead._id}`, {
        method: 'PUT',
        body: JSON.stringify(editForm),
      })
      setSelectedLead(updated)
      setItems(old => old.map(l => l._id === updated._id ? { ...l, ...updated } : l))
      setIsEditingLead(false)
      setNotice('Lead details updated successfully.')
    } catch (err) {
      setError(err.message || 'Failed to update lead.')
    } finally {
      setSavingLead(false)
    }
  }

  const handleUpdateStatus = async (id, status) => {
    try {
      await request(`/leads/${id}`, { method: 'PUT', body: JSON.stringify({ status }) })
      setItems(old => old.map(l => l._id === id ? { ...l, status } : l))
      if (selectedLead?._id === id) {
        setSelectedLead(prev => prev ? { ...prev, status } : null)
      }
      setNotice('Lead status updated.')
    } catch (e) {
      setError(e.message)
    }
  }

  const handleDeleteLead = (leadOrId, e) => {
    e?.stopPropagation()
    const targetLead = typeof leadOrId === 'object' ? leadOrId : items.find(l => l._id === leadOrId) || { _id: leadOrId }
    setConfirmDeleteLead(targetLead)
  }

  const executeDeleteLead = async () => {
    if (!confirmDeleteLead?._id) return
    setDeletingLead(true)
    setError('')
    try {
      await request(`/leads/${confirmDeleteLead._id}`, { method: 'DELETE' })
      setItems(old => old.filter(l => l._id !== confirmDeleteLead._id))
      setSelectedLeadIds(old => old.filter(id => id !== confirmDeleteLead._id))
      setTotal(t => Math.max(0, t - 1))
      if (selectedLead?._id === confirmDeleteLead._id) setSelectedLead(null)
      setConfirmDeleteLead(null)
      setNotice('Lead deleted successfully.')
    } catch (e) {
      setError(e.message || 'Failed to delete lead.')
    } finally {
      setDeletingLead(false)
    }
  }

  const handleExportCsv = async () => {
    setExporting(true)
    setError('')
    try {
      const qs = new URLSearchParams()
      if (selectedLeadIds.length > 0) {
        qs.set('ids', selectedLeadIds.join(','))
      } else {
        if (search) qs.set('q', search)
        if (hasEmail) qs.set('hasEmail', 'true')
        if (hasPhone) qs.set('hasPhone', 'true')
        if (hasLinkedIn) qs.set('hasLinkedIn', 'true')
        if (statusFilter) qs.set('status', statusFilter)
        if (entityFilter) qs.set('type', entityFilter)
        if (companyFilter) qs.set('companyId', companyFilter)
      }

      const response = await fetch(`${API}/leads/export?${qs}`)
      if (!response.ok) throw new Error('Failed to export leads CSV.')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `leadintel-leads-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setNotice(`Export complete. Download started${selectedLeadIds.length > 0 ? ` for ${selectedLeadIds.length} selected lead(s)` : ''}.`)
    } catch (e) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="panel data-panel">
      {error && <div className="alert error" style={{ margin: '14px' }}>{error}<button onClick={() => setError('')}>×</button></div>}
      {notice && <div className="alert success" style={{ margin: '14px' }}>{notice}<button onClick={() => setNotice('')}>×</button></div>}

      <div style={{ padding: '15px 17px', borderBottom: '1px solid #edf0f2', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', flex: 1 }}>
            <div className="search" style={{ maxWidth: '320px', minWidth: '220px' }}>
              <span>⌕</span>
              <input
                placeholder="Search by name, role, email, phone, or company..."
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1) }}
              />
            </div>

            <select
              value={`${sortBy}-${sortOrder}`}
              onChange={e => {
                const [f, o] = e.target.value.split('-')
                setSortBy(f)
                setSortOrder(o)
                setPage(1)
              }}
              style={{ height: '32px', border: '1px solid #d0d7de', borderRadius: '14px', padding: '0 10px', fontSize: '11px', background: '#fff' }}
            >
              <option value="discoveredAt-desc">Sort: Newest First</option>
              <option value="discoveredAt-asc">Sort: Oldest First</option>
              <option value="name-asc">Sort: Name (A-Z)</option>
              <option value="name-desc">Sort: Name (Z-A)</option>
              <option value="company-asc">Sort: Company (A-Z)</option>
              <option value="status-asc">Sort: Status</option>
            </select>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="secondary"
              onClick={handleExportCsv}
              disabled={exporting || (total === 0 && selectedLeadIds.length === 0)}
            >
              {exporting ? 'Generating CSV...' : selectedLeadIds.length > 0 ? `↓ Export Selected (${selectedLeadIds.length}) to CSV` : `↓ Export Filtered (${total}) to CSV`}
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

          <select
            value={entityFilter}
            onChange={e => { setEntityFilter(e.target.value); setPage(1) }}
            style={{ height: '30px', border: '1px solid #d0d7de', borderRadius: '14px', padding: '0 8px', fontSize: '11px', background: '#fff' }}
          >
            <option value="">All Entity Types</option>
            <option value="person">Person</option>
            <option value="company">Company</option>
            <option value="contact">Contact</option>
          </select>

          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
            style={{ height: '30px', border: '1px solid #d0d7de', borderRadius: '14px', padding: '0 8px', fontSize: '11px', background: '#fff' }}
          >
            <option value="">All Statuses</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="qualified">Qualified</option>
            <option value="unqualified">Unqualified</option>
            <option value="archived">Archived</option>
          </select>

          <select
            value={companyFilter}
            onChange={e => { setCompanyFilter(e.target.value); setPage(1) }}
            style={{ height: '30px', border: '1px solid #d0d7de', borderRadius: '14px', padding: '0 8px', fontSize: '11px', background: '#fff', maxWidth: '170px' }}
          >
            <option value="">All Companies</option>
            {companiesList.map(c => (
              <option key={c._id} value={c._id}>{c.name}</option>
            ))}
          </select>

          {(hasEmail || hasPhone || hasLinkedIn || statusFilter || companyFilter || search) && (
            <button
              className="text-button"
              style={{ color: '#c33', fontSize: '11px', padding: '2px 6px' }}
              onClick={() => {
                setHasEmail(false)
                setHasPhone(false)
                setHasLinkedIn(false)
                setStatusFilter('')
                setCompanyFilter('')
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
              <th style={{ width: '36px', textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={items.length > 0 && selectedLeadIds.length === items.length}
                  onChange={toggleSelectAll}
                  aria-label="Select all leads on page"
                />
              </th>
              {['Name', 'Title / Role', 'Company', 'Email', 'Phone', 'LinkedIn', 'Status', 'Discovered', 'Action'].map(h => <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading && !items.length ? (
              <tr><td colSpan="10" style={{ textAlign: 'center', padding: '30px' }}>Loading leads directory...</td></tr>
            ) : items.length ? (
              items.map(lead => (
                <tr key={lead._id} onClick={() => handleOpenLead(lead)}>
                  <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedLeadIds.includes(lead._id)}
                      onChange={e => toggleSelectLead(lead._id, e)}
                      aria-label={`Select ${lead.name || 'lead'}`}
                    />
                  </td>
                  <td><b>{lead.name || '—'}</b></td>
                  <td>{lead.title || '—'}</td>
                  <td>
                    {lead.companyId ? (
                      <span
                        style={{ color: '#24534a', fontWeight: '600', cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelectCompany?.(lead.companyId)
                        }}
                      >
                        {lead.company || '—'} ↗
                      </span>
                    ) : (
                      lead.company || '—'
                    )}
                  </td>
                  <td>
                    {lead.email ? (
                      <a href={`mailto:${lead.email}`} onClick={e => e.stopPropagation()}>
                        {lead.email}
                      </a>
                    ) : '—'}
                  </td>
                  <td>
                    {lead.phone ? (
                      <a href={`tel:${lead.phone}`} onClick={e => e.stopPropagation()}>
                        {lead.phone}
                      </a>
                    ) : '—'}
                  </td>
                  <td>
                    {lead.linkedinUrl ? (
                      <a
                        href={lead.linkedinUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                        style={{ color: '#0077b5', fontWeight: '500' }}
                      >
                        LinkedIn ↗
                      </a>
                    ) : '—'}
                  </td>
                  <td>
                    <select
                      value={lead.status || 'new'}
                      onChange={e => handleUpdateStatus(lead._id, e.target.value)}
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
                  <td>{date(lead.discoveredAt)}</td>
                  <td>
                    <button
                      className="text-button"
                      style={{ color: '#c33', fontSize: '13px' }}
                      title="Delete lead"
                      onClick={(e) => handleDeleteLead(lead, e)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="10" style={{ textAlign: 'center', padding: '35px', color: '#88929c' }}>
                  No leads found matching your search or filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination-bar">
        <span>Showing {items.length} of {total} total lead(s)</span>
        <div className="pagination-controls">
          <select
            value={limit}
            onChange={e => { setLimit(Number(e.target.value)); setPage(1) }}
            style={{ height: '26px', border: '1px solid #d0d7de', borderRadius: '4px', fontSize: '11px', marginRight: '8px' }}
          >
            <option value="25">25 per page</option>
            <option value="50">50 per page</option>
            <option value="100">100 per page</option>
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

      {/* Lead Detail & Edit Modal */}
      {selectedLead && (
        <div className="modal-backdrop" onClick={() => setSelectedLead(null)}>
          <div className="detail-modal wide-modal" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => setSelectedLead(null)}>×</button>

            {isEditingLead ? (
              <form onSubmit={handleSaveLead}>
                <div className="eyebrow">EDIT LEAD</div>
                <h2>{selectedLead.name || 'Edit Lead Details'}</h2>
                <div style={{ fontSize: '11px', color: '#88929c', marginBottom: '14px' }}>
                  ID: {selectedLead._id} {selectedLead.scanId ? `· Scan: ${String(selectedLead.scanId).slice(-6)}` : ''}
                </div>

                <div className="detail-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                  <div>
                    <small>Full Name *</small>
                    <input
                      value={editForm.name || ''}
                      onChange={e => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid #d0d7de', borderRadius: '4px' }}
                      required
                    />
                  </div>
                  <div>
                    <small>Job Title / Role</small>
                    <input
                      value={editForm.title || ''}
                      onChange={e => setEditForm(prev => ({ ...prev, title: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid #d0d7de', borderRadius: '4px' }}
                    />
                  </div>
                  <div>
                    <small>Company Name</small>
                    <input
                      list="companies-datalist"
                      value={editForm.company || ''}
                      onChange={e => {
                        const val = e.target.value
                        const matched = companiesList.find(c => c.name.toLowerCase() === val.trim().toLowerCase())
                        setEditForm(prev => ({
                          ...prev,
                          company: val,
                          companyId: matched ? matched._id : undefined,
                        }))
                      }}
                      placeholder="Type or select company..."
                      style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid #d0d7de', borderRadius: '4px' }}
                    />
                    <datalist id="companies-datalist">
                      {companiesList.map(c => (
                        <option key={c._id} value={c.name} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <small>Email</small>
                    <input
                      type="email"
                      value={editForm.email || ''}
                      onChange={e => setEditForm(prev => ({ ...prev, email: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid #d0d7de', borderRadius: '4px' }}
                    />
                  </div>
                  <div>
                    <small>Phone</small>
                    <input
                      value={editForm.phone || ''}
                      onChange={e => setEditForm(prev => ({ ...prev, phone: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid #d0d7de', borderRadius: '4px' }}
                    />
                  </div>
                  <div>
                    <small>LinkedIn URL</small>
                    <input
                      value={editForm.linkedinUrl || ''}
                      onChange={e => setEditForm(prev => ({ ...prev, linkedinUrl: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid #d0d7de', borderRadius: '4px' }}
                    />
                  </div>
                  <div>
                    <small>Lead Status</small>
                    <select
                      value={editForm.status || 'new'}
                      onChange={e => setEditForm(prev => ({ ...prev, status: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid #d0d7de', borderRadius: '4px', background: '#fff' }}
                    >
                      <option value="new">New</option>
                      <option value="contacted">Contacted</option>
                      <option value="qualified">Qualified</option>
                      <option value="unqualified">Unqualified</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                  <div>
                    <small>Notes</small>
                    <input
                      value={editForm.notes || ''}
                      onChange={e => setEditForm(prev => ({ ...prev, notes: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid #d0d7de', borderRadius: '4px' }}
                    />
                  </div>
                </div>

                <div style={{ marginTop: '12px' }}>
                  <small style={{ display: 'block', marginBottom: '4px' }}>Biography</small>
                  <textarea
                    value={editForm.biography || ''}
                    onChange={e => setEditForm(prev => ({ ...prev, biography: e.target.value }))}
                    rows={3}
                    style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid #d0d7de', borderRadius: '4px', resize: 'vertical' }}
                  />
                </div>

                <div className="modal-actions" style={{ marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button className="secondary" type="button" onClick={() => setIsEditingLead(false)} disabled={savingLead}>
                    Cancel
                  </button>
                  <button className="primary" type="submit" disabled={savingLead}>
                    {savingLead ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="eyebrow">LEAD DETAILS</div>
                <h2>{selectedLead.name || 'Unnamed Lead'}</h2>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' }}>
                  <span className={`status ${selectedLead.status || 'new'}`}>{selectedLead.status || 'new'}</span>
                  <span style={{ fontSize: '11px', color: '#88929c' }}>Discovered: {date(selectedLead.discoveredAt)}</span>
                  {selectedLead.scanId && (
                    <span style={{ fontSize: '11px', color: '#88929c' }}>Scan ID: {String(selectedLead.scanId).slice(-6)}</span>
                  )}
                </div>

                <div className="detail-grid">
                  <div>
                    <small>Full Name</small>
                    <b>{selectedLead.name || '—'}</b>
                  </div>
                  <div>
                    <small>Job Title / Designation</small>
                    <b>{selectedLead.title || '—'}</b>
                  </div>
                  <div>
                    <small>Company</small>
                    <b>
                      {selectedLead.companyId ? (
                        <span
                          style={{ color: '#24534a', cursor: 'pointer' }}
                          onClick={() => {
                            setSelectedLead(null)
                            onSelectCompany?.(selectedLead.companyId)
                          }}
                        >
                          {selectedLead.company || '—'} ↗
                        </span>
                      ) : (
                        selectedLead.company || '—'
                      )}
                    </b>
                  </div>
                  <div>
                    <small>Email</small>
                    <b>
                      {selectedLead.email ? (
                        <a href={`mailto:${selectedLead.email}`}>{selectedLead.email}</a>
                      ) : '—'}
                    </b>
                  </div>
                  <div>
                    <small>Phone</small>
                    <b>
                      {selectedLead.phone ? (
                        <a href={`tel:${selectedLead.phone}`}>{selectedLead.phone}</a>
                      ) : '—'}
                    </b>
                  </div>
                  <div>
                    <small>LinkedIn Profile</small>
                    <b>
                      {selectedLead.linkedinUrl ? (
                        <a href={selectedLead.linkedinUrl} target="_blank" rel="noreferrer" style={{ color: '#0077b5' }}>
                          Profile ↗
                        </a>
                      ) : '—'}
                    </b>
                  </div>
                  <div>
                    <small>Source Page URL</small>
                    <b>
                      {selectedLead.sourceUrl ? (
                        <a href={selectedLead.sourceUrl} target="_blank" rel="noreferrer">
                          Source Page ↗
                        </a>
                      ) : '—'}
                    </b>
                  </div>
                  <div>
                    <small>Source Website</small>
                    <b>
                      {selectedLead.sourceWebsite ? (
                        <a href={selectedLead.sourceWebsite} target="_blank" rel="noreferrer">
                          {selectedLead.sourceWebsite} ↗
                        </a>
                      ) : '—'}
                    </b>
                  </div>
                </div>

                {selectedLead.biography && (
                  <div style={{ marginTop: '14px', background: '#f8faf9', padding: '10px 12px', borderRadius: '6px' }}>
                    <small style={{ display: 'block', color: '#697480', marginBottom: '4px' }}>Biography</small>
                    <p style={{ margin: 0, fontSize: '12px', lineHeight: '1.5', color: '#2d3748' }}>
                      {selectedLead.biography}
                    </p>
                  </div>
                )}

                {Array.isArray(selectedLead.provenance) && selectedLead.provenance.length > 0 && (
                  <div style={{ marginTop: '16px' }}>
                    <div style={{ fontSize: '11px', fontWeight: '600', color: '#556270', marginBottom: '6px' }}>
                      CONTACT EXTRACTION EVIDENCE & PROVENANCE ({selectedLead.provenance.length})
                    </div>
                    <div className="table-wrap" style={{ maxHeight: '150px', overflowY: 'auto' }}>
                      <table style={{ fontSize: '11px' }}>
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th>Extracted Value</th>
                            <th>Method</th>
                            <th>Source URL</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedLead.provenance.map((p, idx) => (
                            <tr key={idx}>
                              <td><b>{p.fieldName}</b></td>
                              <td><code>{String(p.value)}</code></td>
                              <td><span className="page-status">{p.method}</span></td>
                              <td>
                                <a href={p.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: '#1d594e' }}>
                                  Link ↗
                                </a>
                              </td>
                              <td>
                                <span className={`page-status ${p.validationStatus === 'syntax_valid' ? 'fetched' : 'blocked'}`} style={{ fontSize: '9px' }}>
                                  {p.validationStatus || 'unverified'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="modal-actions" style={{ marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="primary" onClick={() => setIsEditingLead(true)}>
                      ✏ Edit Lead
                    </button>
                    <button
                      className="danger-button"
                      onClick={() => handleDeleteLead(selectedLead)}
                    >
                      Delete Lead
                    </button>
                  </div>
                  <button className="secondary" onClick={() => setSelectedLead(null)}>Close</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDeleteLead && (
        <div className="modal-backdrop" onClick={() => !deletingLead && setConfirmDeleteLead(null)}>
          <div className="detail-modal" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => !deletingLead && setConfirmDeleteLead(null)}>×</button>
            <div className="eyebrow" style={{ color: '#c33' }}>DELETE CONFIRMATION</div>
            <h2>Delete Lead Record</h2>
            <p style={{ fontSize: '12px', color: '#556270', lineHeight: 1.6 }}>
              Are you sure you want to permanently delete <b>{confirmDeleteLead.name || 'this lead'}</b>?
            </p>
            <div className="warning-box">
              <strong>DATA INTEGRITY & ORPHAN SAFETY:</strong>
              <br />
              This removes the lead record and updates company lead counts. Shared company profiles and people are preserved safely.
            </div>
            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button className="secondary" onClick={() => setConfirmDeleteLead(null)} disabled={deletingLead}>
                Cancel
              </button>
              <button className="danger-button" onClick={executeDeleteLead} disabled={deletingLead}>
                {deletingLead ? 'Deleting…' : 'Confirm & Delete Lead'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
