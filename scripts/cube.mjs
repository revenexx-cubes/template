#!/usr/bin/env node
// cube.mjs — validate a revenexx Cube and build its release bundle.
//
// One file, copied verbatim into every Cube repo as scripts/cube.mjs. The
// canonical copy is revenexx-cubes/skills/validate-cube/scripts/cube.mjs; a
// repo copy that differs from it is drift (`node scripts/cube.mjs version`
// prints the hash to compare).
//
//   node scripts/cube.mjs validate [dir] [--online] [--catalog <file>] [--json]
//   node scripts/cube.mjs bundle   [dir] [--out <file>] [--repo <owner/name>]
//                                        [--commit <sha>] [--allow-dirty] [--catalog <file>]
//   node scripts/cube.mjs version
//
// `validate` runs the checks the analytics-api registry runs on
// POST /api/v1/analytics/cubes/releases (schema, data files, functions →
// datasets, no SQL, name not an app name) plus the reference checks the
// catalog would otherwise only report after install. Problems are printed in
// the registry's shape: {document, path, message}.
//
// `bundle` validates first and writes the release body
// {files: {...}, source: {repo, commit}} to stdout or --out.
//
// Schemas are read from ./schemas (vendored, works offline). --online fetches
// https://schemas.revenexx.com/<file> instead and reports drift from the
// vendored copy.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)

const DOCS = ['cube', 'analytics', 'metrics', 'reports', 'dashboards', 'billing']
const REQUIRED_DOCS = ['cube', 'billing']

// Installed-app names a Cube may not take (the registry rejects a release whose
// name equals a known app). Snapshot of the revenexx-apps org; --apps-dir reads
// the live list from a local apps workspace instead.
const KNOWN_APPS = [
  'ads', 'audiences', 'campaigns', 'carts', 'channels', 'consent-manager', 'cost-centers',
  'customers', 'documents', 'forms', 'inventories', 'journeys', 'loyalty', 'mailings',
  'marketing-consents', 'markets', 'orderlists', 'orders', 'pages', 'payments', 'prices',
  'procurement', 'products', 'promotions', 'punchout', 'quotes', 'reviews', 'sales-reps',
  'sample-data-simulator', 'shipping', 'tag-manager'
]

// Keys whose values are prose for people, never code. Everything else is
// scanned for SQL.
const TEXT_KEYS = new Set([
  'title', 'description', 'label', 'hint', 'body', 'reason', 'captions', 'vocabulary',
  'longDescription', 'highlights', 'notes', 'purpose', 'tags', 'categories', 'listing', 'support', 'legal'
])
const SQL = /\b(select\s+[\w*.,\s()]+\s+from\s+\w|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+(table|view|schema)|create\s+(table|view|function|schema)|alter\s+table|truncate\s+table|grant\s+\w+\s+on|union\s+select)\b|;\s*--|\bpg_\w+\(/i

const PKG = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*'
const KEY = '[a-z][a-z0-9_]*'
const FORMULA_TOKEN = new RegExp(`(?:(${PKG})\\.)?(${KEY})`, 'g')
const EXPR_TOKEN = new RegExp(KEY, 'g')

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const [command = 'validate', ...rest] = argv
  const opts = { dir: '.', flags: {} }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      const boolean = ['online', 'json', 'allow-dirty'].includes(name)
      opts.flags[name] = boolean ? true : rest[++i]
    } else {
      opts.dir = a
    }
  }
  return { command, ...opts }
}

// ---------------------------------------------------------------- schemas
async function loadSchemas(root, online) {
  const local = {}
  const out = {}
  const notes = []
  for (const doc of DOCS) {
    const file = `${doc}.schema.json`
    const vendored = join(root, 'schemas', file)
    if (existsSync(vendored)) local[doc] = JSON.parse(readFileSync(vendored, 'utf8'))
    if (online) {
      const res = await fetch(`https://schemas.revenexx.com/${file}`)
      if (!res.ok) throw new Error(`fetching ${file}: HTTP ${res.status}`)
      out[doc] = await res.json()
      if (local[doc] && JSON.stringify(local[doc]) !== JSON.stringify(out[doc])) {
        notes.push(`schemas/${file} differs from the live schema — refresh the vendored copy`)
      }
    } else {
      if (!local[doc]) throw new Error(`missing schemas/${file} (vendor it, or run with --online)`)
      out[doc] = local[doc]
    }
  }
  return { schemas: out, notes }
}

