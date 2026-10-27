import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { consentPage } from './consent-page.ts'

export type AuthBindings = {
  GH_CLIENT_ID?: string
  GH_CLIENT_SECRET?: string
  AUTH_SECRET?: string
  ALLOWED_ORIGINS?: string
  SITE_ORIGIN?: string
}

type Config = { site: string; origins: string[]; secret: string; client: string; clientSecret: string }
type State = { state: string; verifier: string; origin: string; nonce: string; exp: number }
type Refresh = { token: string; exp: number }
type Tokens = { access_token: string; expires_in: number; refresh_token: string; refresh_token_expires_in: number }
type AuthContext = Context<{ Bindings: AuthBindings; Variables: { config: Config } }>

export const auth = new Hono<{ Bindings: AuthBindings; Variables: { config: Config } }>()
const encoder = new TextEncoder()
const now = () => Math.floor(Date.now() / 1000)
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)))
const origin = (value: string) => {
  try {
    const url = new URL(value)
    return value.length <= 512 && url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost'))
  } catch { return false }
}
const cookieName = (config: Config, kind: string) => `${config.site.startsWith('https:') ? '__Host-' : ''}rigel-${kind}`
const allowedOrigin = (config: Config, value: string) => origin(value) && (!config.origins.length || config.origins.includes(value))
const cookie = (c: AuthContext, kind: string, value: string, maxAge: number) => setCookie(c, cookieName(c.get('config'), kind), value, {
  path: '/', httpOnly: true, secure: c.get('config').site.startsWith('https:'), sameSite: 'Lax', maxAge,
})

async function seal(config: Config, kind: string, value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(config.secret)), 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${config.site}:${kind}`) }, key, encoder.encode(JSON.stringify(value)))
  return `${base64(iv)}.${base64(new Uint8Array(encrypted))}`
}

async function unseal(config: Config, kind: string, value?: string): Promise<Record<string, unknown> | null> {
  try {
    if (!value || value.length > 3800 || !/^[\w-]+\.[\w-]+$/.test(value)) return null
    const decode = (part: string) => Uint8Array.from(atob(part.replaceAll('-', '+').replaceAll('_', '/')), ch => ch.charCodeAt(0))
    const [iv, encrypted] = value.split('.').map(decode)
    if (iv.length !== 12) return null
    const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(config.secret)), 'AES-GCM', false, ['decrypt'])
    const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${config.site}:${kind}`) }, key, encrypted)
    const data = JSON.parse(new TextDecoder().decode(decoded))
    return data && typeof data === 'object' && Number.isInteger(data.exp) && data.exp > now() ? data : null
  } catch { return null }
}

async function exchange(c: AuthContext, fields: Record<string, string>): Promise<Tokens | null> {
  const config = c.get('config')
  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.client, client_secret: config.clientSecret, ...fields }),
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel()
      return null
    }
    const reader = response.body?.getReader()
    if (!reader) return null
    let text = ''
    let size = 0
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16_384) { await reader.cancel(); return null }
      text += decoder.decode(value, { stream: true })
    }
    let data
    try { data = JSON.parse(text + decoder.decode()) } catch { return null }
    const token = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/\s/.test(value)
    const lifetime = (value: unknown, max: number) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max
    if (!data || typeof data !== 'object' || 'error' in data || data.token_type !== 'bearer' || data.scope !== '' ||
      !token(data.access_token) || !token(data.refresh_token) || !lifetime(data.expires_in, 86400) || !lifetime(data.refresh_token_expires_in, 31_622_400)) return null
    return data
  } catch { return null }
}

async function saveRefresh(c: AuthContext, tokens: Tokens) {
  const refresh: Refresh = { token: tokens.refresh_token, exp: now() + tokens.refresh_token_expires_in }
  cookie(c, 'refresh', await seal(c.get('config'), 'refresh', refresh), tokens.refresh_token_expires_in)
}

