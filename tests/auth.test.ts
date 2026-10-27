import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { auth } from '../src/auth.ts'
import type { AuthBindings } from '../src/auth.ts'

const env = {
  SITE_ORIGIN: 'https://auth.example.com',
  GH_CLIENT_ID: 'synthetic-client',
  GH_CLIENT_SECRET: 'synthetic-secret',
  AUTH_SECRET: 'synthetic-test-sealing-key-at-least-32-characters',
  ALLOWED_ORIGINS: 'https://editor.example',
}

const request = (path: string, init?: RequestInit, bindings: AuthBindings = env) =>
  auth.request(`https://auth.example.com${path}`, init, bindings)

test('missing configuration fails closed', async () => {
  const response = await request('/authorize?origin=https://editor.example', undefined, {} as typeof env)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const { SITE_ORIGIN, ...withoutSite } = env
  assert.equal((await request('/authorize?origin=https://editor.example', undefined, withoutSite)).status, 503)
})

const tokenData = {
  access_token: 'ghu_synthetic-access', expires_in: 28800,
  refresh_token: 'ghr_synthetic-refresh', refresh_token_expires_in: 15897600,
  token_type: 'bearer', scope: '',
}
const cookiePair = (response: Response, name: string) => {
  const value = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))
  assert.ok(value, `Missing ${name} cookie`)
  return value.split(';')[0]
}
async function start() {
  const response = await request('/authorize?origin=https://editor.example&nonce=synthetic-nonce')
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!)
  return { response, location, cookie: cookiePair(response, '__Host-rigel-state'), state: location.searchParams.get('state')! }
}
async function callback(flow: Awaited<ReturnType<typeof start>>) {
  return request(`/callback?state=${flow.state}&code=synthetic-code`, { headers: { Cookie: flow.cookie } })
}
function refresh(cookie: string, headers: Record<string, string> = {}) {
  return request('/refresh', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://auth.example.com', 'X-Rigel-CSRF': '1', ...headers } })
}

test('public gateway requires destination confirmation before GitHub authorization', async t => {
  const { ALLOWED_ORIGINS, ...publicEnv } = env
  const target = 'https://customer.example'
  const nonce = 'public-client-random-nonce-1234567890'
  const response = await request(`/authorize?${new URLSearchParams({ origin: target, nonce })}`, undefined, publicEnv)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('location'), null)
  assert.equal(response.headers.get('referrer-policy'), 'same-origin')
  const page = await response.text()
  const styleNonce = page.match(/<style nonce="([\w-]+)">/)?.[1]
  assert.ok(styleNonce, 'branded styles must have a CSP nonce')
  assert.ok(response.headers.get('content-security-policy')!.includes(`style-src 'nonce-${styleNonce}'`))
  assert.match(page, /<img[^>]+src="data:image\/png;base64,/)
  assert.equal((page.match(/<script/g) ?? []).length, 0)
  assert.ok(page.includes(target))
  assert.ok(page.includes('all repositories'))
  assert.ok(page.includes('method="post"'))
  assert.ok(response.headers.get('content-security-policy')!.includes("form-action 'self'"))
  const csrf = page.match(/name="csrf" value="([\w-]+)"/)![1]
  const consent = cookiePair(response, '__Host-rigel-consent')
  assert.ok(!response.headers.getSetCookie().some(value => value.startsWith('__Host-rigel-state=')))
  const confirmed = await request('/authorize', {
    method: 'POST', headers: { Origin: 'https://auth.example.com', Cookie: consent },
    body: new URLSearchParams({ csrf, origin: 'https://attacker.example' }),
  }, publicEnv)
  assert.equal(confirmed.status, 303)
  assert.match(cookiePair(confirmed, '__Host-rigel-consent'), /=$/)
  const location = new URL(confirmed.headers.get('location')!)
  assert.equal(location.origin, 'https://github.com')
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
  t.mock.method(globalThis, 'fetch', async () => Response.json(tokenData))
  const result = await request(`/callback?state=${location.searchParams.get('state')}&code=synthetic`, {
    headers: { Cookie: cookiePair(confirmed, '__Host-rigel-state') },
  }, publicEnv)
  assert.equal(result.status, 200)
  const script = (await result.text()).match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]
  const messages: unknown[] = []
  runInNewContext(script, { window: { opener: { postMessage: (payload: unknown, destination: string) => {
    assert.equal(destination, target)
    messages.push(payload)
  } }, close() {} } })
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'rigel:auth', provider: 'github', nonce, access_token: tokenData.access_token, expires_in: 28800 }])
})

