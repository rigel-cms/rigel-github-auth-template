import { Hono } from 'hono'
import { handleRequest } from './node.ts'

const app = new Hono()
app.all('*', c => handleRequest(c.req.raw))
export default app
