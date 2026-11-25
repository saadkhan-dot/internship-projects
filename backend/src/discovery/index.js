import { BuiltInDiscoveryAdapter } from './crawler.js'

const adapters = { builtin: new BuiltInDiscoveryAdapter() }
export function getDiscoveryAdapter(name = 'builtin') {
  const adapter = adapters[name]
  if (!adapter) throw new Error(`Discovery adapter "${name}" is not configured`)
  return adapter
}