function popup(c: AuthContext, state: State, payload: Record<string, unknown>) {
  const nonce = random()
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Rigel authentication</title><body><p>Authentication finished. You can close this window.</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${json({ type: 'rigel:auth', provider: 'github', nonce: state.nonce, ...payload })},${json(state.origin)});window.close()}</script></body></html>`)
}

auth.use('*', async (c, next) => {
  harden(c)
  const method = c.req.path === '/authorize' ? 'GET, POST' : c.req.path === '/refresh' ? 'POST' : c.req.path === '/callback' ? 'GET' : null
  if (!method) return next()
  if (!method.split(', ').includes(c.req.method)) {
    c.header('Allow', method)
    return c.json({ error: 'Method not allowed' }, 405)
  }
  return protect(c, next)
})

export function harden(c: Context) {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Robots-Tag', 'noindex, nofollow')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Cross-Origin-Opener-Policy', 'unsafe-none')
  c.header('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
}

async function protect(c: AuthContext, next: () => Promise<void>) {
  const env = c.env ?? {}
  const site = env.SITE_ORIGIN ?? ''
  const origins = env.ALLOWED_ORIGINS?.trim() ? env.ALLOWED_ORIGINS.split(',').map(value => value.trim()) : []
  if (!env.GH_CLIENT_ID || !env.GH_CLIENT_SECRET || !env.AUTH_SECRET || env.AUTH_SECRET.length < 32 || !origin(site) || origins.some(value => !origin(value))) return c.json({ error: 'Authentication unavailable' }, 503)
  if (new URL(c.req.url).origin !== site) return c.json({ error: 'Untrusted gateway origin' }, 403)
  c.set('config', { site, origins, secret: env.AUTH_SECRET, client: env.GH_CLIENT_ID, clientSecret: env.GH_CLIENT_SECRET })
  await next()
}

async function authorize(c: AuthContext, target: string, nonce: string, status: 302 | 303) {
  const config = c.get('config')
  const state: State = { state: random(), verifier: random(), origin: target, nonce, exp: now() + 600 }
  cookie(c, 'state', await seal(config, 'state', state), 600)
  const challenge = base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(state.verifier))))
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({ client_id: config.client, redirect_uri: `${config.site}/callback`, state: state.state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'offline_access' }).toString()
  return c.redirect(url.toString(), status)
}

auth.get('/authorize', async c => {
  const config = c.get('config')
  const target = c.req.query('origin') ?? ''
  if (!allowedOrigin(config, target)) return c.json({ error: 'Untrusted opener origin' }, 403)
  const nonce = c.req.query('nonce') ?? ''
  if (nonce.length > 128 || (nonce && !/^[\w-]+$/.test(nonce)) || (!config.origins.length && nonce.length < 32)) return c.json({ error: 'Invalid nonce' }, 400)
  if (config.origins.length) return authorize(c, target, nonce, 302)
  const csrf = random()
  cookie(c, 'consent', await seal(config, 'consent', { origin: target, nonce, csrf, exp: now() + 600 }), 600)
  c.header('Referrer-Policy', 'same-origin')
  const styleNonce = random()
  c.header('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${styleNonce}'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com`)
  return c.html(consentPage(target, csrf, styleNonce))
})

auth.post('/authorize', bodyLimit({ maxSize: 1024, onError: c => c.json({ error: 'Request too large' }, 413) }), async c => {
  const config = c.get('config')
  if (c.req.header('Origin') !== config.site || (c.req.header('Sec-Fetch-Site') && c.req.header('Sec-Fetch-Site') !== 'same-origin')) return c.json({ error: 'Same-origin request required' }, 403)
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return c.json({ error: 'Form required' }, 415)
  const data = await unseal(config, 'consent', getCookie(c, cookieName(config, 'consent')))
  const form = new URLSearchParams(await c.req.text())
  if (!data || typeof data.csrf !== 'string' || form.getAll('csrf').length !== 1 || data.csrf !== form.get('csrf') || typeof data.origin !== 'string' || !allowedOrigin(config, data.origin) || typeof data.nonce !== 'string') return c.json({ error: 'Invalid or expired confirmation' }, 400)
  cookie(c, 'consent', '', 0)
  return authorize(c, data.origin, data.nonce, 303)
})

auth.get('/callback', async c => {
  const config = c.get('config')
  const sealed = getCookie(c, cookieName(config, 'state'))
  cookie(c, 'state', '', 0)
  const data = await unseal(config, 'state', sealed)
  if (!data || typeof data.state !== 'string' || data.state !== c.req.query('state') || typeof data.verifier !== 'string' || typeof data.origin !== 'string' || !allowedOrigin(config, data.origin) || typeof data.nonce !== 'string') return c.json({ error: 'Invalid or expired authorization state' }, 400)
  const state = data as State
  if (c.req.query('error')) return popup(c, state, { error: 'Authorization denied' })
  const code = c.req.query('code')
  if (!code || code.length > 1024) return c.json({ error: 'Invalid authorization code' }, 400)
  const tokens = await exchange(c, { code, code_verifier: state.verifier, redirect_uri: `${config.site}/callback` })
  if (!tokens) return popup(c, state, { error: 'Token exchange failed' })
  await saveRefresh(c, tokens)
  return popup(c, state, { access_token: tokens.access_token, expires_in: tokens.expires_in })
})

auth.post('/refresh', async c => {
  const config = c.get('config')
  if (c.req.header('Origin') !== config.site || c.req.header('X-Rigel-CSRF') !== '1' || (c.req.header('Sec-Fetch-Site') && c.req.header('Sec-Fetch-Site') !== 'same-origin')) return c.json({ error: 'Same-origin request required' }, 403)
  if (c.req.raw.body !== null) return c.json({ error: 'Request body not permitted' }, 400)
  const refresh = await unseal(config, 'refresh', getCookie(c, cookieName(config, 'refresh')))
  if (!refresh || typeof refresh.token !== 'string') return c.json({ error: 'Reauthentication required' }, 401)
  cookie(c, 'refresh', '', 0)
  const tokens = await exchange(c, { grant_type: 'refresh_token', refresh_token: refresh.token })
  if (!tokens) return c.json({ error: 'Reauthentication required' }, 401)
  await saveRefresh(c, tokens)
  return c.json({ provider: 'github', access_token: tokens.access_token, expires_in: tokens.expires_in })
})

auth.onError((_error, c) => {
  return c.json({ error: 'Authentication unavailable' }, 503)
})

export default auth
