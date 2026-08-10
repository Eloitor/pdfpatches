# arxiv-corrections — autoclassificador de correccions

Detecta preprints d'arXiv que **corregeixen alguna cosa d'un altre paper**
(corrigenda, errata, errors en proves, gaps, counterexamples a conjectures
publicades, "a note on..." amb correcció...).

## Pipeline

```
arXiv API (sense clau) → cerques dirigides (math.*) → dedupe per id
→ regles (data/patterns.json) → mini model local (TF-IDF char + LogisticRegression)
→ report JSON + MD (reports/arxiv-candidates/)
```

## Ús

```bash
# run complet: escaneja, puntua i escriu el report del dia
.venv/bin/python tools/arxiv-corrections/classify.py --limit 12 --min-score 0.55

# re-entrenar el model des del seed etiquetat
.venv/bin/python tools/arxiv-corrections/classify.py --train

# escaneig sense escriure report
.venv/bin/python tools/arxiv-corrections/classify.py --dry-run --limit 6
```

Opcions: `--days N` (només publicats els últims N dies), `--limit N` (per query),
`--min-score F` (llindar del report), `--query "..."` (query addicional, repetible).

## Components

| Fitxer | Rol |
|---|---|
| `classify.py` | CLI: fetch, scoring, report. Modes `--train`/`--eval`/`--dry-run` |
| `data/patterns.json` | Regles regex pesades (positives i negatives) sobre títol+abstract |
| `data/training.tsv` | Seed etiquetat a mà (92 exemples: 27 correctius, 65 no) |
| `data/model.joblib` | Mini model entrenat (TfidfVectorizer char_wb 2-5, LogisticRegression balanced C=1) |
| `generate_seed.py` | Regenera el seed: fetch fresc + etiquetes manuals (per quan es vulgui ampliar) |
| `reports/arxiv-candidates/` | Reports per dia (JSON complet + MD resumit) |

## Mètriques (seed 92, CV 5-fold)

- accuracy 0.80, precision classe correctiva 0.70, recall 0.59, f1 0.64.
- El blend final = 0.6 × prob(model) + 0.4 × sigmoid(score regles/2).

## Etiqueta de la API d'arXiv

- User-Agent amb contacte (`pdfpatches-classifier/0.1`), ≥3s entre requests.
- `cat:math.*` i `cat:stat.*`; ordenació per data de publicació.

## Integració Luna

Quan hi ha un report nou, es genera un bead per a **Luna** (Flota Astral) que
llegeix els candidats i n'extreu la correcció exacta. Protocol complet a
[`LUNA.md`](LUNA.md).
