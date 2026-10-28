# Vendored schemas

Copies of the six contracts a Cube is validated against, so `cube.mjs validate` works offline
and in CI without reaching https://schemas.revenexx.com.

- Source: the `schemas` repo, `origin/main` at `705038c` (PE-1178, "Analytics Studio schemas"),
  `public/{cube,analytics,metrics,reports,dashboards,billing}.schema.json`.
- Refresh: `git -C ~/srv/http/playground/schemas fetch && for f in cube analytics metrics reports dashboards billing; do git -C ~/srv/http/playground/schemas show origin/main:public/$f.schema.json > $f.schema.json; done`
  — then copy them into every Cube repo's `schemas/`.
- Drift check: `node scripts/cube.mjs validate --online` validates against the live host and
  warns when a vendored copy differs from it.
