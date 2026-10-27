import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { unstable_dev } from 'wrangler'

test('workerd supports sign-in and refresh while rejecting upstream redirects', async () => {
  const directory = new URL('../_temp/auth-runtime/', import.meta.url)
  await mkdir(directory, { recursive: true })
  await writeFile(new URL('wrangler.json', directory), JSON.stringify({ name: 'rigel-auth-runtime-test', compatibility_date: '2026-10-22', observability: { enabled: false } }))
  await writeFile(new URL('worker.ts', directory), `
import app from '../../cloudflare/index.ts'
export default {
  async fetch(request, env, ctx) {
    globalThis.fetch = async (url, init) => {
      const upstream = new Request(url, init)
      if (upstream.redirect !== 'manual') throw new Error('Exchange must not follow redirects')
      const form = new URLSearchParams(init.body)
      if (form.get('code') === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example' } })
      return Response.json({ access_token: 'ghu_runtime-access', refresh_token: 'ghr_runtime-refresh', token_type: 'bearer', scope: '', expires_in: 28800, refresh_token_expires_in: 15897600 })
    }
    const url = new URL(request.url)
    return app.fetch(new Request('https://auth.example' + url.pathname + url.search, { method: request.method, headers: request.headers }), {
      GH_CLIENT_ID: 'runtime-client', GH_CLIENT_SECRET: 'runtime-secret',
      AUTH_SECRET: 'runtime-sealing-secret-at-least-32-characters',
      SITE_ORIGIN: 'https://auth.example', ALLOWED_ORIGINS: 'https://editor.example',
    }, ctx)
  },
}
`)
  const worker = await unstable_dev(new URL('worker.ts', directory).pathname, {
    config: new URL('wrangler.json', directory).pathname, local: true, logLevel: 'error',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  })
  const cookie = (response: { headers: { getSetCookie(): string[] } }, name: string) => {
    const value = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))
    assert.ok(value, name)
    return value.split(';')[0]!
  }
  try {
    for (const code of ['success', 'redirect']) {
      const start = await worker.fetch('/authorize?origin=https://editor.example&nonce=runtime-nonce', { redirect: 'manual' })
      assert.equal(start.status, 302)
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!
      const response = await worker.fetch(`/callback?state=${state}&code=${code}`, {
        headers: { Cookie: cookie(start, '__Host-rigel-state') },
      })
      const html = await response.text()
      assert.equal(response.status, 200)
      if (code === 'redirect') {
        assert.ok(html.includes('Token exchange failed'))
        assert.ok(!html.includes('ghu_runtime-access'))
        assert.ok(!response.headers.getSetCookie().some(value => value.startsWith('__Host-rigel-refresh=')))
      } else {
        assert.ok(html.includes('ghu_runtime-access'))
        const refreshed = await worker.fetch('/refresh', {
          method: 'POST', headers: { Cookie: cookie(response, '__Host-rigel-refresh'), Origin: 'https://auth.example', 'X-Rigel-CSRF': '1' },
        })
        assert.equal(refreshed.status, 200)
        assert.equal((await refreshed.json() as { access_token: string }).access_token, 'ghu_runtime-access')
      }
    }
  } finally { await worker.stop() }
})
