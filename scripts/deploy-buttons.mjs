import assert from 'node:assert/strict'

const repository = process.argv[2]
const source = new URL(repository)
assert.ok(source.origin === 'https://github.com' && source.href === repository && /^\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(source.pathname) && !source.username && !source.password && !source.search && !source.hash, 'Pass the exact HTTPS URL of your published GitHub repository')

for (const [name, endpoint, parameter, image] of [
  ['Cloudflare', 'https://deploy.workers.cloudflare.com/', 'url', 'https://deploy.workers.cloudflare.com/button'],
  ['Netlify', 'https://app.netlify.com/start/deploy', 'repository', 'https://www.netlify.com/img/deploy/button.svg'],
  ['Vercel', 'https://vercel.com/new/clone', 'repository-url', 'https://vercel.com/button'],
]) {
  const target = new URL(endpoint)
  target.searchParams.set(parameter, repository)
  if (name === 'Vercel') {
    target.searchParams.set('env', 'GH_CLIENT_ID,GH_CLIENT_SECRET,AUTH_SECRET,SITE_ORIGIN')
    target.searchParams.set('envDescription', 'Create your own GitHub App and configure its callback before signing in.')
    target.searchParams.set('envLink', repository + '#register-your-github-app')
  }
  console.log(`[![Deploy to ${name}](${image})](${target})`)
}
