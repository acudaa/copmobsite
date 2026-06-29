#!/usr/bin/env python3
"""
Validate EO content items and vocabularies against the aligned schemas, and
check referential integrity of the graph (relations + classification ids).

Requires: pip install jsonschema   (Draft 2020-12 support)

Usage:
    python validate.py
"""
import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
except ImportError:
    sys.exit("Please install dependencies:  pip install jsonschema referencing")

ROOT = Path(__file__).parent
CONTENT = ROOT.parent / "content"

# --- Load every schema and register it by its $id -------------------------
SCHEMA_FILES = [
    "common.schema.json",
    "need-requirement.schema.json",
    "use-case.schema.json",
    "case-study.schema.json",
    "news.schema.json",
    "vocab/product.schema.json",
    "vocab/market-segment.schema.json",
]

registry = Registry()
schemas = {}
for rel in SCHEMA_FILES:
    doc = json.loads((ROOT / rel).read_text())
    schemas[rel] = doc
    registry = registry.with_resource(doc["$id"], Resource.from_contents(doc))

validators = {
    "need": Draft202012Validator(schemas["need-requirement.schema.json"], registry=registry),
    "requirement": Draft202012Validator(schemas["need-requirement.schema.json"], registry=registry),
    "use_case": Draft202012Validator(schemas["use-case.schema.json"], registry=registry),
    "case_study": Draft202012Validator(schemas["case-study.schema.json"], registry=registry),
    # 'tool' deliberately has no schema of its own: a tool/demonstrator is
    # presented identically to a case study (narrative + classification +
    # maturity), so it validates against case-study.schema.json verbatim.
    # The only thing that distinguishes a tool from a case study is which
    # folder it lives in (content/tools/ vs content/casestudies/) - see the
    # folder loop below, not a 'kind' field or a separate schema.
    "tool": Draft202012Validator(schemas["case-study.schema.json"], registry=registry),
    "news": Draft202012Validator(schemas["news.schema.json"], registry=registry),
    "product": Draft202012Validator(schemas["vocab/product.schema.json"], registry=registry),
    "market_segment": Draft202012Validator(schemas["vocab/market-segment.schema.json"], registry=registry),
}

# --- Load instances ---------------------------------------------------------
# This site keeps content under ../content/ (products.json, market-segments.json,
# needs/, usecases/, casestudies/) rather than the vocab/+examples/ layout this
# script was originally sketched against - paths below point there instead.
products = {p["id"]: p for p in json.loads((CONTENT / "products.json").read_text())}
segments = {s["id"]: s for s in json.loads((CONTENT / "market-segments.json").read_text())}

items = {}          # id -> (kind, doc)
errors = []

def kind_of(doc):
    if "kind" in doc and doc.get("kind") in ("need", "requirement"):
        return doc["kind"]
    # infer from required fields
    if "narrative" in doc:
        return "case_study"
    if "description" in doc and "title" in doc:
        return "use_case"
    return None

for folder, expected_kind in [("needs", None), ("usecases", "use_case"), ("casestudies", "case_study"), ("tools", "tool")]:
    for f in sorted((CONTENT / folder).glob("*.json")):
        doc = json.loads(f.read_text())
        k = expected_kind or kind_of(doc)
        if k is None:
            errors.append(f"{f.name}: cannot determine content kind")
            continue
        items[doc["id"]] = (k, doc, f"{folder}/{f.name}")

# News is loaded separately: it validates against news.schema.json but is not
# part of the demand -> pattern -> evidence graph (no relations field, so it's
# exempt from the TARGET_POOLS / relation referential-integrity checks below).
news_items = []  # [(doc, src)]
for f in sorted((CONTENT / "news").glob("*.json")):
    doc = json.loads(f.read_text())
    news_items.append((doc, f"news/{f.name}"))

# --- 1. Schema validation --------------------------------------------------
def report(label, validator, doc, src):
    errs = sorted(validator.iter_errors(doc), key=lambda e: e.path)
    for e in errs:
        loc = "/".join(str(p) for p in e.path)
        errors.append(f"{src} [{label}] at '{loc}': {e.message}")

for cid, (k, doc, src) in items.items():
    report(k, validators[k], doc, src)
for doc, src in news_items:
    report("news", validators["news"], doc, src)
for pid, p in products.items():
    report("product", validators["product"], p, f"products/{pid}")
for sid, s in segments.items():
    report("market_segment", validators["market_segment"], s, f"segments/{sid}")

# --- 2. Referential integrity ---------------------------------------------
TARGET_POOLS = {
    "need": lambda i: items.get(i, (None,))[0] == "need",
    "requirement": lambda i: items.get(i, (None,))[0] == "requirement",
    "use_case": lambda i: items.get(i, (None,))[0] == "use_case",
    "case_study": lambda i: items.get(i, (None,))[0] == "case_study",
    "tool": lambda i: items.get(i, (None,))[0] == "tool",
}

for cid, (k, doc, src) in items.items():
    for rel in doc.get("relations", []):
        tk = rel["target_kind"]
        if not TARGET_POOLS.get(tk, lambda i: False)(rel["target"]):
            errors.append(
                f"{src}: relation '{rel['type']}' -> '{rel['target']}' "
                f"(target_kind={tk}) does not resolve to an item of that kind"
            )
    cls = doc.get("classification", {})
    for pid in cls.get("products", []):
        if pid not in products:
            errors.append(f"{src}: classification.products id '{pid}' not in product vocabulary")
    for sid in cls.get("market_segments", []):
        if sid not in segments:
            errors.append(f"{src}: classification.market_segments id '{sid}' not in segment vocabulary")
    for step in doc.get("steps", []):
        for pid in step.get("products", []):
            if pid not in products:
                errors.append(f"{src}: steps[].products id '{pid}' not in product vocabulary")

# news classification ids resolve too, with 'all' accepted as a sentinel
# meaning "not segment-specific" rather than a real market-segment id
for doc, src in news_items:
    cls = doc.get("classification", {})
    for pid in cls.get("products", []):
        if pid not in products:
            errors.append(f"{src}: classification.products id '{pid}' not in product vocabulary")
    for sid in cls.get("market_segments", []):
        if sid != "all" and sid not in segments:
            errors.append(f"{src}: classification.market_segments id '{sid}' not in segment vocabulary")

# segment parents resolve
for sid, s in segments.items():
    if "parent" in s and s["parent"] not in segments:
        errors.append(f"segments/{sid}: parent '{s['parent']}' not found")

# product taxonomy: parents resolve, no cycles, derived_from resolves
for pid, p in products.items():
    if "parent" in p and p["parent"] not in products:
        errors.append(f"products/{pid}: parent '{p['parent']}' not found")
    for d in p.get("derived_from", []):
        if d not in products:
            errors.append(f"products/{pid}: derived_from '{d}' not found")

def has_cycle(start):
    seen, cur = set(), start
    while cur in products and "parent" in products[cur]:
        cur = products[cur]["parent"]
        if cur in seen or cur == start:
            return True
        seen.add(cur)
    return False

for pid in products:
    if has_cycle(pid):
        errors.append(f"products/{pid}: parent chain forms a cycle")

# --- Result ----------------------------------------------------------------
if errors:
    print(f"FAILED with {len(errors)} problem(s):\n")
    for e in errors:
        print("  -", e)
    sys.exit(1)

print(f"OK: {len(items)} content items, {len(news_items)} news items, {len(products)} products, "
      f"{len(segments)} segments validated; all relations and vocabulary ids resolve.")
