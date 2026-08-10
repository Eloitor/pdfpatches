#!/usr/bin/env python3
"""arxiv-corrections classifier.

Detects arXiv preprints that correct something in another paper (erratum,
corrigendum, "a note on...", errors/gaps in proofs, counterexamples...).

Pipeline:
  1. Fetch candidates from the arXiv API (targeted queries, math categories).
  2. Score with rule patterns (data/patterns.json) on title + abstract.
  3. Score with a mini local model (TF-IDF char n-grams + LogisticRegression,
     data/model.joblib) if trained.
  4. Write a structured report (JSON + Markdown) for human/Luna review.

Usage:
  python3 classify.py [--days N] [--limit N] [--min-score F] [--query Q]
                      [--out DIR] [--dry-run]
  python3 classify.py --train            # retrain model from data/training.tsv
  python3 classify.py --eval             # CV evaluation of the current seed data
"""

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
PATTERNS_FILE = os.path.join(DATA_DIR, "patterns.json")
TRAINING_FILE = os.path.join(DATA_DIR, "training.tsv")
MODEL_FILE = os.path.join(DATA_DIR, "model.joblib")
REPORTS_DIR = os.path.join(HERE, "..", "..", "reports", "arxiv-candidates")

ARXIV_API = "https://export.arxiv.org/api/query"
USER_AGENT = "pdfpatches-classifier/0.1 (mailto:eloitor@disroot.org)"
API_DELAY = 3.0  # arXiv API etiquette: >= 3s between requests

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}

# Targeted queries: each is an arXiv search_query fragment. Combined with a
# math-category filter. These are tuned for "corrects another paper" signals.
BASE_QUERIES = [
    'all:"corrigendum"',
    'all:"erratum"',
    'ti:"correction to"',
    'abs:"correction to"',
    'all:"gap in the proof"',
    'abs:"we correct"',
    'abs:"we fix a gap"',
    'abs:"we fix the proof"',
    'ti:"counterexample to"',
    'abs:"counterexample to the"',
    'all:"error in the proof"',
    'abs:"points out an error"',
    'abs:"an error in"',
    'all:"a corrected version"',
    'ti:"a note on"',
    'ti:"note on"',
    'abs:"is incorrect"',
    'all:"was flawed"',
]

CATEGORY_FILTER = "cat:math.* OR cat:stat.*"


