#!/usr/bin/env node
// init.mjs — turn a fresh copy of the template into a named Cube.
//
//   node scripts/init.mjs <name> --title-en "Google Ads" --title-de "Google Ads" [--vendor revenexx]
//
// Rewrites the identity in cube.json, package.json, catalog-info.yaml,
// mkdocs.yml, README.md, CLAUDE.md, CHANGELOG.md and docs/index.md, and deletes
// itself. The example dataset, metric, report and dashboard stay: replace them
// with the Cube's own, then run `npm run validate`.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const name = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const vendor = opt('vendor', 'revenexx')
const titleEn = opt('title-en')
const titleDe = opt('title-de', titleEn)

if (!name || !titleEn) {
  console.error('usage: init.mjs <name> --title-en "<English title>" [--title-de "<deutscher Titel>"] [--vendor <vendor>]')
  process.exit(2)
}
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || name.length < 2 || name.length > 40) {
  console.error(`✗ '${name}': lowercase letters, digits and single hyphens, 2–40 characters`)
  process.exit(2)
}

const rw = (file, fn) => {
  const abs = join(root, file)
  if (existsSync(abs)) writeFileSync(abs, fn(readFileSync(abs, 'utf8')))
}
const text = (s) => s
  .replaceAll('revenexx-cubes/template', `revenexx-cubes/${name}`)
  .replaceAll('cube-template', `cube-${name}`)
  .replaceAll('revenexx/template', `${vendor}/${name}`)
  .replaceAll('Template Cube', titleEn)
  .replaceAll('Vorlage-Cube', titleDe)
  .replaceAll('# template', `# ${name}`)

const cube = JSON.parse(readFileSync(join(root, 'cube.json'), 'utf8'))
Object.assign(cube, { name, vendor, version: '0.1.0', title: { en: titleEn, de: titleDe } })
cube.tags = (cube.tags || []).filter((t) => t !== 'template')
writeFileSync(join(root, 'cube.json'), JSON.stringify(cube, null, 2) + '\n')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
Object.assign(pkg, { name: `@revenexx-cubes/${name}`, version: '0.1.0', description: `revenexx Cube ${vendor}/${name}.` })
writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

for (const f of ['catalog-info.yaml', 'mkdocs.yml', 'README.md', 'CLAUDE.md', 'docs/index.md', 'billing.json']) rw(f, text)
rw('CHANGELOG.md', (s) => s.replace(/## \[0\.1\.0\][\s\S]*$/, `## [0.1.0] — unreleased\n\n### Added\n\n- First version of ${vendor}/${name}.\n`))

unlinkSync(fileURLToPath(import.meta.url))
console.error(`✓ ${vendor}/${name}: identity written. Replace the example dataset, metric, report and dashboard, then: npm install && npm run validate`)
