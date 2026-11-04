# template

**revenexx Analytics Studio — the Cube template.** A Cube brings data and numbers into the
Analytics Studio rather than screens: a file in its release, rows a function fetches, or rows
read through a connection the tenant authorises — and the metrics, reports and dashboards
built on them. It never ships SQL.

## Start a Cube from it

```bash
gh repo create <owner>/<name> --template revenexx-cubes/template --private --clone
cd <name>
node scripts/init.mjs <name> --title-en "<English title>" --title-de "<deutscher Titel>"
npm install
npm run validate
```

`init.mjs` writes the identity into `cube.json`, `package.json`, `catalog-info.yaml`,
`mkdocs.yml` and the docs, then deletes itself. The name must not be an installed app's name
(the registry refuses it) and is the namespace of every catalog key the Cube adds.

Then replace the example — `targets` dataset, `target` and `target_attainment` metrics, the
`targets` report and dashboard, `data/targets.csv` — with the Cube's own, and fill in
`README.md`, `CLAUDE.md` and `docs/index.md`.

## The files

| File | Schema | Holds |
| --- | --- | --- |
| `cube.json` | `cube.schema.json` | identity, `requires`, `connections`, `settings`, `data[]`, `functions[]` |
| `analytics.json` | `analytics.schema.json` (v2) | the datasets: `scope` shared/tenant, `source` file/function/connection, columns |
| `metrics.json` | `metrics.schema.json` | dimensions and metrics — aggregations over a dataset, or formulas over metrics |
| `reports.json` | `reports.schema.json` | reports as blocks |
| `dashboards.json` | `dashboards.schema.json` | dashboards on a 12-column grid |
| `billing.json` | `billing.schema.json` | price and marketplace listing |
| `data/*.csv` | — | file datasets, one file per dataset, header = declared columns |

A Cube with no data of its own (like `core`) leaves out `analytics.json` and `data/`.

## Development

```bash
npm run validate          # schemas (vendored, offline) + release rules + references
npm run validate:online   # the same against https://schemas.revenexx.com
npm run bundle            # dist/release.json — the body for POST /cubes/releases
```

`test/catalog.json` lists the metric and dimension keys of the apps in `requires`; record it
with the workspace's `skills/validate-cube/scripts/catalog-snapshot.mjs`. `scripts/cube.mjs`
is a copy of the workspace validator; refresh it from there, never edit it here.
