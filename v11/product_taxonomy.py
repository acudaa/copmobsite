#!/usr/bin/env python3
"""
Build a precomputed product-taxonomy index so the front end can filter across
layers uniformly: an item tagged with any product id matches a filter on that id
OR on any of its ancestors (e.g. tag 'egms-ortho' matches a filter on 'clms').

Usage:
    python product_taxonomy.py            # prints index to stdout
    python product_taxonomy.py --write    # writes vocab/products.index.json
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent
products = {p["id"]: p for p in json.loads((ROOT / "vocab/products.json").read_text())}

def ancestors(pid):
    """Ids from the immediate parent up to the root (excludes pid)."""
    out, cur = [], products.get(pid, {})
    while "parent" in cur:
        out.append(cur["parent"])
        cur = products.get(cur["parent"], {})
    return out

children = {pid: [] for pid in products}
for pid, p in products.items():
    if "parent" in p:
        children[p["parent"]].append(pid)

def descendants(pid):
    """All ids in the subtree below pid (excludes pid)."""
    out = []
    for c in children.get(pid, []):
        out.append(c)
        out.extend(descendants(c))
    return out

def build_index():
    """id -> {name, level, parent, ancestors, descendants, derived_from}.
    'self_and_ancestors' is the convenient field for filter expansion:
    an item tagged X matches a filter on any element of products[X].self_and_ancestors."""
    idx = {}
    for pid, p in products.items():
        anc = ancestors(pid)
        idx[pid] = {
            "name": p["name"],
            "level": p["level"],
            "parent": p.get("parent"),
            "ancestors": anc,
            "self_and_ancestors": [pid] + anc,
            "descendants": descendants(pid),
            "derived_from": p.get("derived_from", []),
        }
    return idx

if __name__ == "__main__":
    idx = build_index()
    if "--write" in sys.argv:
        out = ROOT / "vocab/products.index.json"
        out.write_text(json.dumps(idx, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote {out} ({len(idx)} nodes)")
    else:
        print(json.dumps(idx, indent=2, ensure_ascii=False))
