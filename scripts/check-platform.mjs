import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const [base, editor] = process.argv.slice(2)
for (const value of [base, editor]) {
  const url = new URL(value)
  assert.equal(url.origin, value, 'Pass exact origins without paths or trailing slashes')
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost'))
}
const request = (path, init = {}) => fetch(base + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
for (const [path, init, expected] of [
  ['/health', {}, 200],
  ['/not-a-route', {}, 404],
  ['/authorize', { method: 'HEAD' }, 405],
  ['/authorize', { method: 'OPTIONS' }, 405],
  [`/authorize?${new URLSearchParams({ origin: editor, nonce: 'invalid!' })}`, {}, 400],
  ['/callback?state=invalid&code=invalid', {}, 400],
  ['/refresh', { method: 'POST', headers: { Origin: 'https://untrusted.example.invalid', 'X-Rigel-CSRF': '1' } }, 403],
]) {
  const response = await request(path, init)
  assert.equal(response.status, expected, `${init.method ?? 'GET'} ${path}`)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  await response.body?.cancel()
}
let authorization = await request(`/authorize?${new URLSearchParams({ origin: editor, nonce: randomUUID() })}`)
let expectedRedirect = 302
if (authorization.status === 200) {
  expectedRedirect = 303
  const consentCookies = authorization.headers.getSetCookie()
  const html = await authorization.text()
  const csrf = html.match(/name="csrf" value="([\w-]+)"/)?.[1]
  assert.ok(csrf, 'Public mode must render a confirmation form')
  authorization = await request('/authorize', {
    method: 'POST',
    headers: { Origin: base, Cookie: consentCookies.map(value => value.split(';')[0]).join('; '), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
  })
}
assert.equal(authorization.status, expectedRedirect, 'Configure the gateway and allow the supplied editor origin')
assert.equal(authorization.headers.get('cache-control'), 'no-store')
assert.equal(authorization.headers.get('cross-origin-opener-policy'), 'unsafe-none')
const github = new URL(authorization.headers.get('location'))
assert.equal(github.origin, 'https://github.com')
assert.equal(github.pathname, '/login/oauth/authorize')
assert.equal(github.searchParams.get('redirect_uri'), base + '/callback')
assert.equal(github.searchParams.get('code_challenge_method'), 'S256')
assert.ok(github.searchParams.get('client_id') && github.searchParams.get('state') && github.searchParams.get('code_challenge'))
const cookies = authorization.headers.getSetCookie()
assert.equal(cookies.length, expectedRedirect === 303 ? 2 : 1, 'The platform must preserve separate Set-Cookie headers')
assert.ok(cookies.some(value => value.startsWith(`${base.startsWith('https:') ? '__Host-' : ''}rigel-state=`)))
assert.ok(cookies.every(value => value.includes('HttpOnly') && value.includes('SameSite=Lax') && value.includes('Path=/')))
if (base.startsWith('https:')) assert.ok(cookies.every(value => value.includes('Secure')))
assert.ok(!authorization.headers.get('location').includes('access_token='))
await authorization.body?.cancel()
console.log('PASS: health, routing, method guards, hardened failures, destination confirmation/allowlist, PKCE redirect and separate cookies. No GitHub requests or real token exchange performed.')
