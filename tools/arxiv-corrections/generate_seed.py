#!/usr/bin/env python3
"""Generate data/training.tsv from a fresh arXiv fetch + manual labels.

Labels were assigned by reading title + abstract of each entry:
  1 = corrective paper (corrects/points out errors/counterexamples/gaps in another paper)
  0 = not corrective
"""
import re, sys, time, json
sys.path.insert(0, 'tools/arxiv-corrections')
import classify as C

# arxiv_id -> manual label (1 = corrective, 0 = not)
LABELS = {
    "2607.10710": 1, "2607.22645": 1, "2606.19415": 1, "2606.05223": 1,
    "2605.20951": 1, "2606.03996": 1, "2607.07150": 1, "2607.05284": 0,
    "2605.23760": 0, "2601.21201": 1, "2602.13228": 1, "2509.25482": 0,
    "2608.06999": 0, "2608.06267": 0, "2608.05768": 0, "2608.03775": 0,
    "2608.03228": 0, "2608.02909": 0, "2608.07326": 0, "2608.07315": 0,
    "2608.06920": 1, "2608.06774": 0, "2608.06624": 0, "2607.02450": 0,
    "2604.25593": 0, "2604.09808": 0, "2604.09093": 0, "2604.06991": 0,
    "2604.04134": 0, "2607.13850": 0, "2607.13746": 0, "2606.10633": 0,
    "2604.22720": 0, "2506.01526": 1, "2310.07077": 1, "2303.02634": 0,
    "2104.10626": 0, "2006.04280": 1, "2608.04620": 0, "2101.06891": 0,
    "2608.07338": 1, "2608.06272": 1, "2608.06446": 1, "2608.05114": 1,
    "2608.04981": 1, "2608.04659": 1, "2608.07360": 0, "2608.07262": 0,
    "2608.07166": 0, "2608.07084": 0, "2608.06863": 0, "2607.28011": 0,
    "2606.03708": 0, "2606.02786": 0, "2605.10595": 0, "2604.18571": 0,
    "2604.17921": 0, "2509.01108": 1, "2408.05731": 0, "2311.03883": 0,
    "2209.05950": 1, "2203.14935": 1, "2202.07529": 1, "2608.07385": 0,
    "2608.07355": 0, "2608.07334": 0, "2608.07307": 0, "2608.07303": 0,
    "2608.07265": 0, "2607.19423": 1, "2607.13849": 0, "2607.01311": 0,
    "2606.29923": 1, "2606.29231": 1, "2606.15907": 0, "2608.07030": 0,
    "2608.07024": 0, "2608.06534": 0, "2608.05760": 0, "2608.03897": 0,
    "2608.03126": 1, "2608.06427": 0, "2608.05243": 0, "2608.03469": 0,
    "2608.01261": 0, "2608.00817": 0, "2608.00276": 0, "2608.00609": 0,
    "2607.17306": 0, "2607.05967": 0, "2607.01507": 0, "2606.31677": 0,
}

def norm_id(eid):
    return re.sub(r"v\d+$", "", eid)

seen = {}
for q in C.BASE_QUERIES:
    try:
        for e in C.fetch_query(q, max_results=6):
            nid = norm_id(e["arxiv_id"])
            if nid not in seen:
                seen[nid] = e
    except Exception as exc:
        print("ERR", q, exc, file=sys.stderr)
    time.sleep(C.API_DELAY)

print(f"fetched {len(seen)} unique entries", file=sys.stderr)
missing = [k for k in LABELS if k not in seen]
if missing:
    print("WARN missing entries:", missing, file=sys.stderr)

rows = []
n_pos = n_neg = 0
for nid, label in LABELS.items():
    e = seen.get(nid)
    if e is None:
        continue
    ab = " ".join(e["abstract"].split())[:500]
    rows.append(f"{label}\t{e['title']}\t{ab}")
    n_pos += label
    n_neg += 1 - label

with open("tools/arxiv-corrections/data/training.tsv", "w", encoding="utf-8") as f:
    f.write("# label<TAB>title<TAB>abstract  (1 = corrects another paper)\n")
    f.write("\n".join(rows) + "\n")
print(f"wrote training.tsv: {len(rows)} rows ({n_pos} positive, {n_neg} negative)")