test('public confirmation rejects cross-site, forged, expired and oversized submissions', async t => {
  const publicEnv = { ...env, ALLOWED_ORIGINS: '' }
  const response = await request('/authorize?origin=https://customer.example&nonce=public-client-random-nonce-1234567890', undefined, publicEnv)
  assert.equal(response.status, 200)
  const csrf = (await response.text()).match(/name="csrf" value="([\w-]+)"/)![1]
  const cookie = cookiePair(response, '__Host-rigel-consent')
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert.ok(response.headers.get('set-cookie')!.includes(flag))
  const post = (headers: Record<string, string> = {}, body: BodyInit = new URLSearchParams({ csrf })) => request('/authorize', {
    method: 'POST', headers: { Origin: 'https://auth.example.com', Cookie: cookie, ...headers }, body,
  }, publicEnv)
  for (const origin of ['', 'null', 'https://attacker.example']) assert.equal((await post({ Origin: origin })).status, 403)
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await post({ Cookie: '' })).status, 400)
  assert.equal((await post({ Cookie: cookie + 'x' })).status, 400)
  assert.equal((await post({}, new URLSearchParams({ csrf: 'wrong' }))).status, 400)
  assert.equal((await post({}, new URLSearchParams([['csrf', csrf], ['csrf', csrf]]))).status, 400)
  assert.equal((await post({}, new URLSearchParams({ csrf, padding: 'x'.repeat(1024) }))).status, 413)
  const future = Date.now() + 601000
  t.mock.method(Date, 'now', () => future)
  assert.equal((await post()).status, 400)
})

test('public origins stay canonical and public callers must provide a bounded correlation nonce', async () => {
  const publicEnv = { ...env, ALLOWED_ORIGINS: '' }
  for (const value of ['', '*', 'null', 'javascript:alert(1)', 'https://editor.example/', 'https://editor.example/path', 'https://editor.example?x=1', 'https://editor.example#x', 'https://user@editor.example', 'http://editor.example', 'https://' + 'x'.repeat(513)]) {
    assert.equal((await request(`/authorize?${new URLSearchParams({ origin: value, nonce: 'public-client-random-nonce-1234567890' })}`, undefined, publicEnv)).status, 403, value)
  }
  for (const nonce of ['', 'short', '<script>', 'x'.repeat(129)]) {
    assert.equal((await request(`/authorize?${new URLSearchParams({ origin: 'https://customer.example', nonce })}`, undefined, publicEnv)).status, 400)
  }
})

test('configuration rejects short secrets and wildcard or malformed allowed origins', async () => {
  for (const overrides of [{ AUTH_SECRET: 'short' }, { GH_CLIENT_SECRET: '' }, { GH_CLIENT_ID: '' }, { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: 'https://editor.example/' }, { SITE_ORIGIN: 'https://auth.example.com/path' }]) {
    assert.equal((await request('/authorize?origin=https://editor.example', undefined, { ...env, ...overrides })).status, 503)
  }
})

test('initiation allows only exact trusted origins and a bounded nonce', async () => {
  for (const value of ['', '*', 'null', 'https://evil.example', 'https://editor.example/', 'https://editor.example/path', 'https://editor.example?x=1', 'https://editor.example#x', 'https://user@editor.example', 'https://editor.example.evil', 'http://editor.example']) {
    assert.equal((await request(`/authorize?origin=${encodeURIComponent(value)}`)).status, 403, value)
  }
  assert.equal((await request('/authorize?origin=https://editor.example&nonce=%3Cscript%3E')).status, 400)
  assert.equal((await request(`/authorize?origin=https://editor.example&nonce=${'x'.repeat(129)}`)).status, 400)
})

