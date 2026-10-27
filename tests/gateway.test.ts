import { test } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/gateway.ts'
import type { AuthBindings } from '../src/auth.ts'

const base = 'https://auth.example.com'
const headers = (response: Response) => {
  for (const [key, value] of Object.entries({
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'unsafe-none',
  })) assert.equal(response.headers.get(key), value, key)
  assert.ok(response.headers.get('content-security-policy')?.includes("default-src 'none'"))
  assert.equal(response.headers.get('access-control-allow-origin'), null)
}

test('standalone health and unknown routes work without configuration and retain hardening', async () => {
  const health = await app.request(`${base}/health`, undefined, {})
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok', service: 'Rigel CMS Authenticator' })
  headers(health)
  for (const path of ['/', '/auth', '/auth/callback', '/analytics', '/mcp', '/script.js', '/missing']) {
    const response = await app.request(`${base}${path}`, undefined, {})
    assert.equal(response.status, 404)
    headers(response)
    assert.deepEqual(await response.json(), { error: 'Not found' })
  }
})

test('all known paths reject unsupported methods explicitly, including HEAD and OPTIONS', async () => {
  for (const [path, allowed] of [['/authorize', 'GET, POST'], ['/callback', 'GET'], ['/refresh', 'POST'], ['/health', 'GET']]) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      if (allowed.split(', ').includes(method)) continue
      const response = await app.request(`${base}${path}`, { method }, {})
      assert.equal(response.status, 405, `${method} ${path}`)
      assert.equal(response.headers.get('allow'), allowed)
      headers(response)
    }
  }
})

test('configuration and unexpected errors are generic, hardened and never expose provider details', async () => {
  for (const env of [{}, { get GH_CLIENT_ID() { throw new Error('private-provider-detail') } }]) {
    const response = await app.request(`${base}/authorize`, undefined, env as AuthBindings)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Authentication unavailable' })
    headers(response)
  }
})