function compile(schemas) {
  const Ajv2020 = require('ajv/dist/2020').default
  const addFormats = require('ajv-formats').default ?? require('ajv-formats')
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats(ajv)
  const v = {}
  for (const [doc, schema] of Object.entries(schemas)) v[doc] = ajv.compile(schema)
  return v
}

// ---------------------------------------------------------------- helpers
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

const TYPE_CHECKS = {
  text: () => true,
  'text[]': (v) => /^\{.*\}$/.test(v),
  int: (v) => /^-?\d+$/.test(v) && Math.abs(Number(v)) <= 2147483647,
  bigint: (v) => /^-?\d+$/.test(v),
  numeric: (v) => /^-?\d+(\.\d+)?$/.test(v),
  bool: (v) => v === 'true' || v === 'false',
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
  timestamptz: (v) => !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  jsonb: (v) => { try { JSON.parse(v); return true } catch { return false } }
}

// Minimal semver range check: ^, ~, exact, x-ranges, >=. Enough for requires.
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? m.slice(1, 4).map(Number) : null
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
export function satisfies(version, range) {
  const v = parseVersion(version)
  if (!v) return false
  return range.split('||').some((alt) => alt.trim().split(/\s+/).every((part) => {
    const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(part)
    if (!m) return false
    const [, op = '', ...raw] = m
    const nums = raw.map((n) => (n === undefined || n === 'x' || n === '*' ? null : Number(n)))
    const base = nums.map((n) => n ?? 0)
    const given = nums.filter((n) => n !== null).length
    if (op === '>=') return cmp(v, base) >= 0
    if (op === '>') return cmp(v, base) > 0
    if (op === '<=') return cmp(v, base) <= 0
    if (op === '<') return cmp(v, base) < 0
    let upper
    if (op === '^') {
      if (base[0] > 0 || given === 1) upper = [base[0] + 1, 0, 0]
      else if (base[1] > 0 || given === 2) upper = [0, base[1] + 1, 0]
      else upper = [0, 0, base[2] + 1]
    } else if (op === '~') {
      upper = given === 1 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0]
    } else {
      if (given === 3) return cmp(v, base) === 0
      upper = given === 1 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0]
    }
    return cmp(v, base) >= 0 && cmp(v, upper) < 0
  }))
}

