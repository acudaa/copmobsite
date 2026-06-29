#!/usr/bin/env python3
"""
convert_catalogue.py — merge cop_products_2024.json (a flat 844-row product
catalogue export) into products.json (the site's hierarchical taxonomy),
without information loss and without duplicates.

Source shape: one row per (dataset, output parameter) pair. A "dataset" is
identified by 'Data ID'; when a Data ID has multiple rows, those rows are
the dataset's distinct output variables (same dataset, different
'Specific output parameter') -- confirmed by inspection: for ~84% of grouped
rows ONLY the parameter-related fields differ; the rest also vary in region/
resolution/etc, so we keep every row as its own node rather than collapsing
naively, to guarantee no information is lost.

Mapping:
  - Abbreviation (C3S/CLMS/CEMS/CAMS/CMEMS) -> parent = the matching existing
    service-level node id already in products.json (c3s/clms/cems/cams/cmems).
  - One node per unique Data ID -> level='product', parent=service.
    Name/description/url/etc taken from that group's first row.
  - If a Data ID has >1 row -> each row ALSO becomes a level='sub_product'
    child of the dataset node, named after its 'Specific output parameter'.
    (If only 1 row, no separate sub_product is created -- the row's variable
    detail lives directly on the product node's catalogue_metadata.)
  - Every field from the source row that doesn't map to a core schema field
    is preserved verbatim under catalogue_metadata (nothing is dropped).
  - 'Observation/model' maps to the schema's 'nature' enum when set.
  - family is fixed to 'copernicus_service' for everything (all 5 sources
    are Copernicus services, matching the existing clms/cams/cmems/c3s/cems
    entries already in products.json).

Run:
    python convert_catalogue.py
Writes products.merged.json next to the inputs. Does not overwrite
products.json directly -- review the diff, then copy over manually.
"""
import json
import re
import sys
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).parent
CATALOGUE = ROOT / "cop_products_2024.json"
EXISTING = ROOT / "products.json"
OUT = ROOT / "products.merged.json"
REPORT = ROOT / "conversion_report.txt"

ABBR_TO_SERVICE_ID = {
    "C3S": "c3s",
    "CLMS": "clms",
    "CEMS": "cems",
    "CAMS": "cams",
    "CMEMS": "cmems",
}

# Confirmed real-world overlaps between the catalogue and the existing
# hand-authored products.json: the catalogue's dataset for these is replacing
# the old hand-authored node entirely (per explicit decision -- see chat).
# Key = (Abbreviation, Data ID) as found in the catalogue; value = the
# existing id to REUSE instead of generating a new one, so every existing
# content file that already references that id (e.g. classification.products:
# ["egms"]) keeps working without any content-file edits.
#
# EGMS: the catalogue's one dataset ('European Ground Motion Service (EU-GMS)')
# replaces the OLD node 'egms' and its 3 children 'egms-basic'/'egms-calibrated'/
# 'egms-ortho' (confirmed unreferenced by any content file) -- the catalogue
# breaks the product down by PROCESSING LEVEL (L2a/L2b/L3) instead, which is
# a different and more accurate breakdown of the same real service.
#
# CORINE Land Cover: the catalogue has TWO distinct datasets for the actual
# CORINE product (the 2018 status layer, and the 2012-2018 change layer) --
# these are genuinely two different products, not duplicates of each other.
# Only the 2018 status dataset reuses the existing 'corine-land-cover' id
# (confirmed referenced by tool-green-routing-active-modes.json and
# tool-lez-modelling-cities.json); the change dataset gets a new sibling id.
# NOTE: the catalogue also has two "ENI2018" PILOT datasets whose row
# 'Parameter' field happens to also say "Corine land cover" -- those are a
# different, smaller pilot product (extension methodology trial), NOT the
# main CORINE product, and are deliberately left to generate their own new
# ids rather than being folded into 'corine-land-cover'.
RENAME_TO_EXISTING = {
    ("CLMS", "European Ground Motion Service (EU-GMS)"): "egms",
    ("CLMS", "Corine Land Cover (CLC) 2018, Version 2020_20u1"): "corine-land-cover",
}

# Old hand-authored nodes that are superseded by a catalogue dataset above and
# must be removed from the existing set before merging (otherwise we'd end up
# with two nodes claiming the same id, or orphaned children of a removed parent).
SUPERSEDED_OLD_IDS = {"egms", "egms-basic", "egms-calibrated", "egms-ortho", "corine-land-cover"}

OBS_MODEL_TO_NATURE = {
    "satelite observations": "observational",  # source has this typo consistently
    "satellite observations": "observational",
    "numerical model": "modelled",
}

# Source fields that map directly to existing schema fields (consumed,
# not duplicated into catalogue_metadata).
CONSUMED_FIELDS = {
    "Data provider", "Abbreviation", "Data ID", "Datalink",
    "Specific output parameter",  # used for sub_product name, but also kept
                                    # in catalogue_metadata for traceability
}