test('initiation uses canonical callback, fresh random state, S256 and a sealed host-only cookie', async () => {
  const first = await start()
  const second = await start()
  assert.equal(first.location.origin, 'https://github.com')
  assert.equal(first.location.pathname, '/login/oauth/authorize')
  assert.equal(first.location.searchParams.get('redirect_uri'), 'https://auth.example.com/callback')
  assert.equal(first.location.searchParams.get('scope'), 'offline_access')
  assert.equal(first.location.searchParams.get('code_challenge_method'), 'S256')
  assert.match(first.location.searchParams.get('code_challenge')!, /^[\w-]{43}$/)
  assert.match(first.state, /^[\w-]{43}$/)
  assert.notEqual(first.state, second.state)
  assert.ok(!first.cookie.includes(first.state))
  const set = first.response.headers.get('set-cookie')!
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert.ok(set.includes(flag))
  assert.ok(!set.includes('Domain='))
  assert.equal(first.response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(first.response.headers.get('cross-origin-opener-policy'), 'unsafe-none')
})

test('missing, tampered, mismatched and expired states fail without GitHub transport', async t => {
  const transport = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network') })
  const flow = await start()
  const cases: Record<string, string>[] = [{}, { Cookie: '__Host-rigel-state=broken' }, { Cookie: `${flow.cookie}x` }]
  for (const headers of cases) {
    const response = await request(`/callback?state=${flow.state}&code=synthetic-code`, { headers })
    assert.equal(response.status, 400)
    assert.match(response.headers.get('set-cookie')!, /Max-Age=0/)
  }
  assert.equal((await request('/callback?state=wrong&code=synthetic-code', { headers: { Cookie: flow.cookie } })).status, 400)
  const future = Date.now() + 601000
  t.mock.method(Date, 'now', () => future)
  assert.equal((await callback(flow)).status, 400)
  assert.equal(transport.mock.callCount(), 0)
})

test('origin removed from allowlist invalidates sealed state', async () => {
  const flow = await start()
  const response = await request(`/callback?state=${flow.state}&code=synthetic-code`, { headers: { Cookie: flow.cookie } }, { ...env, ALLOWED_ORIGINS: 'https://other.example' })
  assert.equal(response.status, 400)
})

test('mocked GitHub exchange posts secret and PKCE in form body; popup targets exactly the opener', async t => {
  const flow = await start()
  const access = 'ghu_</script><script>synthetic</script>'
  const transport = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, 'https://github.com/login/oauth/access_token')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'manual')
    assert.ok(init?.signal)
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/x-www-form-urlencoded')
    const form = new URLSearchParams(init?.body as URLSearchParams)
    assert.equal(form.get('client_secret'), env.GH_CLIENT_SECRET)
    assert.equal(form.get('client_id'), env.GH_CLIENT_ID)
    assert.equal(form.get('code'), 'synthetic-code')
    assert.equal(form.get('redirect_uri'), 'https://auth.example.com/callback')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')!))
    assert.equal(Buffer.from(digest).toString('base64url'), flow.location.searchParams.get('code_challenge'))
    return Response.json({ ...tokenData, access_token: access })
  })
  const response = await callback(flow)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.ok(!html.includes(access))
  assert.ok(!html.includes(tokenData.refresh_token))
  assert.ok(!html.includes(env.GH_CLIENT_SECRET))
  assert.equal((html.match(/<script/g) ?? []).length, 1)
  const script = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/)!
  assert.ok(script)
  assert.ok(response.headers.get('content-security-policy')!.includes(`'nonce-${script[1]}'`))
  assert.ok(response.headers.get('content-security-policy')!.includes("frame-ancestors 'none'"))
  const messages: { payload: Record<string, unknown>; target: string }[] = []
  let closed = false
  runInNewContext(script[2], { window: { opener: { postMessage: (payload: Record<string, unknown>, target: string) => messages.push({ payload, target }) }, close: () => { closed = true } } })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].target, 'https://editor.example')
  assert.equal(messages[0].payload.access_token, access)
  assert.equal(messages[0].payload.type, 'rigel:auth')
  assert.equal(messages[0].payload.nonce, 'synthetic-nonce')
  assert.equal(messages[0].payload.provider, 'github')
  assert.equal(messages[0].payload.expires_in, 28800)
  assert.ok(!('refresh_token' in messages[0].payload))
  assert.equal(closed, true)
  assert.match(cookiePair(response, '__Host-rigel-state'), /=$/)
  assert.ok(!cookiePair(response, '__Host-rigel-refresh').includes(tokenData.refresh_token))
  const replay = await request(`/callback?state=${flow.state}&code=synthetic-code`, { headers: { Cookie: cookiePair(response, '__Host-rigel-state') } })
  assert.equal(replay.status, 400)
  assert.equal(transport.mock.callCount(), 1)
})

test('provider denial and missing code clear state without transport', async t => {
  const transport = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network') })
  const flow = await start()
  const denied = await request(`/callback?state=${flow.state}&error=denied&error_description=private-detail`, { headers: { Cookie: flow.cookie } })
  assert.equal(denied.status, 200)
  const html = await denied.text()
  assert.ok(html.includes('Authorization denied'))
  assert.ok(!html.includes('private-detail'))
  assert.match(denied.headers.get('set-cookie')!, /Max-Age=0/)
  assert.equal((await request(`/callback?state=${flow.state}`, { headers: { Cookie: flow.cookie } })).status, 400)
  assert.equal(transport.mock.callCount(), 0)
})

