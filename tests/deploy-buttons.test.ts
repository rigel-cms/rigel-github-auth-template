import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const script = new URL('../scripts/deploy-buttons.mjs', import.meta.url)

test('README embeds deploy buttons for the published template', () => {
  const result = spawnSync(process.execPath, [script.pathname, 'https://github.com/rigel-cms/rigel-github-auth-template'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const [index, button] of result.stdout.trim().split('\n').entries()) {
    const heading = ['Cloudflare Workers', 'Netlify Functions', 'Vercel'][index]
    const section = readme.split(`### ${heading}\n`)[1]?.split(/\n#{2,3} /)[0]
    assert.ok(section?.includes(button), 'Each deploy button must be in its provider section')
  }
  assert.ok(!readme.split('### Cloudflare Workers')[0].includes('[![Deploy to '))
  assert.doesNotMatch(readme, /YOUR_PUBLIC_REPOSITORY_URL|After publishing your GitHub repository/)
})

test('deploy buttons preserve the supplied repository and prompt only for variable names', () => {
  const repository = 'https://github.com/example/auth-template'
  const result = spawnSync(process.execPath, [script.pathname, repository], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const links = [...result.stdout.matchAll(/\]\((https:\/\/[^()\n]+)\)$/gm)].map(match => new URL(match[1]))
  assert.equal(links.length, 3)
  for (const [index, key] of ['url', 'repository', 'repository-url'].entries()) assert.equal(links[index].searchParams.get(key), repository)
  assert.equal(links[2].searchParams.get('env'), 'GH_CLIENT_ID,GH_CLIENT_SECRET,AUTH_SECRET,SITE_ORIGIN')
  for (const invalid of ['https://example.com/owner/repo', repository + '?secret=fixture', 'https://fixture@github.com/example/auth-template']) {
    const rejected = spawnSync(process.execPath, [script.pathname, invalid], { encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.equal(rejected.stdout, '')
  }
})