// ---------------------------------------------------------------- validation
export async function validate(dir, flags = {}) {
  const root = resolve(dir)
  const problems = []
  const warnings = []
  const p = (document, path, message) => problems.push({ document, path, message })
  const w = (document, path, message) => warnings.push({ document, path, message })

  const schemaRoot = existsSync(join(root, 'schemas')) ? root : dirname(dirname(SELF))
  const { schemas, notes } = await loadSchemas(schemaRoot, Boolean(flags.online))
  notes.forEach((n) => w('schemas', '', n))
  const validators = compile(schemas)

  // 1. Documents present, parseable, valid against their schema.
  const docs = {}
  for (const doc of DOCS) {
    const file = join(root, `${doc}.json`)
    if (!existsSync(file)) {
      if (REQUIRED_DOCS.includes(doc)) p(`${doc}.json`, '', 'missing')
      continue
    }
    try {
      docs[doc] = readJson(file)
    } catch (e) {
      p(`${doc}.json`, '', `not valid JSON: ${e.message}`)
      continue
    }
    if (!validators[doc](docs[doc])) {
      for (const e of validators[doc].errors) p(`${doc}.json`, e.instancePath || '/', `${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`)
    }
  }
  const cube = docs.cube
  if (!cube) return { root, problems, warnings, docs }

  const self = cube.name
  const requires = cube.requires || {}
  const required = new Set(Object.keys(requires))
  const datasets = new Map((docs.analytics?.datasets || []).map((d) => [d.name, d]))
  const fileCatalog = flags.catalog ? readJson(resolve(flags.catalog)) : null
  const catalog = fileCatalog?.packages || null

  // 2. Identity.
  const appNames = flags['apps-dir'] && existsSync(flags['apps-dir'])
    ? KNOWN_APPS.concat(listApps(flags['apps-dir']))
    : KNOWN_APPS
  if (appNames.includes(self)) p('cube.json', '/name', `'${self}' is an app name; the registry rejects a Cube with it`)
  if (required.has(self)) p('cube.json', '/requires', 'a Cube cannot require itself')
  const pkgJson = existsSync(join(root, 'package.json')) ? readJson(join(root, 'package.json')) : null
  if (pkgJson?.version && pkgJson.version !== cube.version) w('package.json', '/version', `package.json says ${pkgJson.version}, cube.json says ${cube.version}`)
  const changelog = existsSync(join(root, 'CHANGELOG.md')) ? readFileSync(join(root, 'CHANGELOG.md'), 'utf8') : null
  if (changelog === null) p('CHANGELOG.md', '', 'missing')
  else if (!changelog.includes(`## [${cube.version}]`)) p('CHANGELOG.md', '', `no entry '## [${cube.version}]' for the version in cube.json`)

  // 3. Requires against the catalog snapshot (versions).
  if (catalog) {
    for (const [name, range] of Object.entries(requires)) {
      const pkg = catalog[name]
      if (!pkg) w('cube.json', `/requires/${name}`, `'${name}' is not in the catalog snapshot`)
      else if (pkg.version && !satisfies(pkg.version, range)) p('cube.json', `/requires/${name}`, `${name} ${pkg.version} does not satisfy '${range}'`)
    }
  }

  // 4. Data: cube.data ↔ file datasets, files on disk, rows against columns.
  const dataFiles = new Map()
  for (const [i, entry] of (cube.data || []).entries()) {
    const ds = datasets.get(entry.dataset)
    if (!ds) p('cube.json', `/data/${i}`, `dataset '${entry.dataset}' is not in analytics.json`)
    else if (ds.source?.file !== entry.file) p('cube.json', `/data/${i}`, `dataset '${entry.dataset}' does not have source.file '${entry.file}'`)
    if (dataFiles.has(entry.file)) p('cube.json', `/data/${i}`, `file '${entry.file}' listed twice`)
    dataFiles.set(entry.file, entry.dataset)
    const abs = join(root, entry.file)
    if (!existsSync(abs)) { p('cube.json', `/data/${i}`, `file '${entry.file}' is missing`); continue }
    if (entry.file.endsWith('.parquet')) { p('cube.json', `/data/${i}`, 'the release body carries CSV text only; ship CSV'); continue }
    if (ds) checkCsv(readFileSync(abs, 'utf8'), ds, entry.file, p)
  }
  const functions = new Map((cube.functions || []).map((f) => [f.key, f]))
  const connections = new Map((cube.connections || []).map((c) => [c.key, c]))
  for (const [i, f] of (cube.functions || []).entries()) {
    const ds = datasets.get(f.dataset)
    if (!ds) p('cube.json', `/functions/${i}`, `dataset '${f.dataset}' is not in analytics.json`)
    else if (ds.source?.function !== f.key) p('cube.json', `/functions/${i}`, `dataset '${f.dataset}' does not take its rows from function '${f.key}'`)
    else if (ds.scope === 'shared') w('cube.json', `/functions/${i}`, 'a function filling a shared dataset runs once for everyone, without a tenant connection')
    const file = join(root, 'functions', f.key)
    if (!existsSync(file) && !existsSync(`${file}.js`) && !existsSync(`${file}.mjs`)) w('cube.json', `/functions/${i}`, `no source found at functions/${f.key}(.js|.mjs|/)`)
  }
  if ((docs.analytics?.views || []).length) p('analytics.json', '/views', 'a Cube has no entities; declare datasets, not views')
  for (const [name, ds] of datasets) {
    const at = `/datasets/${[...datasets.keys()].indexOf(name)}`
    const src = ds.source || {}
    if (src.file && !dataFiles.has(src.file)) p('analytics.json', `${at}/source`, `file '${src.file}' is not listed in cube.json data[]`)
    if (src.function && !functions.has(src.function)) p('analytics.json', `${at}/source`, `function '${src.function}' is not declared in cube.json functions[]`)
    if (src.connection && !connections.has(src.connection)) w('analytics.json', `${at}/source`, `connection '${src.connection}' is not declared in cube.json; it must be one the tenant set up itself`)
    if (src.query !== undefined) p('analytics.json', `${at}/source/query`, 'a Cube never ships SQL; read a table or an endpoint')
    const cols = new Set(ds.columns.map((c) => c.name))
    if (cols.size !== ds.columns.length) p('analytics.json', `${at}/columns`, 'duplicate column name')
    const roles = ds.roles || {}
    for (const r of [roles.time, roles.entity, ...(roles.measures || []), ...(roles.dimensions || [])].filter(Boolean)) {
      if (!cols.has(r)) p('analytics.json', `${at}/roles`, `role names unknown column '${r}'`)
    }
    if (ds.scope === 'tenant' && cols.has('tenant_id')) p('analytics.json', `${at}/columns`, 'tenant_id is added by the platform; do not declare it')
  }

  // 5. No SQL anywhere a value could be executed.
  for (const [doc, value] of Object.entries(docs)) scanSql(value, `${doc}.json`, '', p)

  // 6. metrics.json against the datasets, then formulas.
  const ownMetrics = new Map((docs.metrics?.metrics || []).map((m) => [m.key, m]))
  const ownDims = new Map((docs.metrics?.dimensions || []).map((d) => [d.key, d]))
  const ownReports = new Map((docs.reports?.reports || []).map((r) => [r.key, r]))
  const own = (ref) => !ref.includes('.') || ref.startsWith(`${self}.`)
  const local = (ref) => (ref.startsWith(`${self}.`) ? ref.slice(self.length + 1) : ref)
  const pkgOf = (ref) => (own(ref) ? self : ref.slice(0, ref.lastIndexOf('.')))

  const checkForeign = (doc, path, ref, kind) => {
    const pkg = pkgOf(ref)
    if (!required.has(pkg)) { p(doc, path, `'${ref}' names '${pkg}', which cube.json does not require`); return }
    if (!catalog) return
    const entry = catalog[pkg]
    if (!entry) return
    const key = ref.slice(pkg.length + 1)
    const list = kind === 'report' ? (entry.reports || []).map((r) => r.key) : entry[kind === 'metric' ? 'metrics' : 'dimensions'] || []
    if (!list.includes(key)) p(doc, path, `${kind} '${ref}' does not exist in ${pkg} ${entry.version || ''}`.trim())
  }
  const metricRef = (doc, path, ref) => {
    if (typeof ref !== 'string') return
    if (own(ref)) { if (!ownMetrics.has(local(ref))) p(doc, path, `unknown metric '${ref}'`) }
    else checkForeign(doc, path, ref, 'metric')
  }
  const dimensionRef = (doc, path, ref) => {
    if (typeof ref !== 'string') return
    if (own(ref)) { if (!ownDims.has(local(ref))) p(doc, path, `unknown dimension '${ref}'`) }
    else checkForeign(doc, path, ref, 'dimension')
  }

  for (const [i, d] of (docs.metrics?.dimensions || []).entries()) {
    const at = `/dimensions/${i}`
    if (d.view) { p('metrics.json', at, 'a Cube has no views; use dataset'); continue }
    const ds = datasets.get(d.dataset)
    if (!ds) { p('metrics.json', at, `unknown dataset '${d.dataset}'`); continue }
    if (!ds.columns.some((c) => c.name === d.column)) p('metrics.json', `${at}/column`, `dataset '${d.dataset}' has no column '${d.column}'`)
    if (d.joins) checkForeign('metrics.json', `${at}/joins`, d.joins, 'dimension')
    if (d.lookup && !required.has(d.lookup.split('.')[0])) p('metrics.json', `${at}/lookup`, `'${d.lookup}' names a package cube.json does not require`)
    if (d.joins && ds.mode === 'live') p('metrics.json', `${at}/joins`, 'a live dataset cannot be joined with app data')
  }
  for (const [i, m] of (docs.metrics?.metrics || []).entries()) {
    const at = `/metrics/${i}`
    if (m.view) { p('metrics.json', at, 'a Cube has no views; use dataset'); continue }
    if (m.derived) {
      for (const [, pkg, key] of m.derived.matchAll(FORMULA_TOKEN)) {
        const ref = pkg ? `${pkg}.${key}` : key
        metricRef('metrics.json', `${at}/derived`, ref)
        if (pkg && pkg.includes('-')) w('metrics.json', `${at}/derived`, `'${ref}': a hyphenated package in a formula — check that the catalog's tokenizer reads it whole`)
      }
      continue
    }
    const ds = datasets.get(m.dataset)
    if (!ds) { p('metrics.json', at, `unknown dataset '${m.dataset}'`); continue }
    const cols = new Set(ds.columns.map((c) => c.name))
    for (const t of (m.expr || '').match(EXPR_TOKEN) || []) if (!cols.has(t)) p('metrics.json', `${at}/expr`, `dataset '${m.dataset}' has no column '${t}'`)
    for (const [j, f] of (m.filters || []).entries()) if (!cols.has(f.column)) p('metrics.json', `${at}/filters/${j}`, `dataset '${m.dataset}' has no column '${f.column}'`)
    for (const k of ['time', 'currency']) if (m[k] && !cols.has(m[k])) p('metrics.json', `${at}/${k}`, `dataset '${m.dataset}' has no column '${m[k]}'`)
    if (m.format === 'money' && !m.currency) p('metrics.json', at, 'a money metric names its currency column')
  }
  // Cycles among own derived metrics.
  const visiting = new Set()
  const done = new Set()
  const visit = (key, trail) => {
    if (done.has(key)) return
    if (visiting.has(key)) { p('metrics.json', `/metrics/${[...ownMetrics.keys()].indexOf(key)}/derived`, `cycle: ${[...trail, key].join(' → ')}`); return }
    const m = ownMetrics.get(key)
    if (!m?.derived) { done.add(key); return }
    visiting.add(key)
    for (const [, pkg, k] of m.derived.matchAll(FORMULA_TOKEN)) if ((!pkg || pkg === self) && ownMetrics.has(k)) visit(k, [...trail, key])
    visiting.delete(key)
    done.add(key)
  }
  for (const k of ownMetrics.keys()) visit(k, [])

  // 7. Reports.
  const joinsTo = (dsName, pkg) => [...ownDims.values()].some((d) => d.dataset === dsName && d.joins && d.joins.startsWith(`${pkg}.`))
  const dimDataset = (ref) => ownDims.get(local(ref))?.dataset
  for (const [i, r] of (docs.reports?.reports || []).entries()) {
    for (const name of r.requires || []) if (!required.has(name) && name !== self) p('reports.json', `/reports/${i}/requires`, `'${name}' is not in cube.json requires`)
    for (const [b, block] of (r.blocks || []).entries()) {
      const at = `/reports/${i}/blocks/${b}`
      const metrics = []
      if (block.metric) metrics.push(['metric', block.metric])
      for (const [n, m] of (block.metrics || []).entries()) metrics.push([`metrics/${n}`, m])
      for (const [n, s] of (block.steps || []).entries()) metrics.push([`steps/${n}/metric`, s.metric])
      for (const [path, m] of metrics) metricRef('reports.json', `${at}/${path}`, m)
      for (const k of Object.keys(block.captions || {})) if (!metrics.some(([, m]) => m === k)) p('reports.json', `${at}/captions/${k}`, 'caption for a metric the block does not show')
      const dims = []
      for (const k of ['by', 'stack_by', 'entity']) {
        if (Array.isArray(block[k])) block[k].forEach((d, n) => dims.push([`${k}/${n}`, d]))
        else if (block[k]) dims.push([k, block[k]])
      }
      for (const [path, d] of dims) {
        dimensionRef('reports.json', `${at}/${path}`, d)
        // The compiler joins packages only over declared dimensions.
        for (const [, m] of metrics) {
          const mp = pkgOf(m)
          if (own(d) && mp !== self && ownDims.has(local(d)) && !joinsTo(dimDataset(d), mp)) {
            p('reports.json', `${at}/${path}`, `'${d}' cannot break down '${m}': dataset '${dimDataset(d)}' declares no dimension that joins ${mp}`)
          }
        }
      }
      if (block.type === 'drilldown') {
        const app = block.to.slice('commerce:'.length).split('.')[0]
        if (!required.has(app)) w('reports.json', `${at}/to`, `drilldown into '${app}', which cube.json does not require`)
      }
    }
  }

  // 8. Dashboards.
  for (const [i, d] of (docs.dashboards?.dashboards || []).entries()) {
    for (const [n, wd] of (d.widgets || []).entries()) {
      const at = `/dashboards/${i}/widgets/${n}`
      if (wd.metric) metricRef('dashboards.json', `${at}/metric`, wd.metric)
      if (wd.chart?.metric) metricRef('dashboards.json', `${at}/chart/metric`, wd.chart.metric)
      if (wd.chart?.by) dimensionRef('dashboards.json', `${at}/chart/by`, wd.chart.by)
      if (wd.report) {
        if (own(wd.report)) {
          const rep = ownReports.get(local(wd.report))
          if (!rep) p('dashboards.json', `${at}/report`, `unknown report '${wd.report}'`)
          else if (!(wd.block >= 0 && wd.block < rep.blocks.length)) p('dashboards.json', `${at}/block`, `report '${wd.report}' has no block ${wd.block}`)
        } else checkForeign('dashboards.json', `${at}/report`, wd.report, 'report')
      }
      if (wd.x + wd.w > 12) p('dashboards.json', at, `widget overflows the 12-column grid (x ${wd.x} + w ${wd.w})`)
    }
  }

  // 9. Billing: a Cube is listed in the marketplace like an app.
  if (docs.billing && !docs.billing.support) w('billing.json', '', 'no support contact (the marketplace listing shows it)')

  return { root, problems, warnings, docs, dataFiles }
}

