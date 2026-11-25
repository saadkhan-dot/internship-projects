import test from 'node:test'
import assert from 'node:assert/strict'
import http, { createServer } from 'node:http'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { safeFetch, validateOutboundUrl } from '../src/discovery/fetch.js'

test('safeFetch satisfies Node all:true lookup contract and pins the first validated IPv4 answer', async () => {
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('pinned') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const answers = [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }]
  const originalRequest = http.request
  let allLookupMode = false
  http.request = (url, options, callback) => originalRequest(url, {
    ...options,
    lookup: (hostname, lookupOptions, done) => {
      allLookupMode ||= lookupOptions?.all === true
      options.lookup(hostname, lookupOptions, done)
    },
  }, callback)
  try {
    const result = await safeFetch(`http://fixture.test:${server.address().port}/`, {
      allowLocalFixtures: true,
      timeoutMs: 1000,
      lookup: async () => answers,
    })
    assert.equal(await result.text(), 'pinned')
    assert.equal(result.status, 200)
    assert.equal(allLookupMode, true, 'Node requested all:true from the custom resolver')
  } finally { http.request = originalRequest; await new Promise(resolve => server.close(resolve)) }
})

test('public IPv4 and IPv6 results retain address families and mixed unsafe results are filtered', async () => {
  const lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '10.0.0.1', family: 4 },
  ]
  const { addresses } = await validateOutboundUrl('https://example.test/', { lookup })
  assert.deepEqual(addresses, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ])
})

test('valid public IPv4 and IPv6 DNS answers reach the request layer with one pinned answer', async () => {
  const originalRequest = http.request
  const pinned = []
  http.request = (_url, options, callback) => {
    const req = new EventEmitter()
    req.end = () => {
      options.lookup('mocked.example', { all: true }, (error, addresses) => {
        assert.ifError(error)
        pinned.push(addresses)
        const response = Readable.from([Buffer.from('ok')])
        response.statusCode = 200
        response.headers = { 'content-type': 'text/plain' }
        callback(response)
        req.emit('close')
      })
    }
    req.destroy = error => req.emit('error', error)
    return req
  }
  const byHost = {
    'v4.example': [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }, { address: '10.0.0.1', family: 4 }],
    'v6.example': [{ address: '2606:4700:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }],
  }
  try {
    for (const hostname of Object.keys(byHost)) {
      const response = await safeFetch(`http://${hostname}/`, { lookup: async host => byHost[host] })
      assert.equal(await response.text(), 'ok')
    }
    assert.deepEqual(pinned, [
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '2606:4700:4700::1111', family: 6 }],
    ])
  } finally { http.request = originalRequest }
})

test('redirect targets are re-resolved and unsafe addresses are rejected before another request', async () => {
  const originalRequest = http.request
  let requests = 0
  http.request = (_url, _options, callback) => {
    requests++
    const req = new EventEmitter()
    req.end = () => {
      const response = Readable.from([])
      response.statusCode = 302
      response.headers = { location: 'http://private.example/redirected' }
      response.resume = () => {}
      callback(response)
      req.emit('close')
    }
    req.destroy = error => req.emit('error', error)
    return req
  }
  try {
    await assert.rejects(safeFetch('http://public.example/start', {
      lookup: async hostname => hostname === 'public.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.8', family: 4 }],
    }), /prohibited|non-public/)
    assert.equal(requests, 1, 'unsafe redirect destination never reached HTTP request layer')
  } finally { http.request = originalRequest }
})
