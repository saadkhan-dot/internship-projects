import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { PassThrough } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import ipaddr from 'ipaddr.js'

export class CrawlCancelledError extends Error { constructor() { super('Scan cancelled'); this.name = 'CrawlCancelledError' } }
export class ResponseLimitError extends Error { constructor(limit) { super(`Response exceeded the ${limit}-byte processing limit`); this.name = 'ResponseLimitError'; this.limit = limit } }

const isPublicAddress = address => {
  try { return ipaddr.process(address).range() === 'unicast' } catch { return false }
}

export async function resolvePublicHost(hostname, { lookup = dns.lookup, allowLocalFixtures = false } = {}) {
  hostname = hostname.replace(/^\[|\]$/g, '')
  if (allowLocalFixtures) return await lookup(hostname, { all: true, verbatim: true })
  const literal = ipaddr.isValid(hostname) ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }] : await lookup(hostname, { all: true, verbatim: true })
  // Mixed DNS answers are common with dual stack and CDN configurations. Keep
  // only explicitly public addresses; never let an unsafe answer become a
  // fallback for a pinned request.
  const safe = literal.filter(result => {
    if (!result || typeof result.address !== 'string' || !isPublicAddress(result.address)) return false
    try {
      const parsed = ipaddr.parse(result.address)
      const family = parsed.kind() === 'ipv6' ? 6 : 4
      return result.family === family
    } catch { return false }
  })
  if (!safe.length) throw new Error(`Host resolves to a prohibited or non-public address: ${hostname}`)
  return safe
}

export async function validateOutboundUrl(input, options = {}) {
  let url
  try { url = new URL(input) } catch { throw new Error('Invalid outbound URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are allowed')
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed')
  const expectedPort = url.protocol === 'https:' ? '443' : '80'
  if (!options.allowLocalFixtures && (url.port && url.port !== expectedPort)) throw new Error('Only standard HTTP on port 80 and HTTPS on port 443 are allowed')
  const addresses = await resolvePublicHost(url.hostname, options)
  return { url, addresses }
}

function decodedStream(response, encoding) {
  const value = (encoding || '').toLowerCase().trim()
  if (!value || value === 'identity') return response
  if (value === 'gzip' || value === 'x-gzip') return response.pipe(createGunzip())
  if (value === 'deflate') return response.pipe(createInflate())
  if (value === 'br') return response.pipe(createBrotliDecompress())
  throw new Error(`Unsupported content encoding: ${value}`)
}

function requestOnce(url, addresses, { signal, timeoutMs, headers }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const selected = addresses[0]
    if (!selected || typeof selected.address !== 'string' || ![4, 6].includes(selected.family)) {
      reject(new Error('No validated IP address available for pinned request'))
      return
    }
    const pinnedAddress = { address: selected.address, family: selected.family }
    const req = transport.request(url, {
      method: 'GET',
      headers: { 'user-agent': 'LeadIntelBot/1.0 (+URL discovery; respects robots.txt)', accept: 'text/html,application/xml,text/xml,*/*;q=0.2', 'accept-encoding': 'gzip, deflate, br', ...headers },
      // DNS was validated immediately before this request. Supplying the pinned
      // address as the only lookup result closes the validate-then-resolve gap.
      // Node's net layer requests all:true when autoSelectFamily is enabled.
      // Its callback contract changes in that mode: callback(null, records).
      // Returning the legacy tuple there makes Node read records[0].address
      // from a string and fail with "Invalid IP address: undefined".
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, [pinnedAddress])
        : callback(null, pinnedAddress.address, pinnedAddress.family),
      servername: url.hostname,
    }, resolve)
    const timeout = setTimeout(() => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
    const abort = () => req.destroy(new CrawlCancelledError())
    signal?.addEventListener('abort', abort, { once: true })
    req.once('error', error => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); reject(signal?.aborted ? new CrawlCancelledError() : error) })
    req.once('close', () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort) })
    req.end()
  })
}

export async function readLimited(response, maxBytes) {
  const stream = decodedStream(response, response.headers['content-encoding'])
  const chunks = []; let size = 0
  try {
    for await (const chunk of stream) {
      size += chunk.length
      if (size > maxBytes) {
        response.destroy()
        throw new ResponseLimitError(maxBytes)
      }
      chunks.push(chunk)
    }
  } catch (error) {
    response.destroy()
    throw error
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

export async function safeFetch(input, { signal, timeoutMs = 10000, maxRedirects = 5, maxHtmlBytes = 2_000_000, maxXmlBytes = 5_000_000, maxBytes, headers = {}, allowLocalFixtures = false, lookup } = {}) {
  let current = new URL(input)
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (signal?.aborted) throw new CrawlCancelledError()
    const { url, addresses } = await validateOutboundUrl(current.href, { allowLocalFixtures, lookup })
    let response
    try { response = await requestOnce(url, addresses, { signal, timeoutMs, headers }) }
    catch (error) { if (signal?.aborted) throw new CrawlCancelledError(); throw error }
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location
      response.resume()
      if (!location) return wrapResponse(response, url, maxBytes || maxHtmlBytes)
      if (redirects === maxRedirects) throw new Error('Too many redirects')
      let next
      try { next = new URL(location, url) } catch { throw new Error('Malformed redirect URL') }
      await validateOutboundUrl(next.href, { allowLocalFixtures, lookup })
      current = next
      continue
    }
    const contentType = response.headers['content-type'] || ''
    const limit = maxBytes || (/xml/i.test(contentType) ? maxXmlBytes : maxHtmlBytes)
    return wrapResponse(response, url, limit)
  }
  throw new Error('Too many redirects')
}

function wrapResponse(response, url, limit) {
  let textPromise
  return {
    status: response.statusCode,
    ok: response.statusCode >= 200 && response.statusCode < 300,
    url: url.href,
    headers: { get: name => response.headers[String(name).toLowerCase()] || null },
    text: () => textPromise ||= readLimited(response, limit),
    body: { cancel: async () => { response.destroy() } },
  }
}
