#!/usr/bin/env python3
"""
generate_manifest.py — index the content/ folders into content/manifest.json

Run this whenever you add, rename, or remove a content file:

    python generate_manifest.py

It scans content/needs/, content/usecases/, content/casestudies/ and
content/news/, validates each item against the new graph schema's required
fields and relation/classification integrity, and writes content/manifest.json
listing the files (so the static site can discover them). Singletons
(site.json, products.json, market-segments.json) are referenced directly.

Files or folders whose name starts with "_" are ignored (use for templates,
drafts, notes). The script never edits your content files.

Exit code is non-zero if any hard error is found (invalid JSON, missing
required field, duplicate id, a relation with a missing field, or a
target_kind not in the known pools) so it can gate a commit/CI if you want.
Dangling references (a relation target that doesn't resolve, or a
classification id not in the product/segment vocab) are non-blocking
warnings, since content is sometimes added in batches.
"""
import json, os, sys, datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "content")

# folder -> required fields (needs/requirements share one folder+schema; 'kind' disambiguates)
ITEM_TYPES = {
    "needs":       ("needs",       ["id", "kind", "statement"]),
    "usecases":    ("usecases",    ["id", "title", "summary", "description"]),
    "casestudies": ("casestudies", ["id", "title", "summary", "narrative"]),
    "tools":       ("tools",       ["id", "title", "summary", "narrative"]),
    "news":        ("news",        ["id", "date", "title"]),
}
SINGLETONS = ["site.json", "products.json", "market-segments.json"]

errors, warnings = [], []

def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        errors.append(f"{path}: invalid JSON ({e})")
    except OSError as e:
        errors.append(f"{path}: cannot read ({e})")
    return None

def scan(subfolder, required):
    folder = os.path.join(ROOT, subfolder)
    if not os.path.isdir(folder):
        warnings.append(f"folder missing: content/{subfolder}/ (created empty index)")
        return []
    items = []
    seen_ids = {}
    for fname in sorted(os.listdir(folder)):
        if not fname.endswith(".json") or fname.startswith("_"):
            continue
        data = load_json(os.path.join(folder, fname))
        if data is None:
            continue
        for field in required:
            if field not in data or data[field] in (None, ""):
                errors.append(f"content/{subfolder}/{fname}: missing required field '{field}'")
        iid = data.get("id")
        if iid:
            if iid in seen_ids:
                errors.append(f"duplicate id '{iid}' in {fname} and {seen_ids[iid]}")
            seen_ids[iid] = fname
        items.append({"file": fname, "data": data})
    return items

def main():
    if not os.path.isdir(ROOT):
        print(f"ERROR: content/ folder not found at {ROOT}", file=sys.stderr)
        sys.exit(2)

    for s in SINGLETONS:
        if not os.path.isfile(os.path.join(ROOT, s)):
            errors.append(f"missing singleton: content/{s}")

    segments = load_json(os.path.join(ROOT, "market-segments.json")) or []
    segment_ids = {s.get("id") for s in segments} if isinstance(segments, list) else set()
    products = load_json(os.path.join(ROOT, "products.json")) or []
    product_ids = {p.get("id") for p in products} if isinstance(products, list) else set()

    scanned = {t: scan(sub, req) for t, (sub, req) in ITEM_TYPES.items()}

    # Build id -> kind lookup across the graph pools (news is not part of the graph)
    kind_of_id = {}
    for it in scanned["needs"]:
        kind_of_id[it["data"].get("id")] = it["data"].get("kind")  # 'need' or 'requirement'
    for it in scanned["usecases"]:
        kind_of_id[it["data"].get("id")] = "use_case"
    for it in scanned["casestudies"]:
        kind_of_id[it["data"].get("id")] = "case_study"
    for it in scanned["tools"]:
        kind_of_id[it["data"].get("id")] = "tool"

    POOLS = {"need", "requirement", "use_case", "case_study", "tool"}

    def check_classification(d, src):
        cls = d.get("classification", {}) or {}
        for pid in cls.get("products", []) or []:
            if pid not in product_ids:
                warnings.append(f"{src}: classification.products id '{pid}' not in content/products.json")
        for sid in cls.get("market_segments", []) or []:
            if sid != "all" and sid not in segment_ids:
                warnings.append(f"{src}: classification.market_segments id '{sid}' not in content/market-segments.json")

    def check_relations(d, src):
        for rel in d.get("relations", []) or []:
            for f in ("type", "target", "target_kind"):
                if f not in rel:
                    errors.append(f"{src}: relation missing required field '{f}': {rel}")
            tk, tgt = rel.get("target_kind"), rel.get("target")
            if tk is not None and tk not in POOLS:
                errors.append(f"{src}: relation target_kind '{tk}' is not one of {sorted(POOLS)}")
            elif tk and kind_of_id.get(tgt) != tk:
                warnings.append(f"{src}: relation '{rel.get('type')}' -> '{tgt}' (target_kind={tk}) does not resolve to a {tk} item")

    for ttype, items in scanned.items():
        for it in items:
            d, src = it["data"], f"content/{ttype}/{it['file']}"
            check_classification(d, src)
            check_relations(d, src)

    needs = sorted([it["file"] for it in scanned["needs"]], key=str.lower)
    usecases = sorted([it["file"] for it in scanned["usecases"]], key=str.lower)
    casestudies = sorted([it["file"] for it in scanned["casestudies"]], key=str.lower)
    tools = sorted([it["file"] for it in scanned["tools"]], key=str.lower)
    def news_key(it):
        return (it["data"].get("date", ""), it["data"].get("id", ""))
    news = [it["file"] for it in sorted(scanned["news"], key=news_key, reverse=True)]

    manifest = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "site": "site.json",
        "products": "products.json",
        "segments": "market-segments.json",
        "needs": needs,
        "usecases": usecases,
        "casestudies": casestudies,
        "tools": tools,
        "news": news,
        "counts": {
            "needs": len(needs), "usecases": len(usecases),
            "casestudies": len(casestudies), "tools": len(tools), "news": len(news),
        },
    }

    if errors:
        print("MANIFEST NOT WRITTEN — fix these errors first:\n", file=sys.stderr)
        for e in errors:
            print("  ✗ " + e, file=sys.stderr)
        if warnings:
            print("\nWarnings:", file=sys.stderr)
            for w in warnings:
                print("  ! " + w, file=sys.stderr)
        sys.exit(1)

    out = os.path.join(ROOT, "manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"✓ Wrote content/manifest.json")
    print(f"  needs       : {len(needs)}")
    print(f"  use cases   : {len(usecases)}")
    print(f"  case studies: {len(casestudies)}")
    print(f"  tools       : {len(tools)}")
    print(f"  news        : {len(news)}")
    if warnings:
        print("\n  Warnings (non-blocking):")
        for w in warnings:
            print("    ! " + w)

if __name__ == "__main__":
    main()
