# Content schema & how to add items

All site content lives in this `content/` folder. The website reads
`content/manifest.json` on load, then fetches each listed file and assembles
the site. **You add content by dropping files here and regenerating the
manifest** — the site's HTML/JS (the "engine") never needs changing.

The authoritative field definitions are the JSON Schema files in `../schemas/`
(`need-requirement.schema.json`, `use-case.schema.json`,
`case-study.schema.json`, `news.schema.json`, `common.schema.json` for shared
building blocks). Tools have no schema of their own — see the note below.
This file is a quick-reference, not a replacement for them.

## Folder layout
```
content/
  site.json              ← site title/tagline (singleton)
  products.json          ← EO product taxonomy (singleton)
  products.index.json    ← GENERATED ancestor/descendant index
  market-segments.json   ← segment vocabulary + themed pages (singleton)
  needs/        need.*.json   ← one file per need/requirement
  usecases/     uc-*.json     ← one file per use case
  casestudies/  cs-*.json     ← one file per case study
  tools/        tool-*.json   ← one file per tool/demonstrator (case-study schema, no schema of its own)
  news/         *.json         ← one file per news item (own schema, kept outside the graph)
  manifest.json           ← GENERATED — do not edit by hand
  _templates/             ← copy these when creating new items (ignored by the indexer)
```
Files/folders starting with `_` are ignored by the indexer (use for drafts).

## Adding an item (3 steps)
1. Copy a similar existing file (or one from `_templates/` if present) into
   the right folder, e.g. `content/needs/need.new-traffic-monitoring.json`.
   The filename can be anything ending in `.json`; the `id` inside the file
   is what matters.
2. Fill in the fields (see below), including any `relations` that link it
   into the graph.
3. Run `python generate_manifest.py` from the repo root, then commit. Done —
   the item appears on the site.

To edit or delete: change or remove the file, then rerun the script.

## Required vs optional fields

### Need / requirement (`needs/*.json`)
Required: `id`, `kind` (`need` or `requirement`), `statement`.
Recommended: `summary`, `status`, `priority` (MoSCoW), `confidence`,
`classification.market_segments`, `classification.products`, `relations`.

### Use case (`usecases/*.json`)
Required: `id`, `title`, `summary`, `description`.
Recommended: `maturity` (`concept`|`pilot`|`demonstrated`|`operational`|`scaled`),
`classification.market_segments`, `classification.products`,
`classification.site.integration_mode` / `integration_detail`, `relations`
(an `addresses` edge to the need(s) this use case meets — see below).

### Case study (`casestudies/*.json`)
Required: `id`, `title`, `summary`, `narrative`.
Recommended: `maturity`, `classification.market_segments`,
`classification.products`, `classification.regions`,
`classification.site.eu_project` / `project_link`, `stakeholders`, `relations`
(an `instantiates` edge to the use case it demonstrates — see below).

### Tool (`tools/*.json`)
**No schema of its own — validates against `case-study.schema.json` verbatim.**
Same required/recommended fields as a case study above. The one convention
that differs: `classification.site.project_link` is read as the tool's
*launch link* (the tool detail page shows a live "Open tool" CTA when it's
set, and a disabled "no demo yet" state when it's absent). `eu_project` isn't
meaningful for a tool and can be omitted. What makes something a tool rather
than a case study is purely which folder the file lives in.

### News (`news/*.json`)
Required: `id`, `date` (YYYY-MM-DD), `title`, `summary`.
Recommended: `type` (one of the `newsType` enum in `common.schema.json`:
`grant_call`, `cassini`, `procurement`, `product_update`, `project`, `policy`,
`event`, `other`), `classification.market_segments` (`["all"]` for items not
specific to one segment, or `["<segment-id>"]`), `body`, `link`, `tags`. News
has its own schema (`news.schema.json`) and uses the same shared
`classification` block as everything else, but is kept outside the
needs/use-cases/case-studies/tools graph — no `relations`, `sources`, or
`history` fields.

## Linking items: relations, not id arrays
Needs, use cases and case studies link to each other through a `relations`
array of `{type, target, target_kind}` objects — never by adding an id to
some other field's array. The two edges this site relies on:

```json
// on a use case, pointing at the need it addresses:
{ "type": "addresses", "target": "need.bridge-stability", "target_kind": "need" }

// on a case study, pointing at the use case it instantiates:
{ "type": "instantiates", "target": "uc-rl01", "target_kind": "use_case" }
```

The engine resolves these into reverse-edge arrays (`need._usecases`,
`usecase._caseStudies`) at load time, so a use case page automatically shows
every case study that named it — you only ever declare the edge once, from
the case study's side.

## Valid values
- **segment ids**: see `market-segments.json`. Segments with a `site` block
  (`transport.aviation`, `transport.rail`, `transport.road`,
  `transport.maritime`, `transport.urban`) have their own themed page;
  others (`transport`, `infrastructure`) are facet-only.
- **product ids**: see `products.json` — a taxonomy, so you can tag at any
  level (`clms`, `egms`, or `egms-ortho` are all valid `classification.products`
  entries). As of the 2024 catalogue import, `products.json` has 949 nodes
  (most of them dataset/variable-level entries imported from a CMEMS/CLMS/
  CAMS/CEMS/C3S product catalogue export) — `products.html` is search/filter
  driven rather than a fully-expanded browse page for this reason. Catalogue-
  imported nodes carry their original source fields (region, resolution,
  processing level, access method, file format, date coverage, user manual
  link...) under `catalogue_metadata`, an open object — see
  `schemas/vocab/product.schema.json`. The catalogue's EGMS and CORINE Land
  Cover datasets were consolidated onto the existing `egms` / `corine-land-
  cover` ids rather than creating duplicates; the old hand-authored variant
  breakdown (EGMS Basic/Calibrated/Ortho) is preserved as descriptive text in
  `egms.catalogue_metadata.superseded_variant_breakdown` since the catalogue
  breaks the same product down differently (by processing level instead).
- **maturity**: `concept`, `pilot`, `demonstrated`, `operational`, `scaled`.

## What the indexer checks
`generate_manifest.py` refuses to write the manifest (exit code 1) on hard
errors: invalid JSON, a missing required field, a duplicate `id`, or a
relation missing one of `type`/`target`/`target_kind`. It prints
non-blocking warnings for a relation that doesn't resolve to an item of the
declared kind, or a `classification` id not found in `products.json` /
`market-segments.json`. Fix errors and rerun.

For full JSON Schema validation (enums, string lengths, additionalProperties)
run `python ../schemas/validate.py` (requires
`pip install jsonschema referencing`).
