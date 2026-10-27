import app from './gateway.ts'

export function handleRequest(request: Request) {
  return app.fetch(request, {
    GH_CLIENT_ID: process.env.GH_CLIENT_ID,
    GH_CLIENT_SECRET: process.env.GH_CLIENT_SECRET,
    AUTH_SECRET: process.env.AUTH_SECRET,
    SITE_ORIGIN: process.env.SITE_ORIGIN,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  })
}