def slugify(s, maxlen=60):
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(s)).strip("-").lower()
    if not s:
        s = "item"
    if len(s) > maxlen:
        s = s[:maxlen].rstrip("-")
    return s


def make_dataset_id(abbr, abbr_id, data_id, fallback_seed):
    reuse = RENAME_TO_EXISTING.get((abbr, data_id))
    if reuse:
        return reuse
    if data_id:
        base = slugify(data_id)
    else:
        base = "unidentified-" + slugify(str(fallback_seed), maxlen=20)
    return f"{abbr_id}-{base}"


def dedupe_id(candidate, used):
    """Append -2, -3... if candidate is already taken (defensive; the
    dataset-id construction above is designed to avoid this, but the
    catalogue is real-world messy so we guard anyway)."""
    if candidate not in used:
        return candidate
    n = 2
    while f"{candidate}-{n}" in used:
        n += 1
    return f"{candidate}-{n}"


def nature_from_row(row):
    om = (row.get("Observation/model") or "").strip().lower()
    return OBS_MODEL_TO_NATURE.get(om)


def catalogue_metadata_from_row(row):
    """Every field not consumed into a core schema field, preserved verbatim
    (including nulls -- a missing value in the source is still meaningful:
    it tells you the catalogue didn't have that attribute for this row)."""
    out = {}
    for k, v in row.items():
        if k in CONSUMED_FIELDS:
            continue
        if k == "Observation/model":
            out["observation_or_model"] = v
            continue
        # normalise field name to snake_case key for catalogue_metadata
        key = re.sub(r"[^A-Za-z0-9]+", "_", k).strip("_").lower()
        out[key] = v
    out["specific_output_parameter"] = row.get("Specific output parameter")
    out["source_data_id"] = row.get("Data ID")
    return out


