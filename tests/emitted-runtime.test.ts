import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

test('emitted JavaScript loads the complete gateway without TypeScript source imports', async () => {
  mkdirSync('_temp', { recursive: true })
  const output = mkdtempSync('_temp/emitted-runtime-')
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json', '--noEmit', 'false', '--outDir', output], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const { default: app } = await import(pathToFileURL(resolve(output, 'src/index.js')).href)
  const response = await app.fetch(new Request('https://gateway.example.com/health'))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).status, 'ok')
  assert.equal(response.headers.get('cache-control'), 'no-store')
})
