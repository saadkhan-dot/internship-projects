export function parseRobots(text, userAgent = 'LeadIntelBot') {
  const groups = []
  let group = null
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.split('#')[0].trim()
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const directive = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (directive === 'user-agent') {
      if (!group || group.hasRules) { group = { agents: [], rules: [], crawlDelay: 0, hasRules: false }; groups.push(group) }
      group.agents.push(value.toLowerCase())
    } else if (group && ['allow', 'disallow'].includes(directive)) {
      if (value) group.rules.push({ allow: directive === 'allow', path: value })
      group.hasRules = true
    } else if (group && directive === 'crawl-delay') {
      const delay = Number(value); if (Number.isFinite(delay) && delay >= 0) group.crawlDelay = delay
    } else if (directive === 'sitemap' && value) groups.sitemaps ??= [], groups.sitemaps.push(value)
  }
  const matching = groups.filter(g => g.agents.some(a => a === '*' || userAgent.toLowerCase().includes(a)))
  const specificity = Math.max(0, ...matching.map(g => Math.max(...g.agents.map(a => a === '*' ? 0 : a.length))))
  const selected = matching.filter(g => Math.max(...g.agents.map(a => a === '*' ? 0 : a.length)) === specificity)
  return { rules: selected.flatMap(g => g.rules), crawlDelay: Math.max(0, ...selected.map(g => g.crawlDelay)), sitemaps: groups.sitemaps || [] }
}

export function isAllowedByRobots(url, rules) {
  const path = new URL(url).pathname + new URL(url).search
  const matches = rules.filter(rule => path.startsWith(rule.path)).sort((a, b) => b.path.length - a.path.length)
  return matches.length === 0 || matches[0].allow
}
