import assert from 'node:assert/strict'
import { test } from 'node:test'
import cloudflare from '../cloudflare/index.ts'
import vercel from '../src/index.ts'
import netlify from '../netlify/functions/auth.ts'

const base = 'https://auth.example.com'
const editor = 'https://editor.example.com'
const bindings = {
  GH_CLIENT_ID: 'adapter-fixture-client',
  GH_CLIENT_SECRET: 'adapter-fixture-client-secret',
  AUTH_SECRET: 'adapter-fixture-cookie-secret-at-least-32-characters',
  SITE_ORIGIN: base,
  ALLOWED_ORIGINS: '',
}
const adapters = {
  cloudflare: (request: Request) => cloudflare.fetch(request, bindings),
  netlify,
  vercel: (request: Request) => vercel.fetch(request),
}
const cookie = (response: Response, kind: string) => {
  const value = response.headers.getSetCookie().find(value => value.startsWith(`__Host-rigel-${kind}=`))
  assert.ok(value)
  return value.split(';')[0]!
}

for (const [name, adapter] of Object.entries(adapters)) {
  test(`${name}: public confirmation, callback, cookie rotation and refresh retain the shared security contract`, async t => {
    const previous = Object.fromEntries(Object.keys(bindings).map(key => [key, process.env[key]]))
    Object.assign(process.env, bindings)
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
    const nonce = 'adapter-fixture-random-caller-nonce-1234567890'
    let exchanges = 0
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
      assert.equal(url, 'https://github.com/login/oauth/access_token')
      assert.equal(options?.redirect, 'manual')
      const form = new URLSearchParams(String(options?.body))
      assert.equal(form.get('client_id'), bindings.GH_CLIENT_ID)
      assert.equal(form.get('client_secret'), bindings.GH_CLIENT_SECRET)
      assert.ok(form.has('code_verifier') || form.get('grant_type') === 'refresh_token')
      exchanges++
      return Response.json({ access_token: 'ghu_adapter-fixture', refresh_token: 'ghr_adapter-fixture', expires_in: 28800, refresh_token_expires_in: 15897600, token_type: 'bearer', scope: '' })
    })
    const request = (path: string, init?: RequestInit) => adapter(new Request(base + path, init))
    assert.equal((await request('/health')).status, 200)
    assert.equal((await request('/authorize', { method: 'OPTIONS' })).status, 405)
    const confirmation = await request(`/authorize?${new URLSearchParams({ origin: editor, nonce })}`)
    assert.equal(confirmation.status, 200)
    assert.equal(confirmation.headers.get('cache-control'), 'no-store')
    assert.equal(confirmation.headers.get('cross-origin-opener-policy'), 'unsafe-none')
    const html = await confirmation.text()
    assert.ok(html.includes(editor))
    const csrf = html.match(/name="csrf" value="([\w-]+)"/)![1]
    const accepted = await request('/authorize', {
      method: 'POST', headers: { Origin: base, Cookie: cookie(confirmation, 'consent'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    })
    assert.equal(accepted.status, 303)
    const authorization = new URL(accepted.headers.get('location')!)
    assert.equal(authorization.origin, 'https://github.com')
    assert.equal(authorization.searchParams.get('redirect_uri'), base + '/callback')
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(accepted.headers.getSetCookie().length, 2)
    const callback = await request(`/callback?state=${authorization.searchParams.get('state')}&code=adapter-fixture`, { headers: { Cookie: cookie(accepted, 'state') } })
    assert.equal(callback.status, 200)
    assert.equal(callback.headers.getSetCookie().length, 2)
    const result = await callback.text()
    assert.ok(result.includes('ghu_adapter-fixture'))
    assert.ok(result.includes(nonce) && result.includes(editor))
    assert.ok(!result.includes('ghr_adapter-fixture'))
    assert.ok(callback.headers.getSetCookie().some(value => value.includes('HttpOnly') && value.includes('Secure') && value.includes('SameSite=Lax')))
    const refreshCookie = cookie(callback, 'refresh')
    const rejected = await request('/refresh', { method: 'POST', headers: { Origin: editor, Cookie: refreshCookie, 'X-Rigel-CSRF': '1' } })
    assert.equal(rejected.status, 403)
    const refreshed = await request('/refresh', { method: 'POST', headers: { Origin: base, Cookie: refreshCookie, 'X-Rigel-CSRF': '1' } })
    assert.equal(refreshed.status, 200)
    assert.equal((await refreshed.json()).access_token, 'ghu_adapter-fixture')
    assert.equal(exchanges, 2)
    const wrongHost = await adapter(new Request('https://wrong.example/authorize'))
    assert.equal(wrongHost.status, 403)
  })
}