test('mocked GitHub non-2xx, provider errors, malformed responses and network failures never leak details', async t => {
  const responses = [
    () => Response.json({ private_detail: 'private-detail' }, { status: 500 }),
    () => Response.json({ ...tokenData, error: 'private-detail' }),
    () => new Response('private-detail', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('not-json-private-detail', { headers: { 'Content-Type': 'application/json' } }),
    () => Response.json({ ...tokenData, expires_in: -1 }),
    () => Response.json({ ...tokenData, refresh_token: undefined }),
    () => Response.json({ ...tokenData, token_type: 'other' }),
    () => Response.json({ ...tokenData, access_token: '' }),
    () => Response.json({ ...tokenData, scope: 'repo' }),
    () => Response.json({ ...tokenData, refresh_token: 'x'.repeat(17000) }),
    () => { throw new Error('private-detail') },
    () => Response.json({ error: 'incorrect_client_credentials', error_description: 'private-detail' }),
    () => { throw new DOMException('private-detail', 'TimeoutError') },
  ]
  let next = responses[0]
  t.mock.method(globalThis, 'fetch', async () => next())
  for (next of responses) {
    const flow = await start()
    const response = await request(`/callback?state=${flow.state}&code=synthetic-code`, { headers: { Cookie: flow.cookie } })
    const html = await response.text()
    assert.ok(html.includes('Token exchange failed'))
    assert.ok(!html.includes('private-detail'))
    assert.ok(!html.includes(tokenData.access_token))
    assert.match(response.headers.get('set-cookie')!, /Max-Age=0/)
    assert.ok(!response.headers.getSetCookie().some(value => value.startsWith('__Host-rigel-refresh=')))
  }

})

test('refresh requires same-origin POST, CSRF header, no body and a valid refresh cookie', async t => {
  const transport = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network') })
  assert.equal((await refresh('', { Origin: 'https://editor.example' })).status, 403)
  assert.equal((await refresh('', { Origin: '' })).status, 403)
  assert.equal((await refresh('', { 'X-Rigel-CSRF': '' })).status, 403)
  assert.equal((await refresh('', { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await request('/refresh', { method: 'POST', body: '{}', headers: { Origin: 'https://auth.example.com', 'X-Rigel-CSRF': '1' } })).status, 400)
  assert.equal((await refresh('')).status, 401)
  assert.equal((await refresh('__Host-rigel-refresh=broken')).status, 401)
  assert.equal((await request('/refresh')).status, 405)
  assert.equal(transport.mock.callCount(), 0)
})

test('mocked GitHub refresh rotates sealed HttpOnly token and returns only access token', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    count++
    if (count === 2) {
      const form = new URLSearchParams(init?.body as URLSearchParams)
      assert.equal(form.get('grant_type'), 'refresh_token')
      assert.equal(form.get('refresh_token'), tokenData.refresh_token)
      assert.equal(form.get('client_secret'), env.GH_CLIENT_SECRET)
      assert.equal(form.has('code'), false)
    }
    return Response.json({ ...tokenData, ...(count === 2 ? { access_token: 'ghu_rotated', refresh_token: 'ghr_rotated' } : {}) })
  })
  const login = await callback(await start())
  const oldCookie = cookiePair(login, '__Host-rigel-refresh')
  const response = await refresh(oldCookie)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { provider: 'github', access_token: 'ghu_rotated', expires_in: 28800 })
  assert.notEqual(cookiePair(response, '__Host-rigel-refresh'), oldCookie)
  assert.ok(!response.headers.get('set-cookie')!.includes('ghr_rotated'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  const future = Date.now() + (tokenData.refresh_token_expires_in + 1) * 1000
  t.mock.method(Date, 'now', () => future)
  assert.equal((await refresh(cookiePair(response, '__Host-rigel-refresh'))).status, 401)
  assert.equal(count, 2)
})

test('mocked refresh rejection clears cookie and requires reauthentication', async t => {
  let rejected = false
  t.mock.method(globalThis, 'fetch', async () => rejected ? Response.json({ error: 'private-detail' }) : Response.json(tokenData))
  const login = await callback(await start())
  rejected = true
  const response = await refresh(cookiePair(login, '__Host-rigel-refresh'))
  assert.equal(response.status, 401)
  assert.match(response.headers.get('set-cookie')!, /Max-Age=0/)
  assert.ok(!(await response.text()).includes('private-detail'))
})

test('development HTTP exception is limited to an explicitly configured localhost gateway', async () => {
  const localEnv = { ...env, SITE_ORIGIN: 'http://localhost:8789', ALLOWED_ORIGINS: 'http://localhost:3000' }
  const response = await auth.request('http://localhost:8789/authorize?origin=http://localhost:3000', undefined, localEnv)
  assert.equal(response.status, 302)
  assert.ok(!response.headers.get('set-cookie')!.includes('Secure'))
  assert.match(response.headers.get('set-cookie')!, /^rigel-state=/)
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('redirect_uri'), 'http://localhost:8789/callback')
  assert.equal((await auth.request('https://evil.example/authorize?origin=https://editor.example', undefined, env)).status, 403)
  assert.equal((await request('/authorize?origin=https://editor.example', undefined, { ...env, SITE_ORIGIN: 'http://example.com' })).status, 503)
})