def fetch_query(query: str, max_results: int = 20) -> list[dict]:
    """Fetch entries for one arXiv API query. Returns list of entry dicts."""
    search_query = f"({CATEGORY_FILTER}) AND {query}"
    params = {
        "search_query": search_query,
        "start": 0,
        "max_results": max_results,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    url = ARXIV_API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        xml_data = resp.read()
    root = ET.fromstring(xml_data)
    entries = []
    for e in root.findall("atom:entry", NS):
        arxiv_id = e.find("atom:id", NS).text.strip()
        arxiv_id = re.sub(r"^.*?/abs/", "", arxiv_id)
        title = " ".join(e.find("atom:title", NS).text.split())
        summary = " ".join(e.find("atom:summary", NS).text.split())
        published = e.find("atom:published", NS).text.strip()
        authors = [a.find("atom:name", NS).text for a in e.findall("atom:author", NS)]
        entries.append(
            {
                "arxiv_id": arxiv_id,
                "title": title,
                "abstract": summary,
                "published": published,
                "authors": authors,
                "url": f"https://arxiv.org/abs/{arxiv_id}",
            }
        )
    return entries


def load_patterns() -> dict:
    with open(PATTERNS_FILE, encoding="utf-8") as f:
        raw = json.load(f)
    patterns = {"positive": [], "negative": []}
    for sign, items in raw.items():
        for p in items:
            patterns[sign].append(
                {"re": re.compile(p["re"], re.IGNORECASE), "w": p["w"], "field": p.get("field", "both")}
            )
    return patterns


def rule_score(text: str, patterns: dict) -> tuple[float, list[str], list[str]]:
    """Weighted rule score + matched positive/negative pattern descriptions."""
    score = 0.0
    pos, neg = [], []
    for p in patterns["positive"]:
        if p["re"].search(text):
            score += p["w"]
            pos.append(p["re"].pattern)
    for p in patterns["negative"]:
        if p["re"].search(text):
            score -= p["w"]
            neg.append(p["re"].pattern)
    return score, pos, neg


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def load_model():
    try:
        import joblib

        return joblib.load(MODEL_FILE)
    except Exception:
        return None


def model_score(model, text: str) -> float | None:
    if model is None:
        return None
    prob = model.predict_proba([text])[0]
    # positive class = "1" (training labels are '0'/'1'); fallback to last class
    classes = list(model.classes_)
    pos = classes.index("1") if "1" in classes else len(classes) - 1
    return float(prob[pos])


def final_score(rule: float, model_prob: float | None) -> float:
    rule_norm = sigmoid(rule / 2.0)
    if model_prob is None:
        return rule_norm
    return 0.6 * model_prob + 0.4 * rule_norm


def run_scan(args) -> list[dict]:
    patterns = load_patterns()
    model = load_model()
    if model is not None:
        print(f"[classify] model loaded: {os.path.basename(MODEL_FILE)}", file=sys.stderr)

    queries = list(BASE_QUERIES)
    if args.query:
        queries.append(args.query)

    cutoff = dt.date.today() - dt.timedelta(days=args.days)
    seen: dict[str, dict] = {}
    for q in queries:
        try:
            entries = fetch_query(q, max_results=args.limit)
        except Exception as exc:
            print(f"[classify] query failed ({q}): {exc}", file=sys.stderr)
            time.sleep(API_DELAY)
            continue
        for e in entries:
            published = e["published"][:10]
            if published < cutoff.isoformat():
                continue
            eid = re.sub(r"v\d+$", "", e["arxiv_id"])
            if eid not in seen:
                seen[eid] = e
        print(f"[classify] {len(entries):2d} entries from {q[:60]}", file=sys.stderr)
        time.sleep(API_DELAY)

    candidates = []
    for e in seen.values():
        text = e["title"] + "\n" + e["abstract"]
        rule, pos, neg = rule_score(text, patterns)
        prob = model_score(model, text) if model is not None else None
        fs = final_score(rule, prob)
        e["rule_score"] = rule
        e["model_prob"] = prob
        e["final_score"] = fs
        e["matched"] = [re.sub(r"\\[a-z_]+", "", m).strip("\\b") for m in pos][:8]
        e["negative_matched"] = len(neg)
        candidates.append(e)
    candidates.sort(key=lambda c: c["final_score"], reverse=True)
    return candidates


def write_report(candidates: list[dict], args) -> str:
    os.makedirs(REPORTS_DIR, exist_ok=True)
    today = dt.date.today().isoformat()
    json_path = os.path.join(REPORTS_DIR, f"{today}.json")
    md_path = os.path.join(REPORTS_DIR, f"{today}.md")
    payload = {
        "generated": today,
        "queries": len(BASE_QUERIES),
        "total_unique": len(candidates),
        "model_used": os.path.exists(MODEL_FILE),
        "candidates": candidates,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    lines = [
        f"# Candidates arXiv (correccions) — {today}",
        "",
        f"- Total únics: {len(candidates)}",
        f"- Model: {'sí' if os.path.exists(MODEL_FILE) else 'no (només regles)'}",
        "",
        "| # | arXiv | score | regles | model | patrons | títol |",
        "|---|-------|-------|--------|-------|---------|-------|",
    ]
    for i, c in enumerate(candidates[:50], 1):
        mp = c["model_prob"]
        mp_s = f"{mp:.2f}" if mp is not None else "-"
        lines.append(
            f"| {i} | [{c['arxiv_id']}]({c['url']}) | {c['final_score']:.2f} | "
            f"{c['rule_score']:.0f} | {mp_s} | {', '.join(c['matched'][:3]) or '-'} | {c['title'][:70]} |"
        )
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[classify] report written: {json_path} and {md_path}", file=sys.stderr)
    return json_path


def train(args):
    """Train the mini model from data/training.tsv (label<TAB>title<TAB>abstract)."""
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.model_selection import StratifiedKFold, cross_val_score
    import joblib

    rows = []
    with open(TRAINING_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            rows.append((parts[0], parts[1], parts[2]))
    labels = [r[0] for r in rows]
    texts = [r[1] + "\n" + r[2] for r in rows]
    print(f"[train] {len(rows)} examples, labels: {sorted(set(labels))}", file=sys.stderr)

    pipe = Pipeline(
        [
            ("tfidf", TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=2)),
            ("clf", LogisticRegression(C=1.0, class_weight="balanced", max_iter=3000)),
        ]
    )
    if len(set(labels)) > 1:
        from sklearn.model_selection import StratifiedKFold, cross_val_predict
        from sklearn.metrics import classification_report, precision_recall_fscore_support
        skf = StratifiedKFold(n_splits=min(5, len(set(labels))), shuffle=True, random_state=0)
        pred = cross_val_predict(pipe, texts, labels, cv=skf)
        print(f"[train] CV classification report:", file=sys.stderr)
        print(classification_report(labels, pred, digits=2), file=sys.stderr)
        p, r, f, _ = precision_recall_fscore_support(labels, pred, labels=["1"])
        print(f"[train] positive class: precision={p[0]:.2f} recall={r[0]:.2f} f1={f[0]:.2f}", file=sys.stderr)
    pipe.fit(texts, labels)
    joblib.dump(pipe, MODEL_FILE)
    print(f"[train] model saved: {MODEL_FILE}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="arXiv corrections classifier")
    ap.add_argument("--days", type=int, default=4000, help="only entries published within N days (default: all)")
    ap.add_argument("--limit", type=int, default=20, help="max results per query")
    ap.add_argument("--min-score", type=float, default=0.45, help="minimum final score to include in report")
    ap.add_argument("--query", action="append", help="extra arXiv search_query to run (repeatable)")
    ap.add_argument("--out", help="override report directory")
    ap.add_argument("--dry-run", action="store_true", help="scan and print, do not write report")
    ap.add_argument("--train", action="store_true", help="retrain model from training.tsv")
    ap.add_argument("--eval", action="store_true", help="print CV evaluation and exit")
    args = ap.parse_args()

    global REPORTS_DIR
    if args.out:
        REPORTS_DIR = args.out
    if args.train:
        train(args)
        return
    if args.eval:
        train(args)  # train() prints CV metrics; acceptable
        return

    candidates = run_scan(args)
    candidates = [c for c in candidates if c["final_score"] >= args.min_score]
    if args.dry_run:
        for i, c in enumerate(candidates[:20], 1):
            print(f"{i:2d} {c['final_score']:.2f} {c['arxiv_id']} {c['title'][:80]}")
        return
    if candidates:
        write_report(candidates, args)
    else:
        print("[classify] no candidates above threshold", file=sys.stderr)


if __name__ == "__main__":
    main()