function listApps(dir) {
  try {
    return execFileSync('ls', [dir]).toString().split('\n').filter((n) => existsSync(join(dir, n, 'manifest.json')))
  } catch { return [] }
}

function checkCsv(text, ds, file, p) {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ''))
  if (!rows.length) { p(file, '', 'empty file'); return }
  const header = rows[0]
  const declared = ds.columns.map((c) => c.name)
  const missing = declared.filter((c) => !header.includes(c))
  const extra = header.filter((c) => !declared.includes(c))
  if (missing.length) p(file, '/0', `header lacks column(s) ${missing.join(', ')}`)
  if (extra.length) p(file, '/0', `header has undeclared column(s) ${extra.join(', ')}`)
  if (missing.length || extra.length) return
  const cols = ds.columns.map((c) => ({ ...c, at: header.indexOf(c.name) }))
  let bad = 0
  for (let n = 1; n < rows.length; n++) {
    const row = rows[n]
    if (row.length !== header.length) { if (bad++ < 20) p(file, `/${n}`, `has ${row.length} fields, header has ${header.length}`); continue }
    for (const c of cols) {
      const v = row[c.at]
      if (v === '') {
        if (c.optional === false && bad++ < 20) p(file, `/${n}/${c.name}`, 'required value is empty')
        continue
      }
      if (!TYPE_CHECKS[c.type](v) && bad++ < 20) p(file, `/${n}/${c.name}`, `'${v}' is not a ${c.type}`)
    }
  }
  if (bad > 20) p(file, '', `${bad} problems in total, first 20 shown`)
  if (rows.length - 1 === 0) p(file, '', 'no rows')
}

