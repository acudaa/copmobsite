#!/usr/bin/env python3
"""
generate_manifest.py — index the content/ folders into content/manifest.json

Run this whenever you add, rename, or remove a content file:

    python generate_manifest.py

It scans content/usecases/, content/casestudies/ and content/news/, validates
each item, and writes content/manifest.json listing the files (so the static
site can discover them). Singletons (site.json, services.json, segments.json)
are referenced directly.

Files or folders whose name starts with "_" are ignored (use for templates,
drafts, notes). The script never edits your content files.

Exit code is non-zero if any hard error is found (invalid JSON, missing
required field, duplicate id) so it can gate a commit/CI if you want.
"""
import json, os, sys, datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "content")

# type -> (subfolder, required fields)
ITEM_TYPES = {
    "usecases":    ("usecases",    ["id", "segment", "title"]),
    "casestudies": ("casestudies", ["id", "segment", "title"]),
    "news":        ("news",        ["id", "date", "title"]),
}
SINGLETONS = ["site.json", "services.json", "segments.json"]

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

    # Singletons present?
    for s in SINGLETONS:
        if not os.path.isfile(os.path.join(ROOT, s)):
            errors.append(f"missing singleton: content/{s}")

    segments = load_json(os.path.join(ROOT, "segments.json")) or []
    segment_ids = {s.get("id") for s in segments} if isinstance(segments, list) else set()

    scanned = {t: scan(sub, req) for t, (sub, req) in ITEM_TYPES.items()}

    # Cross-reference checks (warnings, non-fatal)
    casestudy_ids = {it["data"].get("id") for it in scanned["casestudies"]}
    for it in scanned["usecases"]:
        d = it["data"]
        if segment_ids and d.get("segment") not in segment_ids:
            warnings.append(f"usecase {d.get('id')}: unknown segment '{d.get('segment')}'")
        for rid in d.get("relatedCaseStudies", []) or []:
            if rid not in casestudy_ids:
                warnings.append(f"usecase {d.get('id')}: relatedCaseStudies '{rid}' has no file")
    for it in scanned["casestudies"]:
        d = it["data"]
        if segment_ids and d.get("segment") not in segment_ids:
            warnings.append(f"casestudy {d.get('id')}: unknown segment '{d.get('segment')}'")

    # Sort: usecases & casestudies by id; news by date desc then id
    usecases = sorted([it["file"] for it in scanned["usecases"]],
                      key=lambda f: f.lower())
    casestudies = sorted([it["file"] for it in scanned["casestudies"]],
                         key=lambda f: f.lower())
    def news_key(it):
        return (it["data"].get("date", ""), it["data"].get("id", ""))
    news = [it["file"] for it in sorted(scanned["news"], key=news_key, reverse=True)]

    manifest = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "site": "site.json",
        "services": "services.json",
        "segments": "segments.json",
        "usecases": usecases,
        "casestudies": casestudies,
        "news": news,
        "counts": {"usecases": len(usecases), "casestudies": len(casestudies), "news": len(news)},
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
    print(f"  use cases : {len(usecases)}")
    print(f"  case studies: {len(casestudies)}")
    print(f"  news      : {len(news)}")
    if warnings:
        print("\n  Warnings (non-blocking):")
        for w in warnings:
            print("    ! " + w)

if __name__ == "__main__":
    main()