def main():
    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    existing = json.loads(EXISTING.read_text(encoding="utf-8"))
    superseded_nodes = {p["id"]: p for p in existing if p["id"] in SUPERSEDED_OLD_IDS}
    n_superseded = len(superseded_nodes)
    existing = [p for p in existing if p["id"] not in SUPERSEDED_OLD_IDS]
    existing_ids = {p["id"] for p in existing}
    for abbr, sid in ABBR_TO_SERVICE_ID.items():
        if sid not in existing_ids:
            sys.exit(f"FATAL: expected service id '{sid}' (for {abbr}) not found in products.json")

    # Drop exact full-record duplicates (2 found on inspection) before grouping.
    seen_exact = set()
    rows = []
    n_exact_dupes = 0
    for r in catalogue:
        h = json.dumps(r, sort_keys=True)
        if h in seen_exact:
            n_exact_dupes += 1
            continue
        seen_exact.add(h)
        rows.append(r)

    # Group by (Abbreviation, Data ID) -- group by abbreviation too in case
    # the same literal Data ID string ever appeared under two services
    # (not observed, but cheap to guard against silently merging unrelated data).
    groups = defaultdict(list)
    for r in rows:
        key = (r.get("Abbreviation"), r.get("Data ID"))
        groups[key].append(r)

    new_nodes = []
    used_ids = set(existing_ids)
    report_lines = []
    n_products = 0
    n_subproducts = 0
    renames_applied = []

    for (abbr, data_id), group_rows in groups.items():
        service_id = ABBR_TO_SERVICE_ID.get(abbr)
        if service_id is None:
            report_lines.append(f"SKIPPED group (unknown Abbreviation={abbr!r}, Data ID={data_id!r}, {len(group_rows)} row(s))")
            continue

        first = group_rows[0]
        seed = data_id or id(group_rows)
        dataset_id = dedupe_id(make_dataset_id(abbr, service_id, data_id, seed), used_ids)
        used_ids.add(dataset_id)
        if (abbr, data_id) in RENAME_TO_EXISTING:
            renames_applied.append((abbr, data_id, dataset_id))

        dataset_name = data_id or first.get("Specific output parameter") or first.get("Parameter") or dataset_id
        dataset_node = {
            "id": dataset_id,
            "name": dataset_name,
            "level": "product",
            "parent": service_id,
            "family": "copernicus_service",
            "provider": first.get("Data provider"),
        }
        nat = nature_from_row(first)
        if nat:
            dataset_node["nature"] = nat
        if first.get("Product description"):
            dataset_node["description"] = first["Product description"]
        if first.get("Datalink"):
            dataset_node["url"] = first["Datalink"]

        old_node = superseded_nodes.get(dataset_id)
        old_variant_breakdown = None
        if old_node:
            # This dataset reused an existing curated id (see RENAME_TO_EXISTING) --
            # carry forward fields the hand-authored node had that the catalogue
            # row doesn't capture, so nothing curated is lost in the swap.
            if old_node.get("aliases"):
                dataset_node["aliases"] = old_node["aliases"]
            if old_node.get("derived_from"):
                dataset_node["derived_from"] = old_node["derived_from"]
            if old_node.get("nature"):
                dataset_node["nature"] = old_node["nature"]
            if old_node.get("type"):
                dataset_node["type"] = old_node["type"]
            # Prefer the hand-authored description: it was deliberately written
            # for this site, vs. the catalogue's (often absent or terser) one.
            if old_node.get("description"):
                dataset_node["description"] = old_node["description"]
            # The old node's children described a DIFFERENT breakdown of this
            # product (e.g. EGMS Basic/Calibrated/Ortho = by output format) than
            # the catalogue's children (by processing level). That old breakdown
            # doesn't map 1:1 onto the new sub_products, so it can't be merged
            # structurally -- but the descriptive text is preserved here rather
            # than silently dropped. Computed now, merged into catalogue_metadata
            # below (after it's built) rather than set directly here, since the
            # single-row/multi-row branches each construct catalogue_metadata fresh.
            old_children = [p for p in superseded_nodes.values() if p.get("parent") == dataset_id]
            if old_children:
                old_variant_breakdown = [
                    {"name": c["name"], "type": c.get("type"), "nature": c.get("nature")} for c in old_children
                ]

        if len(group_rows) == 1:
            # Single row: all its detail lives directly on the product node.
            dataset_node["catalogue_metadata"] = catalogue_metadata_from_row(first)
            if old_variant_breakdown:
                dataset_node["catalogue_metadata"]["superseded_variant_breakdown"] = old_variant_breakdown
            new_nodes.append(dataset_node)
            n_products += 1
        else:
            # Multiple rows under the same Data ID: keep the dataset node
            # (metadata from the first row, for backward/forward links) AND
            # create one sub_product per row so every row's full detail
            # (including cases where region/resolution/etc differ between
            # rows, not just the parameter) is preserved as its own node.
            dataset_node["catalogue_metadata"] = {"note": "Multiple output variables exist under this dataset; see child sub_product nodes for per-variable detail.", "source_data_id": data_id}
            if old_variant_breakdown:
                dataset_node["catalogue_metadata"]["superseded_variant_breakdown"] = old_variant_breakdown
            new_nodes.append(dataset_node)
            n_products += 1

            used_subslugs = set()
            for row in group_rows:
                param = row.get("Specific output parameter") or row.get("Parameter") or "variable"
                sub_slug = slugify(param, maxlen=40)
                sub_slug = dedupe_id(sub_slug, used_subslugs)
                used_subslugs.add(sub_slug)
                sub_id = dedupe_id(f"{dataset_id}-{sub_slug}", used_ids)
                used_ids.add(sub_id)

                sub_node = {
                    "id": sub_id,
                    "name": param,
                    "level": "sub_product",
                    "parent": dataset_id,
                    "family": "copernicus_service",
                    "provider": row.get("Data provider"),
                }
                snat = nature_from_row(row)
                if snat:
                    sub_node["nature"] = snat
                if row.get("Product description"):
                    sub_node["description"] = row["Product description"]
                if row.get("Datalink"):
                    sub_node["url"] = row["Datalink"]
                sub_node["catalogue_metadata"] = catalogue_metadata_from_row(row)
                new_nodes.append(sub_node)
                n_subproducts += 1

    merged = existing + new_nodes

    OUT.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    report_lines.insert(0, f"Source rows: {len(catalogue)}")
    report_lines.insert(1, f"Exact full-record duplicates dropped: {n_exact_dupes}")
    report_lines.insert(2, f"Old hand-authored nodes removed as superseded: {n_superseded} ({sorted(SUPERSEDED_OLD_IDS)})")
    report_lines.insert(3, f"Catalogue datasets reusing an existing id (no new id generated): {len(renames_applied)}")
    for abbr, data_id, dataset_id in renames_applied:
        report_lines.insert(4, f"  - ({abbr}, {data_id!r}) -> reused id '{dataset_id}'")
    report_lines.insert(4 + len(renames_applied), f"Dataset (product-level) groups: {len(groups)}")
    report_lines.insert(5 + len(renames_applied), f"New product-level nodes created: {n_products}")
    report_lines.insert(6 + len(renames_applied), f"New sub_product-level nodes created: {n_subproducts}")
    report_lines.insert(7 + len(renames_applied), f"Total new nodes: {len(new_nodes)}")
    report_lines.insert(8 + len(renames_applied), f"Existing nodes carried over unchanged: {len(existing)}")
    report_lines.insert(9 + len(renames_applied), f"Total nodes in products.merged.json: {len(merged)}")
    REPORT.write_text("\n".join(report_lines) + "\n", encoding="utf-8")

    print("\n".join(report_lines))
    print(f"\nWrote {OUT}")
    print(f"Wrote {REPORT}")


if __name__ == "__main__":
    main()