function scanSql(value, doc, path, p) {
  if (typeof value === 'string') {
    if (SQL.test(value)) p(doc, path || '/', 'looks like SQL; a Cube never ships SQL')
    return
  }
  if (Array.isArray(value)) { value.forEach((v, i) => scanSql(v, doc, `${path}/${i}`, p)); return }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (!TEXT_KEYS.has(k)) scanSql(v, doc, `${path}/${k}`, p)
  }
}

// ---------------------------------------------------------------- bundle
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

export function buildBundle(result, flags = {}) {
  const { root, docs, dataFiles } = result
  const files = {}
  for (const doc of DOCS) if (docs[doc]) files[`${doc}.json`] = docs[doc]
  for (const file of [...dataFiles.keys()].sort()) files[file] = readFileSync(join(root, file), 'utf8')
  let repo = flags.repo
  if (!repo && existsSync(join(root, 'catalog-info.yaml'))) {
    repo = /github\.com\/project-slug:\s*(\S+)/.exec(readFileSync(join(root, 'catalog-info.yaml'), 'utf8'))?.[1]
  }
  let commit = flags.commit
  if (!commit) {
    commit = git(root, ['rev-parse', 'HEAD'])
    const dirty = git(root, ['status', '--porcelain'])
    if (dirty && !flags['allow-dirty']) throw new Error('working tree has uncommitted changes; commit first (a release names the commit it was built from) or pass --allow-dirty for a dry run')
  }
  if (!repo) throw new Error('no repo: set github.com/project-slug in catalog-info.yaml or pass --repo')
  return { files, source: { repo, commit } }
}

