import { Hono } from 'hono'
import { auth, harden } from './auth.ts'
import type { AuthBindings } from './auth.ts'

const app = new Hono<{ Bindings: AuthBindings }>()
app.use('*', async (c, next) => {
  harden(c)
  if (c.req.path === '/health' && c.req.method !== 'GET') {
    c.header('Allow', 'GET')
    return c.json({ error: 'Method not allowed' }, 405)
  }
  await next()
})
app.get('/health', c => c.json({ status: 'ok', service: 'Rigel CMS Authenticator' }))
app.route('/', auth)
app.notFound(c => c.json({ error: 'Not found' }, 404))
app.onError((_error, c) => {
  harden(c)
  return c.json({ error: 'Authentication unavailable' }, 503)
})
export default app
