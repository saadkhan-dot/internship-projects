import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { preferNewerJob } from './jobSnapshot.js'
import { HistoryView } from './components/HistoryView.jsx'
import { LeadsView } from './components/LeadsView.jsx'
import { CompaniesView } from './components/CompaniesView.jsx'
import { CompanyDetailView } from './components/CompanyDetailView.jsx'

const API = import.meta.env.VITE_API_URL || '/api'
const nav = [
  ['Dashboard', '◫'],
  ['Website Scanner', '◎'],
  ['Leads', '♧'],
  ['Companies', '▦'],
  ['Crawl History', '◷'],
  ['Settings', '⚙'],
]

const emptyStats = { totalLeads: 0, people: 0, companies: 0, completedScans: 0, recentScans: [] }
const types = ['Website', 'Sitemap', 'Individual', 'Company']
const date = value => value ? new Date(value).toLocaleString() : '—'
const progressPercent = job => job?.status === 'completed' ? 100 : job?.status === 'running' && typeof job?.progress?.percent === 'number' ? Math.min(99, Math.max(0, job.progress.percent)) : null

function App() {
  const [page, setPage] = useState('Dashboard')
  const [scannerSubtab, setScannerSubtab] = useState('scan')
  const [selectedCompanyId, setSelectedCompanyId] = useState(null)

  const [health, setHealth] = useState(null)
  const [stats, setStats] = useState(emptyStats)
  const [scans, setScans] = useState([])
  const [settings, setSettings] = useState({
    defaultPageLimit: 100,
    crawlDepth: 3,
    requestDelay: 1,
    concurrency: 3,
    requestTimeoutMs: 10000,
    sitemapDiscovery: true,
    internalLinkCrawling: true,
    queryParameterPolicy: 'preserve',
  })
  const [active, setActive] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState(null)
  const [queue, setQueue] = useState({ active: null, queued: [], totalQueued: 0, counts: {} })
  const [websiteMode, setWebsiteMode] = useState('single')
  const [batchText, setBatchText] = useState('')
  const [form, setForm] = useState({ type: 'Website', target: '', maxPages: 100, depth: 3 })
  const formTouched = useRef(false)

  const request = useCallback(async (path, options) => {
    const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options })
    const data = await res.json()
    if (!res.ok) throw Error(data.error || 'Request failed')
    return data
  }, [])

  const activeId = active?._id || ''
  const activeStatus = active?.status || ''

  const parseBatchUrls = (text) => {
    const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)
    const seen = new Set()
    return lines.map((raw, idx) => {
      let valid = false, normalized = null, error = null
      try {
        const withProto = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
        const u = new URL(withProto)
        if (['http:', 'https:'].includes(u.protocol) && u.hostname && u.hostname.includes('.')) {
          valid = true
          normalized = u.href
        } else {
          error = 'Invalid website format'
        }
      } catch {
        error = 'Invalid URL'
      }
      const isDuplicate = valid && seen.has(normalized)
      if (valid) seen.add(normalized)
      return { id: idx, raw, valid, error, isDuplicate, normalized }
    })
  }

  const removeBatchUrl = (idxToRemove) => {
    const lines = batchText.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)
    const updated = lines.filter((_, i) => i !== idxToRemove).join('\n')
    setBatchText(updated)
  }

  const cancelScan = async (id) => {
    const targetId = id || active?._id
    if (!targetId) return
    try {
      const job = await request(`/scans/${targetId}/cancel`, { method: 'POST' })
      if (active?._id === targetId) setActive(job)
      setNotice('Cancellation recorded.')
      const [qData, allJobs] = await Promise.all([request('/queue'), request('/scans')])
      setQueue(qData)
      setScans(allJobs)
    } catch (e) { setError(e.message) }
  }

  const retryScan = async (id) => {
    setError('')
    setNotice('')
    try {
      const job = await request(`/scans/${id}/retry`, { method: 'POST' })
      setNotice(`Scan for ${job.target} requeued successfully.`)
      const [qData, allJobs] = await Promise.all([request('/queue'), request('/scans')])
      setQueue(qData)
      setScans(allJobs)
    } catch (e) { setError(e.message) }
  }

  useEffect(() => {
    let stopped = false, timer, inFlight = false, shouldPoll = false, controller
    const load = async () => {
      if (stopped || inFlight) return
      inFlight = true
      controller = new AbortController()
      const options = { signal: controller.signal }
      try {
        const healthResponse = await fetch(`${API}/health`, options)
        const healthData = await healthResponse.json()
        if (!stopped) setHealth(healthData)

        if (page === 'Dashboard' || page === 'Overview') {
          const [data, qData] = await Promise.all([request('/dashboard', options), request('/queue', options)])
          if (!stopped) {
            setStats(data)
            setQueue(qData)
            shouldPoll = data.recentScans?.some(scan => ['queued', 'running', 'cancelling'].includes(scan.status)) || qData.totalQueued > 0
          }
        } else if (page === 'Website Scanner') {
          const [qData, allJobs] = await Promise.all([request('/queue', options), request('/scans', options)])
          if (!stopped) {
            setQueue(qData)
            setScans(allJobs)
            if (activeId) {
              const current = allJobs.find(j => j._id === activeId) || qData.active
              if (current) setActive(old => preferNewerJob(old, current))
            } else if (qData.active) {
              setActive(qData.active)
            } else if (allJobs.length) {
              const pendingOrFirst = allJobs.find(j => ['queued', 'running', 'cancelling'].includes(j.status)) || allJobs[0]
              setActive(pendingOrFirst)
            }
            shouldPoll = Boolean(qData.active || qData.totalQueued > 0 || allJobs.some(j => ['queued', 'running', 'cancelling'].includes(j.status)))
          }
        } else if (page === 'Settings') {
          const config = await request('/settings', options)
          if (!stopped) {
            setSettings(config)
            if (!formTouched.current) setForm(old => ({ ...old, maxPages: config.defaultPageLimit, depth: config.crawlDepth }))
          }
        }
        if (!stopped) setError('')
      } catch (e) {
        if (!stopped && e.name !== 'AbortError') {
          setError(e.message === 'Failed to fetch' ? 'Unable to reach backend server (port 4000). Please verify the backend is running.' : e.message)
        }
      } finally {
        inFlight = false
        if (!stopped && shouldPoll) timer = setTimeout(load, 3500)
      }
    }
    load()
    return () => { stopped = true; clearTimeout(timer); controller?.abort() }
  }, [page, activeId, activeStatus, request])

  const submitScan = async (e) => {
    e.preventDefault()
    setError('')
    setNotice('')
    if (form.type === 'Website' && websiteMode === 'batch') {
      const parsed = parseBatchUrls(batchText)
      const validTargets = [...new Set(parsed.filter(p => p.valid && !p.isDuplicate).map(p => p.normalized))]
      if (!validTargets.length) {
        return setError('Please enter at least one valid website URL to scan.')
      }
      if (+form.maxPages < 1 || +form.depth < 0) {
        return setError('Maximum pages must be positive and crawl depth cannot be negative.')
      }
      try {
        const res = await request('/scans/batch', {
          method: 'POST',
          body: JSON.stringify({
            urls: validTargets,
            options: { maxPages: +form.maxPages, maxDepth: +form.depth },
          }),
        })
        setBatchText('')
        setNotice(`Batch scan submitted: ${res.totalCreated} website(s) queued for discovery.`)
        setScannerSubtab('monitor')
      } catch (e) { setError(e.message) }
      return
    }

    const rawTarget = form.target.trim()
    if (!rawTarget) return setError('Please enter a target.')
    let target = rawTarget
    let scanType = form.type.toLowerCase()
    if (form.type === 'Company') {
      scanType = 'website'
      if (!target.startsWith('http://') && !target.startsWith('https://')) target = `https://${target}`
    }
    if (scanType === 'website' || form.type === 'Sitemap') {
      try {
        const u = new URL(target.startsWith('http') ? target : `https://${target}`)
        if (!['http:', 'https:'].includes(u.protocol)) throw Error()
        target = u.href
      } catch {
        return setError('Enter a valid website URL. Example: https://example.com')
      }
    }
    if (scanType === 'website' && (+form.maxPages < 1 || +form.depth < 0)) {
      return setError('Maximum pages must be positive and crawl depth cannot be negative.')
    }
    try {
      const scan = await request('/scans', {
        method: 'POST',
        body: JSON.stringify({ type: scanType, target, options: { maxPages: +form.maxPages, maxDepth: +form.depth } }),
      })
      setActive(scan)
      setScannerSubtab('monitor')
      setNotice(scan.error || 'Website discovery and profile scraping started.')
    } catch (e) { setError(e.message) }
  }

  const saveSettings = async (e) => {
    e.preventDefault()
    try {
      const s = await request('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...settings,
          defaultPageLimit: +settings.defaultPageLimit,
          crawlDepth: +settings.crawlDepth,
          requestDelay: +settings.requestDelay,
          concurrency: +settings.concurrency,
          requestTimeoutMs: +settings.requestTimeoutMs,
        }),
      })
      setSettings(s)
      setNotice('Discovery settings saved to MongoDB.')
    } catch (e) { setError(e.message) }
  }

  const handleHistoryCleared = async () => {
    setActive(null)
    setSelected(null)
    setSelectedCompanyId(null)
    try {
      const [dStats, qData, allJobs] = await Promise.all([
        request('/dashboard'),
        request('/queue'),
        request('/scans'),
      ])
      setStats(dStats || emptyStats)
      setQueue(qData || { active: null, queued: [], totalQueued: 0, counts: {} })
      setScans(allJobs || [])
    } catch {
      setStats(emptyStats)
      setQueue({ active: null, queued: [], totalQueued: 0, counts: {} })
      setScans([])
    }
  }

  const batchParsed = parseBatchUrls(batchText)
  const batchValidCount = batchParsed.filter(u => u.valid && !u.isDuplicate).length
  const batchDupCount = batchParsed.filter(u => u.isDuplicate).length
  const batchInvalidCount = batchParsed.filter(u => !u.valid).length

  const title = page === 'Dashboard' ? 'Lead intelligence, at a glance'
    : page === 'Website Scanner' ? 'Website discovery and scanning'
    : page === 'Leads' ? 'Centralized Leads Directory'
    : page === 'Companies' ? (selectedCompanyId ? 'Company Profile' : 'Companies Directory')
    : page === 'Crawl History' ? 'Crawl History & Sessions'
    : page === 'Settings' ? 'Discovery Settings'
    : page

  const subtitle = page === 'Dashboard' ? 'A clear view of your discovery activity and lead metrics.'
    : page === 'Website Scanner' ? 'Launch single or multi-URL website crawls and monitor queue status.'
    : page === 'Leads' ? 'Search, filter, manage, and export all identified leads.'
    : page === 'Companies' ? 'Consolidated organizations catalog, contact coverage, and company intelligence.'
    : page === 'Crawl History' ? 'Audit and manage crawl sessions, inspect logs, and clear history safely.'
    : page === 'Settings' ? 'Configure your scan defaults and crawling limits.'
    : ''

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" onClick={() => { setPage('Dashboard'); setSelectedCompanyId(null) }}>
          <span className="brand-icon">L</span>
          <span>leadintel<small>INTELLIGENCE WORKSPACE</small></span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(([name, icon]) => (
            <button
              key={name}
              onClick={() => {
                setPage(name)
                if (name === 'Companies') setSelectedCompanyId(null)
                setError('')
                setNotice('')
              }}
              className={page === name ? 'active' : ''}
            >
              <span className="nav-icon">{icon}</span>
              {name}
              {name === 'Website Scanner' && ((active && ['queued', 'running'].includes(active.status)) || (queue?.totalQueued > 0)) && <i />}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <span className={`db-dot ${health?.dbConnected ? 'online' : ''}`} />
          <span>{health?.dbConnected ? 'Database connected' : 'Database unavailable'}</span>
          <small>{health?.dbConnected ? 'MongoDB' : 'Check backend settings'}</small>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="crumb">Workspace <span>/</span> {page}</div>
          <div className="top-right">
            <span className="sim-badge">LEADINTEL v4.3 · DIRECTORY & CRM</span>
            <div className="avatar">SK</div>
          </div>
          <nav className="mobile-nav">
            {nav.map(([n]) => (
              <button
                className={page === n ? 'selected' : ''}
                key={n}
                onClick={() => {
                  setPage(n)
                  if (n === 'Companies') setSelectedCompanyId(null)
                }}
              >
                {n === 'Dashboard' ? 'Home' : n === 'Website Scanner' ? 'Scanner' : n === 'Crawl History' ? 'History' : n}
              </button>
            ))}
          </nav>
        </header>

        <section className="content">
          <div className="page-head">
            <div>
              <div className="eyebrow">LEADINTEL / {page.toUpperCase()}</div>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
            {page === 'Dashboard' && (
              <button className="primary" onClick={() => { setPage('Website Scanner'); setScannerSubtab('scan') }}>
                ＋ Start a scan
              </button>
            )}
          </div>

          {error && <div className="alert error">{error}<button onClick={() => setError('')}>×</button></div>}
          {notice && <div className="alert success">{notice}<button onClick={() => setNotice('')}>×</button></div>}
          {health && !health.dbConnected && (
            <div className="alert error">
              Database unavailable. Records cannot be saved or displayed. Configure <code>MONGODB_URI</code> in <code>backend/.env</code> and restart.
            </div>
          )}

          {/* DASHBOARD VIEW */}
          {page === 'Dashboard' && (
            <>
              <div className="metric-grid">
                {[
                  ['Total leads', stats.totalLeads, '♧'],
                  ['People identified', stats.people, '♙'],
                  ['Companies identified', stats.companies, '▦'],
                  ['Queue pending', queue?.totalQueued || 0, '◷'],
                ].map(([label, value, icon]) => (
                  <article className="metric" key={label}>
                    <div className="metric-top">
                      <span>{label}</span>
                      <b>{icon}</b>
                    </div>
                    <strong>{value}</strong>
                    <small>From saved CRM data</small>
                  </article>
                ))}
              </div>

              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Recent scan activity</h2>
                      <p>Your latest crawl jobs</p>
                    </div>
                    <button className="text-button" onClick={() => setPage('Crawl History')}>
                      View history →
                    </button>
                  </div>
                  {stats.recentScans?.length ? (
                    stats.recentScans.map(s => (
                      <ScanRow
                        key={s._id}
                        scan={s}
                        onClick={() => {
                          setActive(s)
                          setSelected(s)
                          setPage('Crawl History')
                        }}
                      />
                    ))
                  ) : (
                    <Empty
                      icon="◷"
                      title="No scans yet"
                      text="Your completed and queued jobs will appear here."
                      action={() => { setPage('Website Scanner'); setScannerSubtab('scan') }}
                      actionText="Create your first scan"
                    />
                  )}
                </section>

                <section className="panel quick">
                  <div className="panel-head">
                    <div>
                      <h2>Quick start</h2>
                      <p>Choose what to discover</p>
                    </div>
                  </div>
                  {types.map((t, i) => (
                    <button
                      className="quick-type"
                      key={t}
                      onClick={() => {
                        formTouched.current = true
                        setForm({ ...form, type: t, target: '' })
                        setPage('Website Scanner')
                        setScannerSubtab('scan')
                      }}
                    >
                      <span className="quick-icon">{['◎', '≋', '♙', '▦'][i]}</span>
                      <span>
                        <b>{t}</b>
                        <small>
                          {['Discover pages and people from a website', 'Follow an XML sitemap', 'Find a person profile', 'Find a company profile'][i]}
                        </small>
                      </span>
                      <span className="arrow">↗</span>
                    </button>
                  ))}
                </section>
              </div>
            </>
          )}

          {/* WEBSITE SCANNER VIEW */}
          {page === 'Website Scanner' && (
            <div>
              <div className="scanner-tabs">
                <button
                  type="button"
                  className={`subtab-btn ${scannerSubtab === 'scan' ? 'active' : ''}`}
                  onClick={() => setScannerSubtab('scan')}
                >
                  Configure & Start Scan
                </button>
                <button
                  type="button"
                  className={`subtab-btn ${scannerSubtab === 'monitor' ? 'active' : ''}`}
                  onClick={() => setScannerSubtab('monitor')}
                >
                  Live Monitor & Queue
                  {queue?.totalQueued > 0 && (
                    <span className="queue-pos" style={{ marginLeft: '6px' }}>{queue.totalQueued}</span>
                  )}
                </button>
              </div>

              {scannerSubtab === 'scan' ? (
                <div className="panel scan-panel">
                  <div className="scan-steps">
                    <span className="step active">01 <b>Scan type</b></span>
                    <span className="step-line" />
                    <span className="step">02 <b>Configure</b></span>
                    <span className="step-line" />
                    <span className="step">03 <b>Review</b></span>
                  </div>
                  <form onSubmit={submitScan}>
                    <label>What would you like to scan?</label>
                    <div className="type-grid">
                      {types.map((t, i) => (
                        <button
                          type="button"
                          key={t}
                          className={`type-option ${form.type === t ? 'chosen' : ''}`}
                          onClick={() => {
                            formTouched.current = true
                            setForm({ ...form, type: t, target: '' })
                          }}
                        >
                          <span>{['◎', '≋', '♙', '▦'][i]}</span>
                          <b>{t}</b>
                          <small>{['Explore a website', 'Follow a sitemap', 'Search a person', 'Search a business'][i]}</small>
                        </button>
                      ))}
                    </div>

                    {form.type === 'Website' && (
                      <div className="batch-mode-toggle">
                        <button
                          type="button"
                          className={websiteMode === 'single' ? 'active' : ''}
                          onClick={() => setWebsiteMode('single')}
                        >
                          Single website
                        </button>
                        <button
                          type="button"
                          className={websiteMode === 'batch' ? 'active' : ''}
                          onClick={() => setWebsiteMode('batch')}
                        >
                          Batch websites (Multi-URL)
                        </button>
                      </div>
                    )}

                    {form.type === 'Website' && websiteMode === 'batch' ? (
                      <>
                        <label htmlFor="batchUrls">Website URLs (one per line or pasted list)</label>
                        <textarea
                          id="batchUrls"
                          className="batch-textarea"
                          placeholder={'https://company-a.com\nhttps://company-b.com\nhttps://company-c.com'}
                          value={batchText}
                          onChange={e => {
                            formTouched.current = true
                            setBatchText(e.target.value)
                          }}
                        />
                        <div className="batch-summary">
                          <span>
                            <b>{batchValidCount}</b> valid URL(s) to queue{' '}
                            {batchDupCount > 0 && <small>· {batchDupCount} duplicate(s) omitted</small>}{' '}
                            {batchInvalidCount > 0 && <small style={{ color: '#c33' }}>· {batchInvalidCount} invalid</small>}
                          </span>
                        </div>
                        {batchParsed.length > 0 && (
                          <div className="url-badge-list">
                            {batchParsed.map(item => (
                              <div key={item.id} className="url-badge-item">
                                <code>{item.raw}</code>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  {item.isDuplicate ? (
                                    <span className="status queued">Duplicate</span>
                                  ) : item.valid ? (
                                    <span className="status completed">Valid</span>
                                  ) : (
                                    <span className="status failed">{item.error}</span>
                                  )}
                                  <button
                                    type="button"
                                    className="url-remove-btn"
                                    title="Remove URL"
                                    onClick={() => removeBatchUrl(item.id)}
                                  >
                                    ✕
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <label htmlFor="target">
                          {form.type === 'Website' ? 'Website URL' : form.type === 'Sitemap' ? 'Sitemap URL' : form.type === 'Individual' ? "Person's name" : 'Company name or website'}
                        </label>
                        <input
                          id="target"
                          value={form.target}
                          onChange={e => {
                            formTouched.current = true
                            setForm({ ...form, target: e.target.value })
                          }}
                          placeholder={form.type === 'Website' ? 'https://example.com' : form.type === 'Sitemap' ? 'https://example.com/sitemap.xml' : form.type === 'Individual' ? 'e.g. Alex Morgan' : 'e.g. Acme or acme.com'}
                        />
                      </>
                    )}

                    {form.type === 'Website' && (
                      <div className="form-row">
                        <div>
                          <label htmlFor="pages">Maximum pages per website</label>
                          <input
                            id="pages"
                            type="number"
                            min="1"
                            max="5000"
                            value={form.maxPages}
                            onChange={e => {
                              formTouched.current = true
                              setForm({ ...form, maxPages: e.target.value })
                            }}
                          />
                        </div>
                        <div>
                          <label htmlFor="depth">Crawl depth</label>
                          <input
                            id="depth"
                            type="number"
                            min="0"
                            max="20"
                            value={form.depth}
                            onChange={e => {
                              formTouched.current = true
                              setForm({ ...form, depth: e.target.value })
                            }}
                          />
                        </div>
                      </div>
                    )}

                    <div className="simulation-note">
                      <span>ⓘ</span>
                      <p>
                        <b>Persistent FIFO Queue</b><br />
                        Scans are queued and executed one website at a time. Discovered people and companies are automatically saved to your CRM.
                      </p>
                    </div>

                    <button className="primary submit">
                      {form.type === 'Website' && websiteMode === 'batch'
                        ? `Queue ${batchValidCount} website scan(s) →`
                        : 'Start URL discovery →'}
                    </button>
                  </form>
                </div>
              ) : (
                <div className="monitor-grid">
                  <section className="panel monitor-main">
                    <div className="panel-head">
                      <div>
                        <h2>Current scan</h2>
                        <p>Backend-reported discovery activity</p>
                      </div>
                      {active && <Status status={active.status} />}
                    </div>
                    {active ? (
                      <>
                        <div className="current-job">
                          <div className="job-type">{active.type?.toUpperCase()} SCAN · {active.progress?.stage || active.status}</div>
                          <h3>{active.target}</h3>
                          <p>Started {date(active.startedAt || active.createdAt)}</p>
                        </div>
                        <div className="monitor-stats">
                          <div>
                            <small>URLs discovered</small>
                            <b>{active.progress?.urlsDiscovered || 0}</b>
                          </div>
                          <div>
                            <small>Page requests attempted / successfully fetched</small>
                            <b>{active.progress?.pagesAttempted || 0} / {active.progress?.pagesFetched || 0}</b>
                          </div>
                          <div>
                            <small>Failed page requests</small>
                            <b>{active.progress?.failedRequests || 0}</b>
                          </div>
                          <div>
                            <small>HTML processed / candidates / extraction errors</small>
                            <b>{active.progress?.extractionPagesProcessed || 0} / {active.progress?.candidatesFound || 0} / {active.progress?.extractionErrors || 0}</b>
                          </div>
                        </div>
                        {progressPercent(active) !== null && (
                          <div className="crawl-progress">
                            <div>
                              <span>Discovered URLs resolved</span>
                              <b>{progressPercent(active)}%</b>
                            </div>
                            <progress max="100" value={progressPercent(active)} />
                          </div>
                        )}
                        <div className="not-running">
                          {active.status === 'queued' ? 'Waiting in queue for the discovery worker.' : active.status === 'running' ? 'Counts reflect URL work and HTTP requests already performed.' : active.status === 'cancelling' ? 'Cancellation requested. Active requests are stopping; saved URLs remain available.' : active.status === 'cancelled' ? 'Discovery cancelled. URLs discovered so far were preserved.' : active.status === 'failed' ? `Discovery failed: ${active.failureReason || active.error || 'see activity log'}` : `Discovery ${active.status}. ${active.progress?.urlsDiscovered || 0} URLs stored.`}
                        </div>
                        {['queued', 'running', 'cancelling'].includes(active.status) && active.status !== 'cancelling' && (
                          <button className="danger" onClick={() => cancelScan(active._id)}>
                            Cancel scan
                          </button>
                        )}
                        {active.status === 'failed' && (
                          <button className="secondary" style={{ marginTop: '15px' }} onClick={() => retryScan(active._id)}>
                            ↻ Retry failed scan
                          </button>
                        )}
                        <button className="text-button" onClick={() => setSelected(active)}>
                          View discovered URLs →
                        </button>
                      </>
                    ) : (
                      <Empty
                        icon="◉"
                        title="Queue idle"
                        text="No scan is currently running. Start a website scan to follow its activity."
                        action={() => setScannerSubtab('scan')}
                        actionText="Start a scan"
                      />
                    )}

                    <div className="queue-section">
                      <div className="panel-head">
                        <div>
                          <h2>Persistent scan queue</h2>
                          <p>{queue?.totalQueued || 0} website scan(s) waiting in FIFO order</p>
                        </div>
                      </div>
                      {queue?.queued?.length ? (
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                {['#', 'Website target', 'Submitted', 'Pages / Depth', 'Action'].map(h => <th key={h}>{h}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {queue.queued.map(item => (
                                <tr key={item._id} onClick={() => setActive(item)}>
                                  <td><span className="queue-pos">#{item.position}</span></td>
                                  <td><b>{item.target}</b></td>
                                  <td>{date(item.createdAt)}</td>
                                  <td>{item.options?.maxPages || 100} / {item.options?.maxDepth ?? 3}</td>
                                  <td>
                                    <button
                                      className="action-btn cancel"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        cancelScan(item._id)
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="log-empty">Queue is empty. Next submitted scan will execute immediately.</div>
                      )}
                    </div>

                    {scans.some(s => s.status === 'failed') && (
                      <div className="queue-section">
                        <div className="panel-head">
                          <div>
                            <h2>Failed scans</h2>
                            <p>Scans that encountered network or HTTP errors</p>
                          </div>
                        </div>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                {['Website target', 'Failure reason', 'Date', 'Action'].map(h => <th key={h}>{h}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {scans.filter(s => s.status === 'failed').slice(0, 5).map(item => (
                                <tr key={item._id} onClick={() => setActive(item)}>
                                  <td><b>{item.target}</b></td>
                                  <td style={{ color: '#c33', fontSize: '10px' }}>{item.failureReason || item.error || 'Failed'}</td>
                                  <td>{date(item.endedAt || item.updatedAt)}</td>
                                  <td>
                                    <button
                                      className="action-btn retry"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        retryScan(item._id)
                                      }}
                                    >
                                      ↻ Retry
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </section>

                  <section className="panel logs">
                    <div className="panel-head">
                      <div>
                        <h2>Activity log</h2>
                        <p>{active?.target ? `Events for ${active.target}` : 'Live events'}</p>
                      </div>
                      <span className="live-label"><i /> LIVE</span>
                    </div>
                    {active?.logs?.length ? (
                      active.logs.map((l, i) => (
                        <div className="log-row" key={i}>
                          <time>{date(l.at)}</time>
                          <span>{l.message}</span>
                        </div>
                      ))
                    ) : (
                      <div className="log-empty">No log events available for this job.</div>
                    )}
                  </section>
                </div>
              )}
            </div>
          )}

          {/* LEADS DIRECTORY VIEW */}
          {page === 'Leads' && (
            <LeadsView
              API={API}
              request={request}
              onSelectCompany={(companyId) => {
                setSelectedCompanyId(companyId)
                setPage('Companies')
              }}
            />
          )}

          {/* COMPANIES DIRECTORY VIEW */}
          {page === 'Companies' && (
            selectedCompanyId ? (
              <CompanyDetailView
                API={API}
                request={request}
                companyId={selectedCompanyId}
                onBack={() => setSelectedCompanyId(null)}
                onSelectLead={(lead) => setSelected(lead)}
              />
            ) : (
              <CompaniesView
                API={API}
                request={request}
                onSelectCompany={(companyId) => setSelectedCompanyId(companyId)}
              />
            )
          )}

          {/* CRAWL HISTORY VIEW */}
          {page === 'Crawl History' && (
            <HistoryView
              API={API}
              request={request}
              onRetry={retryScan}
              onCancel={cancelScan}
              onCleared={handleHistoryCleared}
            />
          )}

          {/* SETTINGS VIEW */}
          {page === 'Settings' && (
            <form className="panel settings-panel" onSubmit={saveSettings}>
              <div className="panel-head">
                <div>
                  <h2>Discovery settings</h2>
                  <p>Limits and request behavior used by Website Scans.</p>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <b>Default page limit</b>
                  <small>Maximum URLs to store per scan.</small>
                </div>
                <input
                  type="number"
                  min="1"
                  max="5000"
                  value={settings.defaultPageLimit}
                  onChange={e => setSettings({ ...settings, defaultPageLimit: e.target.value })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <b>Maximum link depth</b>
                  <small>How many link levels to follow from each page.</small>
                </div>
                <input
                  type="number"
                  min="0"
                  max="20"
                  value={settings.crawlDepth}
                  onChange={e => setSettings({ ...settings, crawlDepth: e.target.value })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <b>Request delay</b>
                  <small>Minimum seconds between requests. robots.txt crawl-delay also applies.</small>
                </div>
                <input
                  type="number"
                  min="0"
                  max="60"
                  step="0.5"
                  value={settings.requestDelay}
                  onChange={e => setSettings({ ...settings, requestDelay: e.target.value })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <b>Concurrent requests</b>
                  <small>Maximum simultaneous page requests (1 to 5).</small>
                </div>
                <input
                  type="number"
                  min="1"
                  max="5"
                  value={settings.concurrency}
                  onChange={e => setSettings({ ...settings, concurrency: e.target.value })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <b>Request timeout</b>
                  <small>Milliseconds before an HTTP request is abandoned.</small>
                </div>
                <input
                  type="number"
                  min="1000"
                  max="60000"
                  step="1000"
                  value={settings.requestTimeoutMs}
                  onChange={e => setSettings({ ...settings, requestTimeoutMs: e.target.value })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <b>Sitemap discovery</b>
                  <small>Use robots.txt references and standard sitemap paths.</small>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.sitemapDiscovery}
                    onChange={e => setSettings({ ...settings, sitemapDiscovery: e.target.checked })}
                  />
                  <span />
                </label>
              </div>
              <div className="setting-row">
                <div>
                  <b>Internal link crawling</b>
                  <small>Follow same-host links from fetched HTML pages.</small>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.internalLinkCrawling}
                    onChange={e => setSettings({ ...settings, internalLinkCrawling: e.target.checked })}
                  />
                  <span />
                </label>
              </div>
              <div className="setting-row">
                <div>
                  <b>Query parameter policy</b>
                  <small>Preserve query values by default to avoid dropping meaningful URLs.</small>
                </div>
                <select
                  value={settings.queryParameterPolicy}
                  onChange={e => setSettings({ ...settings, queryParameterPolicy: e.target.value })}
                >
                  <option value="preserve">Preserve all</option>
                  <option value="remove-tracking">Remove common tracking keys</option>
                  <option value="remove-all">Remove all query keys</option>
                </select>
              </div>
              <div className="config-note">Selenium rendering is unavailable in this version. Website scans use the built-in HTTP crawler.</div>
              <div className="config-note">Headless CLI adapter enabled; see README for the integration boundary.</div>
              <button className="primary">Save settings <span>→</span></button>
            </form>
          )}
        </section>
      </main>

      {/* Discovered URL modal */}
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <section className="detail-modal wide-modal" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => setSelected(null)}>×</button>
            <div className="eyebrow">DETAILS</div>
            <h2>{selected.name || selected.target || selected.company || selected.title || 'Record details'}</h2>
            <div className="detail-grid">
              {Object.entries(selected).filter(([k, v]) => !['_id', '__v', 'logs', 'options'].includes(k) && v != null && typeof v !== 'object').map(([k, v]) => (
                <div key={k}>
                  <small>{k.replace(/[A-Z]/g, ' $&')}</small>
                  <b>{String(v)}</b>
                </div>
              ))}
            </div>
            {selected.progress?.sitemapDiscovery?.truncated && (
              <p className="config-note">
                Sitemap discovery reached its safety limits. {selected.progress.sitemapDiscovery.remainingSources} sitemap source(s) were not processed.
              </p>
            )}
            {selected.type === 'website' && <ScanResults scanId={selected._id} />}
          </section>
        </div>
      )}
    </div>
  )
}

function Status({ status }) {
  return <span className={`status ${status}`}>{status}</span>
}

function ScanRow({ scan, onClick }) {
  return (
    <button className="scan-row" onClick={onClick}>
      <span className="scan-symbol">{scan.type === 'website' ? '◎' : scan.type === 'company' ? '▦' : '◷'}</span>
      <span className="scan-info">
        <b>{scan.target}</b>
        <small>{scan.type} · {date(scan.createdAt)}</small>
      </span>
      <Status status={scan.status} />
      <span className="row-arrow">↗</span>
    </button>
  )
}

function Empty({ icon, title, text, action, actionText }) {
  return (
    <div className="empty">
      <span>{icon}</span>
      <b>{title}</b>
      <p>{text}</p>
      {action && <button className="text-button" onClick={action}>{actionText} →</button>}
    </div>
  )
}

function ScanResults({ scanId }) {
  const [tab, setTab] = useState('discovered')
  const [profiles, setProfiles] = useState([])
  const [profilesTotal, setProfilesTotal] = useState(0)
  const [profilesLoading, setProfilesLoading] = useState(true)
  const [profilesError, setProfilesError] = useState('')
  const [profileFilter, setProfileFilter] = useState('all')
  const [profileSearch, setProfileSearch] = useState('')
  const [shortlistUpdating, setShortlistUpdating] = useState({})
  const [profileCounts, setProfileCounts] = useState({
    all: 0,
    shortlisted: 0,
    extracted: 0,
    verified: 0,
    unverified: 0,
    promoted: 0,
  })

  // Level 2 Contact Extraction state
  const [selectedCandidateIds, setSelectedCandidateIds] = useState([])
  const [extracting, setExtracting] = useState(false)
  const [extractionNotice, setExtractionNotice] = useState('')
  const [activeEvidence, setActiveEvidence] = useState(null)

  // Stage 3 CRM Promotion state
  const [promoting, setPromoting] = useState(false)
  const [promotionNotice, setPromotionNotice] = useState('')

  const [scanLeads, setScanLeads] = useState([])
  const [leadsLoading, setLeadsLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [skip, setSkip] = useState(0)
  const [retryKey, setRetryKey] = useState(0)
  const moreController = useRef(null)

  const loadScanLeads = useCallback(() => {
    setLeadsLoading(true)
    fetch(`${API}/leads?scanId=${scanId}`)
      .then(res => res.json())
      .then(data => setScanLeads(Array.isArray(data) ? data : []))
      .catch(() => setScanLeads([]))
      .finally(() => setLeadsLoading(false))
  }, [scanId])

  useEffect(() => {
    let active = true
    fetch(`${API}/leads?scanId=${scanId}`)
      .then(res => res.json())
      .then(data => { if (active) setScanLeads(Array.isArray(data) ? data : []) })
      .catch(() => { if (active) setScanLeads([]) })
      .finally(() => { if (active) setLeadsLoading(false) })
    return () => { active = false }
  }, [scanId])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setProfilesLoading(true)
      setProfilesError('')
      try {
        const qs = new URLSearchParams({ limit: '100', skip: '0' })
        if (profileFilter === 'shortlisted') qs.set('shortlisted', 'true')
        if (profileSearch.trim()) qs.set('q', profileSearch.trim())
        const res = await fetch(`${API}/scans/${scanId}/profiles?${qs}`, { signal: controller.signal })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `Could not load discovered profiles (${res.status}).`)
        if (active) {
          const items = Array.isArray(data.items) ? data.items : []
          setProfiles(items)
          setProfilesTotal(typeof data.total === 'number' ? data.total : items.length)
          if (data.counts) {
            setProfileCounts(data.counts)
          } else {
            setProfileCounts({
              all: items.length,
              shortlisted: items.filter(p => p.shortlisted).length,
              extracted: items.filter(p => p.extractionStatus === 'completed' || p.extractionStatus === 'needs_review' || p.email || p.phone).length,
              verified: items.filter(p => p.classification === 'verified' || p.isVerified).length,
              unverified: items.filter(p => p.classification !== 'verified' && !p.isVerified).length,
              promoted: items.filter(p => p.promoted).length,
            })
          }
        }
      } catch (err) {
        if (active && err.name !== 'AbortError') {
          setProfilesError(err.message || 'Could not load discovered profiles.')
        }
      } finally {
        if (active) setProfilesLoading(false)
      }
    }, 150)
    return () => {
      active = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [scanId, profileFilter, profileSearch])

  const toggleShortlist = async (candidate) => {
    const targetId = candidate._id
    const nextStatus = !candidate.shortlisted
    setProfiles(prev => prev.map(p => p._id === targetId ? { ...p, shortlisted: nextStatus } : p))
    setShortlistUpdating(prev => ({ ...prev, [targetId]: true }))
    try {
      const res = await fetch(`${API}/scans/${scanId}/profiles/${targetId}/shortlist`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortlisted: nextStatus })
      })
      const data = await res.json()
      if (!res.ok) {
        setProfiles(prev => prev.map(p => p._id === targetId ? { ...p, shortlisted: candidate.shortlisted } : p))
        alert(data.error || 'Failed to update shortlist status.')
      } else if (profileFilter === 'shortlisted' && !nextStatus) {
        setProfiles(prev => prev.filter(p => p._id !== targetId))
        setProfilesTotal(prev => Math.max(0, prev - 1))
      }
    } catch (err) {
      setProfiles(prev => prev.map(p => p._id === targetId ? { ...p, shortlisted: candidate.shortlisted } : p))
      alert(err.message || 'Failed to update shortlist status.')
    } finally {
      setShortlistUpdating(prev => {
        const copy = { ...prev }
        delete copy[targetId]
        return copy
      })
    }
  }

  // Level 2 Contact Extraction handler
  const extractContacts = async (ids = null) => {
    setExtracting(true)
    setExtractionNotice('')
    try {
      const payload = ids && ids.length > 0
        ? { candidateIds: ids }
        : selectedCandidateIds.length > 0
        ? { candidateIds: selectedCandidateIds }
        : { allShortlisted: true }

      const res = await fetch(`${API}/scans/${scanId}/extract-contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Contact extraction failed.')

      if (Array.isArray(data.items)) {
        const itemMap = new Map(data.items.map(item => [item._id, item]))
        setProfiles(prev => prev.map(p => itemMap.has(p._id) ? { ...p, ...itemMap.get(p._id) } : p))
      }

      setExtractionNotice(
        `Contact extraction complete: ${data.completed || 0} completed, ${data.needsReview || 0} needs review${data.failed ? `, ${data.failed} failed` : ''}.`
      )
      setSelectedCandidateIds([])
    } catch (err) {
      alert(err.message || 'Contact extraction failed.')
    } finally {
      setExtracting(false)
    }
  }

  const handleBulkShortlist = async (shortlist) => {
    setShortlistUpdating(prev => ({ ...prev, _bulk: true }))
    try {
      const res = await fetch(`${API}/scans/${scanId}/profiles/shortlist`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortlisted: shortlist })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to update shortlist.')
      setProfiles(prev => prev.map(p => ({ ...p, shortlisted: shortlist })))
      setProfileCounts(prev => ({ ...prev, shortlisted: data.totalShortlisted ?? (shortlist ? prev.all : 0) }))
      setPromotionNotice(shortlist ? `★ Successfully shortlisted all ${data.totalShortlisted || 'discovered'} candidates.` : '☆ Removed all candidates from shortlist.')
    } catch (err) {
      alert(err.message || 'Failed to update shortlist.')
    } finally {
      setShortlistUpdating(prev => {
        const copy = { ...prev }
        delete copy._bulk
        return copy
      })
    }
  }

  const shortlistedProfiles = profiles.filter(p => p.shortlisted)

  const displayedProfiles = profiles.filter(p => {
    const isExtracted = p.extractionStatus === 'completed' || p.extractionStatus === 'needs_review' || Boolean(p.email) || Boolean(p.phone)
    const isVerified = p.classification === 'verified' || p.isVerified
    if (profileFilter === 'shortlisted') return p.shortlisted
    if (profileFilter === 'extracted') return isExtracted
    if (profileFilter === 'verified') return isVerified
    if (profileFilter === 'unverified') return !isVerified
    if (profileFilter === 'promoted') return p.promoted
    return true
  })

  const toggleSelectAllCategory = () => {
    if (selectedCandidateIds.length === displayedProfiles.length && displayedProfiles.length > 0) {
      setSelectedCandidateIds([])
    } else {
      setSelectedCandidateIds(displayedProfiles.map(p => p._id))
    }
  }

  const toggleSelectCandidate = (id) => {
    setSelectedCandidateIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const promoteCandidates = async (ids = null, allShortlisted = false, category = null) => {
    setPromoting(true)
    setPromotionNotice('')
    try {
      const payload = {}
      if (ids && ids.length > 0) {
        payload.candidateIds = ids
      } else if (selectedCandidateIds.length > 0) {
        payload.candidateIds = selectedCandidateIds
      } else if (category) {
        payload.category = category
      } else if (allShortlisted) {
        payload.allShortlisted = true
      } else {
        payload.allShortlisted = true
      }

      const res = await fetch(`${API}/scans/${scanId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Promotion to CRM failed.')

      if (Array.isArray(data.items)) {
        const itemMap = new Map(data.items.filter(i => i.success).map(i => [i.candidateId, i]))
        setProfiles(prev => prev.map(p => {
          if (itemMap.has(p._id)) {
            const resItem = itemMap.get(p._id)
            return { ...p, promoted: true, leadId: resItem.leadId }
          }
          return p
        }))
        setProfileCounts(prev => ({ ...prev, promoted: (prev.promoted || 0) + (data.promoted || 0) }))
      }

      setPromotionNotice(
        `CRM Promotion complete: ${data.promoted || 0} new lead(s) created, ${data.reused || 0} existing lead(s) reused/enriched${data.alreadyPromoted ? `, ${data.alreadyPromoted} already in CRM` : ''}${data.failed ? `, ${data.failed} failed` : ''}.`
      )
      setSelectedCandidateIds([])
      loadScanLeads()
    } catch (err) {
      alert(err.message || 'Promotion to CRM failed.')
    } finally {
      setPromoting(false)
    }
  }

  const promote = async () => {
    await promoteCandidates(null, true)
  }

  useEffect(() => {
    let stopped = false
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      setLoadingMore(false)
      setError('')
      setItems([])
      setTotal(0)
      setSkip(0)
      try {
        const qs = new URLSearchParams({ limit: '100', skip: '0' })
        if (query) qs.set('q', query)
        if (source) qs.set('source', source)
        const response = await fetch(`${API}/scans/${scanId}/pages?${qs}`, { signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || `Could not load scan results (${response.status}).`)
        if (!stopped) {
          setItems(data.items || [])
          setTotal(data.total || 0)
          setSkip((data.items || []).length)
        }
      } catch (e) {
        if (!stopped && e.name !== 'AbortError') setError(e.message || 'Could not load scan results.')
      } finally {
        if (!stopped) setLoading(false)
      }
    }, 150)
    return () => {
      stopped = true
      clearTimeout(timer)
      controller.abort()
      moreController.current?.abort()
    }
  }, [scanId, query, source, retryKey])

  const more = async () => {
    if (loadingMore || loading || error) return
    const controller = new AbortController()
    moreController.current = controller
    setLoadingMore(true)
    setError('')
    try {
      const qs = new URLSearchParams({ limit: '100', skip: String(skip) })
      if (query) qs.set('q', query)
      if (source) qs.set('source', source)
      const response = await fetch(`${API}/scans/${scanId}/pages?${qs}`, { signal: controller.signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `Could not load more results (${response.status}).`)
      setItems(old => [...old, ...(data.items || [])])
      setSkip(old => old + (data.items || []).length)
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'Could not load more results.')
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false)
      if (moreController.current === controller) moreController.current = null
    }
  }

  const retry = () => {
    setError('')
    setLoading(true)
    setRetryKey(value => value + 1)
  }

  return (
    <section className="scan-results">
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', borderBottom: '1px solid #edf0f2', paddingBottom: '10px' }}>
        <button
          className={`secondary ${tab === 'discovered' ? 'primary' : ''}`}
          style={{ padding: '6px 14px', fontSize: '11px' }}
          onClick={() => setTab('discovered')}
        >
          Discovered Profiles ({profilesTotal})
        </button>
        <button
          className={`secondary ${tab === 'leads' ? 'primary' : ''}`}
          style={{ padding: '6px 14px', fontSize: '11px' }}
          onClick={() => setTab('leads')}
        >
          CRM Leads ({scanLeads.length})
        </button>
        <button
          className={`secondary ${tab === 'urls' ? 'primary' : ''}`}
          style={{ padding: '6px 14px', fontSize: '11px' }}
          onClick={() => setTab('urls')}
        >
          Crawled URLs ({total})
        </button>
        {tab === 'leads' && (
          <button className="secondary" style={{ marginLeft: 'auto', fontSize: '11px' }} onClick={promote}>
            ⚡ Sync / Promote Candidates
          </button>
        )}
      </div>

      {tab === 'discovered' ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '14px', borderBottom: '1px solid #edf0f2', paddingBottom: '12px' }}>
            {/* Classification & Filter Tabs */}
            <div className="filter-pills" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              <button
                type="button"
                className={`filter-pill ${profileFilter === 'all' ? 'active' : ''}`}
                onClick={() => { setProfileFilter('all'); setSelectedCandidateIds([]); }}
              >
                All Discovered ({profileCounts.all || profiles.length})
              </button>
              <button
                type="button"
                className={`filter-pill ${profileFilter === 'shortlisted' ? 'active' : ''}`}
                onClick={() => { setProfileFilter('shortlisted'); setSelectedCandidateIds([]); }}
              >
                ★ Shortlisted ({profileCounts.shortlisted || shortlistedProfiles.length})
              </button>
              <button
                type="button"
                className={`filter-pill ${profileFilter === 'extracted' ? 'active' : ''}`}
                onClick={() => { setProfileFilter('extracted'); setSelectedCandidateIds([]); }}
              >
                All Extracted ({profileCounts.extracted})
              </button>
              <button
                type="button"
                className={`filter-pill ${profileFilter === 'verified' ? 'active' : ''}`}
                onClick={() => { setProfileFilter('verified'); setSelectedCandidateIds([]); }}
                style={{
                  fontWeight: profileFilter === 'verified' ? '700' : '500',
                  color: profileFilter === 'verified' ? '#24534a' : '#2b8a3e',
                  borderColor: profileFilter === 'verified' ? '#24534a' : '#c2e2cf'
                }}
              >
                ✓ Verified ({profileCounts.verified})
              </button>
              <button
                type="button"
                className={`filter-pill ${profileFilter === 'unverified' ? 'active' : ''}`}
                onClick={() => { setProfileFilter('unverified'); setSelectedCandidateIds([]); }}
                style={{
                  fontWeight: profileFilter === 'unverified' ? '700' : '500',
                  color: profileFilter === 'unverified' ? '#8f6b00' : '#d97706',
                  borderColor: profileFilter === 'unverified' ? '#8f6b00' : '#fde68a'
                }}
              >
                ⚠ Unverified ({profileCounts.unverified})
              </button>
              <button
                type="button"
                className={`filter-pill ${profileFilter === 'promoted' ? 'active' : ''}`}
                onClick={() => { setProfileFilter('promoted'); setSelectedCandidateIds([]); }}
              >
                ✓ In CRM ({profileCounts.promoted})
              </button>
            </div>

            {/* Action Bar: Bulk Shortlisting, Contact Extraction, and CRM Promotion */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {/* Bulk shortlisting buttons */}
                <button
                  className="secondary"
                  style={{ fontSize: '11px', padding: '5px 10px' }}
                  onClick={() => handleBulkShortlist(true)}
                  disabled={shortlistUpdating._bulk || profiles.length === 0}
                  title="Shortlist all discovered candidates from this scan"
                >
                  ★ Shortlist All ({profileCounts.all || profiles.length})
                </button>
                <button
                  className="secondary"
                  style={{ fontSize: '11px', padding: '5px 10px' }}
                  onClick={() => handleBulkShortlist(false)}
                  disabled={shortlistUpdating._bulk || (profileCounts.shortlisted === 0 && shortlistedProfiles.length === 0)}
                  title="Remove all candidates from shortlist"
                >
                  Remove All from Shortlist
                </button>

                {/* Extraction action */}
                {(profileCounts.shortlisted > 0 || shortlistedProfiles.length > 0 || selectedCandidateIds.length > 0) && (
                  <button
                    className="primary"
                    style={{ fontSize: '11px', padding: '5px 12px' }}
                    onClick={() => extractContacts(selectedCandidateIds.length > 0 ? selectedCandidateIds : null)}
                    disabled={extracting || promoting}
                  >
                    {extracting
                      ? '⚡ Extracting…'
                      : selectedCandidateIds.length > 0
                      ? `⚡ Extract Selected (${selectedCandidateIds.length})`
                      : `⚡ Extract All Shortlisted (${profileCounts.shortlisted || shortlistedProfiles.length})`}
                  </button>
                )}
              </div>

              {/* CRM Promotion Selection */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                {selectedCandidateIds.length > 0 ? (
                  <>
                    <button
                      className="primary"
                      style={{ fontSize: '11px', padding: '5px 12px', background: '#24534a', borderColor: '#1b3f38' }}
                      onClick={() => promoteCandidates(selectedCandidateIds)}
                      disabled={extracting || promoting}
                    >
                      {promoting ? '★ Promoting…' : `★ Add Selected (${selectedCandidateIds.length}) to CRM`}
                    </button>
                    <button
                      className="text-button"
                      style={{ fontSize: '11px', color: '#c33', padding: '4px 6px' }}
                      onClick={() => setSelectedCandidateIds([])}
                    >
                      Clear Selection
                    </button>
                  </>
                ) : (
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      className="secondary"
                      style={{ fontSize: '11px', padding: '5px 10px', color: '#24534a', borderColor: '#24534a', fontWeight: '600' }}
                      onClick={() => promoteCandidates(null, false, 'verified')}
                      disabled={extracting || promoting || profileCounts.verified === 0}
                      title="Promote verified candidates with valid email/phone to CRM"
                    >
                      {promoting ? '…' : `Add Verified (${profileCounts.verified}) to CRM`}
                    </button>
                    <button
                      className="secondary"
                      style={{ fontSize: '11px', padding: '5px 10px' }}
                      onClick={() => promoteCandidates(null, false, 'unverified')}
                      disabled={extracting || promoting || profileCounts.unverified === 0}
                      title="Promote unverified candidates to CRM"
                    >
                      {promoting ? '…' : `Add Unverified (${profileCounts.unverified}) to CRM`}
                    </button>
                    <button
                      className="secondary"
                      style={{ fontSize: '11px', padding: '5px 10px' }}
                      onClick={() => promoteCandidates(null, false, 'both')}
                      disabled={extracting || promoting || (profileCounts.all === 0 && profiles.length === 0)}
                      title="Promote both verified and unverified candidates to CRM"
                    >
                      {promoting ? '…' : 'Add Both to CRM'}
                    </button>
                  </div>
                )}
                <div style={{ fontSize: '11px', color: '#697480', marginLeft: '6px' }}>
                  {displayedProfiles.length} shown of {profileCounts.all || profilesTotal}
                </div>
              </div>
            </div>
          </div>

          <div className="result-tools">
            <div className="search">
              <span>⌕</span>
              <input
                value={profileSearch}
                onChange={e => setProfileSearch(e.target.value)}
                placeholder="Search profiles by name, title, company…"
              />
            </div>
          </div>

          {extractionNotice && (
            <div className="alert success" style={{ marginBottom: '12px' }}>
              {extractionNotice}
              <button style={{ marginLeft: 'auto', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setExtractionNotice('')}>×</button>
            </div>
          )}

          {promotionNotice && (
            <div className="alert success" style={{ marginBottom: '12px' }}>
              {promotionNotice}
              <button style={{ marginLeft: 'auto', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setPromotionNotice('')}>×</button>
            </div>
          )}

          {profilesError && (
            <div className="alert error result-error" role="alert">
              <span>{profilesError}</span>
              <button className="secondary" onClick={() => setProfileSearch(s => s)}>Retry</button>
            </div>
          )}

          {profilesLoading ? (
            <div className="log-empty" role="status">Loading discovered profiles…</div>
          ) : displayedProfiles.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '32px', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={displayedProfiles.length > 0 && selectedCandidateIds.length === displayedProfiles.length}
                        onChange={toggleSelectAllCategory}
                        title="Select all within current category"
                      />
                    </th>
                    <th>Profile</th>
                    <th>Company</th>
                    <th>Extracted Contacts</th>
                    <th>Status & Classification</th>
                    <th>Source & Evidence</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedProfiles.map(candidate => {
                    const initials = (candidate.name || '?')
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map(part => part[0]?.toUpperCase() || '')
                      .join('')
                    const isShortlisted = Boolean(candidate.shortlisted)
                    const isUpdating = Boolean(shortlistUpdating[candidate._id])
                    const isSelected = selectedCandidateIds.includes(candidate._id)

                    return (
                      <tr key={candidate._id} style={{ background: isSelected ? '#f6f9f8' : 'transparent' }}>
                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectCandidate(candidate._id)}
                            disabled={extracting || promoting}
                            title={`Select ${candidate.name || 'candidate'}`}
                          />
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div className="avatar" style={{ width: '28px', height: '28px', fontSize: '10px', flexShrink: 0 }}>
                              {initials}
                            </div>
                            <div>
                              <b>{candidate.name}</b>
                              <small style={{ display: 'block', color: '#556270' }}>{candidate.title || candidate.designation || '—'}</small>
                            </div>
                          </div>
                        </td>
                        <td>{candidate.company || '—'}</td>
                        <td>
                          <div>
                            {candidate.email ? (
                              <a href={`mailto:${candidate.email}`} style={{ fontSize: '11px', color: '#1971c2', display: 'block', textDecoration: 'none' }}>
                                ✉ {candidate.email}
                              </a>
                            ) : (
                              <small style={{ color: '#9aa3ad', display: 'block' }}>No email</small>
                            )}
                            {candidate.phone && (
                              <span style={{ fontSize: '11px', color: '#2b8a3e', display: 'block', marginTop: '2px' }}>
                                📞 {candidate.phone}
                              </span>
                            )}
                            {candidate.linkedinUrl && (
                              <a href={candidate.linkedinUrl} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: '#0077b5', display: 'inline-flex', alignItems: 'center', gap: '3px', marginTop: '2px' }}>
                                <b>in</b> LinkedIn ↗
                              </a>
                            )}
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            {candidate.classification === 'verified' || candidate.isVerified ? (
                              <span className="page-status fetched" style={{ fontSize: '9px', background: '#eaf4ee', color: '#24534a', fontWeight: 'bold', border: '1px solid #c2e2cf' }}>
                                ✓ Verified
                              </span>
                            ) : (
                              <span className="page-status blocked" style={{ fontSize: '9px', background: '#fff9db', color: '#8f6b00', fontWeight: 'bold', border: '1px solid #ffe066' }}>
                                ⚠ Unverified
                              </span>
                            )}
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              fontSize: '10px',
                              fontWeight: '600',
                              padding: '2px 8px',
                              borderRadius: '12px',
                              background: candidate.confidenceScore >= 3 ? '#eaf4ee' : candidate.confidenceScore >= 2 ? '#e8f0fe' : '#f1f3f5',
                              color: candidate.confidenceScore >= 3 ? '#3e805c' : candidate.confidenceScore >= 2 ? '#1971c2' : '#69737f'
                            }}>
                              Score {candidate.confidenceScore || 0}
                            </span>
                            {candidate.extractionStatus === 'completed' ? (
                              <span className="page-status fetched" style={{ fontSize: '9px' }}>Completed</span>
                            ) : candidate.extractionStatus === 'needs_review' ? (
                              <span className="page-status blocked" style={{ fontSize: '9px' }}>Needs Review</span>
                            ) : candidate.extractionStatus === 'failed' ? (
                              <span className="page-status failed" style={{ fontSize: '9px' }} title={candidate.extractionError || 'Extraction failed'}>Failed</span>
                            ) : candidate.extractionStatus === 'extracting' ? (
                              <span className="status running" style={{ fontSize: '9px' }}>Extracting…</span>
                            ) : (
                              <span className="page-status" style={{ fontSize: '9px' }}>Discovered</span>
                            )}
                            {candidate.promoted && (
                              <span className="page-status fetched" style={{ fontSize: '9px', background: '#eaf4ee', color: '#24534a', border: '1px solid #c2e2cf' }}>
                                ✓ In CRM
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div>
                            {candidate.sourceUrl ? (
                              <a href={candidate.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: '11px', color: '#1d594e', display: 'block' }}>
                                Bio Page ↗
                              </a>
                            ) : '—'}
                            {Array.isArray(candidate.provenance) && candidate.provenance.length > 0 && (
                              <button
                                type="button"
                                className="text-button"
                                style={{ fontSize: '10px', padding: '2px 0', marginTop: '2px' }}
                                onClick={() => setActiveEvidence(candidate)}
                              >
                                🔍 Evidence ({candidate.provenance.length})
                              </button>
                            )}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <button
                              className={isShortlisted ? 'primary' : 'secondary'}
                              style={{
                                padding: '4px 10px',
                                fontSize: '11px',
                                borderRadius: '5px',
                                cursor: isUpdating ? 'wait' : 'pointer'
                              }}
                              disabled={isUpdating}
                              onClick={() => toggleShortlist(candidate)}
                            >
                              {isShortlisted ? '★ Shortlisted' : '☆ Shortlist'}
                            </button>
                            {isShortlisted && (
                              candidate.extractionStatus === 'failed' || candidate.extractionStatus === 'needs_review' ? (
                                <button
                                  className="secondary"
                                  style={{ padding: '4px 8px', fontSize: '10px', borderRadius: '5px' }}
                                  disabled={extracting}
                                  onClick={() => extractContacts([candidate._id])}
                                  title="Retry contact extraction"
                                >
                                  ↻ Retry
                                </button>
                              ) : candidate.extractionStatus !== 'completed' ? (
                                <button
                                  className="secondary"
                                  style={{ padding: '4px 8px', fontSize: '10px', borderRadius: '5px' }}
                                  disabled={extracting}
                                  onClick={() => extractContacts([candidate._id])}
                                  title="Extract contact info from bio page"
                                >
                                  ⚡ Extract
                                </button>
                              ) : null
                            )}
                            {candidate.promoted ? (
                              <span style={{ fontSize: '11px', color: '#24534a', fontWeight: '600', padding: '4px 4px' }}>
                                ✓ In CRM
                              </span>
                            ) : (
                              <button
                                className="secondary"
                                style={{ padding: '4px 8px', fontSize: '10px', borderRadius: '5px', color: '#24534a', borderColor: '#24534a' }}
                                disabled={promoting}
                                onClick={() => promoteCandidates([candidate._id])}
                                title="Promote this profile to CRM"
                              >
                                ★ Add to CRM
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : !profilesError && (
            <div className="log-empty">
              {profileFilter === 'shortlisted'
                ? 'No candidates have been shortlisted yet. Browse all profiles and click "☆ Shortlist" to shortlist candidates for extraction.'
                : profileFilter === 'extracted'
                ? 'No contacts have been extracted yet. Select shortlisted candidates and click "⚡ Extract Contacts".'
                : 'No person profiles discovered for this scan.'}
            </div>
          )}

          {/* Contact Evidence Modal */}
          {activeEvidence && (
            <div className="modal-backdrop" onClick={() => setActiveEvidence(null)}>
              <div className="detail-modal wide-modal" onClick={e => e.stopPropagation()}>
                <button className="close" onClick={() => setActiveEvidence(null)}>×</button>
                <div className="eyebrow">CONTACT PROVENANCE & EVIDENCE</div>
                <h2>{activeEvidence.name}</h2>
                <p style={{ fontSize: '11px', color: '#697480', margin: '4px 0 16px' }}>
                  {activeEvidence.title || activeEvidence.designation || 'Role'} · {activeEvidence.company || 'Company'}
                </p>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Extracted Value</th>
                        <th>Method</th>
                        <th>Source URL</th>
                        <th>Validation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(activeEvidence.provenance || []).map((p, idx) => (
                        <tr key={idx}>
                          <td><b>{p.fieldName}</b></td>
                          <td><code>{String(p.value)}</code></td>
                          <td><span className="page-status">{p.method}</span></td>
                          <td>
                            <a href={p.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: '11px', color: '#1d594e' }}>
                              {p.sourceUrl} ↗
                            </a>
                          </td>
                          <td>
                            <span className={`page-status ${p.validationStatus === 'syntax_valid' ? 'fetched' : 'blocked'}`}>
                              {p.validationStatus || 'unverified'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="secondary" onClick={() => setActiveEvidence(null)}>Close</button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : tab === 'leads' ? (
        leadsLoading ? (
          <div className="log-empty">Loading discovered profiles...</div>
        ) : scanLeads.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{['Name', 'Title', 'Company', 'Email', 'Phone', 'Source'].map(h => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {scanLeads.map(l => (
                  <tr key={l._id}>
                    <td><b>{l.name}</b></td>
                    <td>{l.title || '—'}</td>
                    <td>{l.email ? <a href={`mailto:${l.email}`}>{l.email}</a> : '—'}</td>
                    <td>{l.phone ? <a href={`tel:${l.phone}`}>{l.phone}</a> : '—'}</td>
                    <td>{l.company || '—'}</td>
                    <td><small>{l.sourceUrl}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="log-empty">No leads registered for this scan yet. Click "Sync / Promote Candidates" to sync.</div>
        )
      ) : (
        <>
          <div className="panel-head">
            <div>
              <h2>Discovered URLs</h2>
              <p>{total} matching URLs{loading || loadingMore ? ' · Loading…' : ''}</p>
            </div>
          </div>
          <div className="result-tools">
            <div className="search">
              <span>⌕</span>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search URLs" />
            </div>
            <select value={source} onChange={e => setSource(e.target.value)}>
              <option value="">All sources</option>
              <option value="seed">Seed</option>
              <option value="sitemap">Sitemap</option>
              <option value="rss">RSS / Atom</option>
              <option value="internal-link">Internal link</option>
            </select>
          </div>
          {error && (
            <div className="alert error result-error" role="alert">
              <span>{error}</span>
              <button className="secondary" onClick={retry}>Retry</button>
            </div>
          )}
          {loading ? (
            <div className="log-empty" role="status">Loading discovered URLs…</div>
          ) : items.length ? (
            <div className="url-results">
              {items.map(item => (
                <div className="url-result" key={item._id}>
                  <div className="url-main">
                    <a href={item.url} target="_blank" rel="noreferrer">{item.url} ↗</a>
                    <small>{item.source}{item.sourceUrl ? ` · found on ${item.sourceUrl}` : ''}</small>
                  </div>
                  <span className={`page-status ${item.processingStatus}`}>{item.httpStatus || item.processingStatus}</span>
                </div>
              ))}
            </div>
          ) : !error && (
            <div className="log-empty">No discovered URLs match this filter.</div>
          )}
          {!error && skip < total && (
            <button className="secondary load-more" disabled={loadingMore} onClick={more}>
              {loadingMore ? 'Loading…' : 'Load more URLs'}
            </button>
          )}
        </>
      )}
    </section>
  )
}

export default App
