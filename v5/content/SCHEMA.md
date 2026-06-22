# Content schema & how to add items

All site content lives in this `content/` folder. The website reads
`content/manifest.json` on load, then fetches each listed file and assembles
the site. **You add content by dropping files here and regenerating the
manifest** — the site's HTML/JS (the "engine") never needs changing.

## Folder layout
```
content/
  site.json            ← site title/tagline (singleton)
  services.json        ← Copernicus services (singleton)
  segments.json        ← the 5 segments (singleton)
  usecases/    uc-*.json     ← one file per use case
  casestudies/ cs-*.json     ← one file per case study
  news/        *.json         ← one file per news item
  manifest.json        ← GENERATED — do not edit by hand
  _templates/          ← copy these when creating new items (ignored by indexer)
```
Files/folders starting with `_` are ignored by the indexer (use for drafts).

## Adding an item (3 steps)
1. Copy the matching file from `_templates/` into the right folder, e.g.
   `content/news/2026-07-01-new-call.json`. The filename can be anything ending
   in `.json`; the `id` inside the file is what matters.
2. Fill in the fields (see below).
3. Run `python generate_manifest.py` from the repo root, then commit. Done —
   the item appears on the site.

To edit or delete: change or remove the file, then rerun the script.

## Required vs optional fields

### Use case (`usecases/*.json`)
Required: `id`, `segment`, `title`.
Recommended: `summary`, `services` (array of service ids), `maturity`
(`research`|`trial`|`operational`), `copernicusRole` (`{mode, detail}`),
`problem`, `solution`, `relatedCaseStudies` (array of case-study ids).

### Case study (`casestudies/*.json`)
Required: `id`, `segment`, `title`.
Recommended: `real` (true for real EU projects), `maturity`, `user`,
`location`, `services`, `summary`, `challenge`, `approach`, `results`, `link`.

### News (`news/*.json`)
Required: `id`, `date` (YYYY-MM-DD), `title`.
Recommended: `type`, `segment` (`all` or a segment id), `summary`, `body`, `link`.

## Valid values
- **segment ids**: `aviation-drones`, `rail`, `road-automotive`, `marine`, `urban`
  (defined in `segments.json` — add a segment there to introduce a new one).
- **service ids**: `CAMS`, `C3S`, `CLMS`, `CMEMS`, `CEMS`, `EGMS`, `Sentinel`
  (defined in `services.json`).
- **maturity**: `research`, `trial`, `operational`.

## What the indexer checks
`generate_manifest.py` refuses to write the manifest (exit code 1) on hard
errors: invalid JSON, a missing required field, or a duplicate `id`. It prints
non-blocking warnings for unknown segment ids or `relatedCaseStudies` that point
to a missing file. Fix errors and rerun.

## The engine never touches content
Design / behaviour changes happen in the root HTML files, `app.js` and
`style.css`. Those never rewrite anything under `content/`. The only time
content files change in bulk is a one-off schema migration (e.g. adding a new
required field to every item) — a deliberate, separate step.
