# Luna — protocol d'extracció de correccions

Aquest document defineix com **Luna** (Flota Astral) processa els candidats del
classificador d'arXiv i emet el veredicte de *patchability*.

## Entrada

- Report del classificador: `reports/arxiv-candidates/YYYY-MM-DD.md` (+ `.json`).
- El bead d'entrada conté la llista de candidats (arxiv_id) a processar.

## Sortida

Per a cada candidat llegit, escriu `reports/corrections/<arxiv_id>.json` amb
aquest schema fixat:

```json
{
  "arxiv_id": "2606.05223",
  "title": "Corrigendum to ...",
  "url": "https://arxiv.org/abs/2606.05223",
  "corrective": true,
  "claim_quote": "cita textual del que diu que corregeix (amb secció/pàgina)",
  "corrected_paper": "títol del paper corregit (tal com el cita el candidat)",
  "repo_match": {
    "matched": true,
    "document": "documents/<Doc>/",
    "how": "per títol | per autor | per url | cap",
    "confidence": "alta | mitjana | baixa"
  },
  "patchable": "sí | no | potser",
  "rationale": "per què és/no és patchable (el canvi és localitzable al PDF? és una correcció de text concreta?)",
  "suggested_patch_text": "text abans → després si es pot concretar"
}
```

## Passos exactes

1. `beads_claim <id>` — reclama el bead del candidat.
2. Baixa el PDF: `https://arxiv.org/pdf/<arxiv_id>` (amb curl/wget).
3. Llegeix el paper (pymupdf si cal extreure text: `.venv/bin/python`).
4. Troba **exactament** què corregeix: cita textual + localització
   (secció/pàgina/teorema) al fitxer JSON.
5. Identifica el paper corregit (títol complet i autors tal com els cita).
6. Comprova si el paper corregit és al repo: matxa per títol/autor/url amb
   `documents/*/template` (camps `title`, `author`, `url`).
7. Emet el veredicte:
   - **sí**: la correcció és un canvi de text localitzable i conegut
     (ex: "Theorem 5.4 of arXiv:2209.15033 is wrong; the correct statement is
     ..."). → es pot convertir en un patch del document.
   - **potser**: la correcció és tècnica i cal decidir (ex: "la prova té un
     gap"; caldria reescriure text).
   - **no**: canvis estructurals, no localitzables, o el paper corregit no és
     al repo.
8. Si `patchable=sí` i `repo_match.matched=true`: crea un bead nou
   (prefix `pdfpatches`, prioritat segons rellevància) descrivint el patch a
   crear (text abans/després, pàgina, document) — enllaça amb els epics de
   patches i visual-diff. El tanca la flota quan el patch estigui fet i
   verificat amb `visual_diff.py` (tots els diffs dins de les bboxes).
9. `beads_close <id> --reason="Luna: extracció feta → reports/corrections/<id>.json [dificultat: ...]"`.

## Criteris per no perdre el temps

- Un *erratum/corrigendum* propi (els autors corregeixen el seu propi paper)
  és menys interessant que corregir un paper d'ALTRES, però si el paper
  corregit és al repo, és igualment patchable.
- Un *counterexample* a una conjectura publicada pot implicar corregir
  l'enunciat d'un teorema al paper original (patch d'enunciat).
- Els candidats amb `model_prob` alt però sense cap patró de regla matxat
  són els més difícils: llegeix-los amb atenció.

## Recordatoris

- No modifiquis `tools/arxiv-corrections/classify.py` sense bead propi.
- Si un candidat no és llegible (PDF malmès), anota-ho al rationale i tanca
  amb `patchable=no`.