// ---------------------------------------------------------------- CLI
function print(result, json) {
  const { problems, warnings, docs } = result
  if (json) { console.log(JSON.stringify({ ok: !problems.length, problems, warnings }, null, 2)); return }
  const id = docs.cube ? `${docs.cube.vendor}/${docs.cube.name}@${docs.cube.version}` : result.root
  for (const x of warnings) console.error(`  warn  ${x.document}${x.path ? ` ${x.path}` : ''}: ${x.message}`)
  for (const x of problems) console.error(`  FAIL  ${x.document}${x.path ? ` ${x.path}` : ''}: ${x.message}`)
  console.error(problems.length ? `✗ ${id}: ${problems.length} problem(s)` : `✓ ${id}: valid (${warnings.length} warning(s))`)
}

async function main() {
  const { command, dir, flags } = parseArgs(process.argv.slice(2))
  if (command === 'version') {
    console.log(createHash('sha256').update(readFileSync(SELF)).digest('hex').slice(0, 12))
    return
  }
  if (!['validate', 'bundle'].includes(command)) {
    console.error('usage: cube.mjs validate|bundle|version [dir] [--online] [--catalog file] [--json] [--out file] [--repo owner/name] [--commit sha] [--allow-dirty]')
    process.exit(2)
  }
  const result = await validate(dir, flags)
  print(result, command === 'validate' && flags.json)
  if (result.problems.length) process.exit(1)
  if (command === 'bundle') {
    const body = buildBundle(result, flags)
    const out = JSON.stringify(body, null, 2) + '\n'
    if (flags.out) {
      mkdirSync(dirname(resolve(flags.out)), { recursive: true })
      writeFileSync(flags.out, out)
      const size = Buffer.byteLength(out)
      console.error(`bundle → ${flags.out} (${Object.keys(body.files).length} files, ${(size / 1024).toFixed(1)} KiB, ${body.source.repo}@${body.source.commit.slice(0, 12)})`)
    } else process.stdout.write(out)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(2) })
}
