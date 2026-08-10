# pdfpatches

## Common Scripts

- `do_fetch`: downloads the PDF and verifies its checksum.
- `do_clean`: cleans the downloaded PDF to prepare it for patching.
- `do_patch`: applies textual `*.patch` files and pikepdf `patch.py` scripts in
  lexical order, without requiring the external `patch` executable.
- `do_visual_diff`: renders each patch's before/after result and checks that
  every changed pixel is inside its configured visual boxes.
- `do_optimize`: hook for optional final PDF optimization.

`pdfm` runs `do_visual_diff` after `do_patch`.  It writes the report and PNG
comparisons to `masterdir/builddir/visualdiff/`.  Run the tool directly while
autoring boxes with:

```sh
python3 common/visual_diff.py documents/<document> cleaned.pdf visualdiff \
  --suggest
```

### `visualdiff.json`

The optional file is `documents/<document>/patches/visualdiff.json`.  Patch
keys normally use the patch basename (`foo.patch` or `patch.py`):

```json
{
  "dpi": 150,
  "patches": {
    "foo.patch": {
      "boxes": [
        {"page": 3, "x0": 72, "y0": 410, "x1": 260, "y1": 455,
         "label": "corrected formula"}
      ]
    }
  }
}
```

Pages are 1-based and coordinates are PDF points with the origin at the
bottom left.  A patch may have several boxes and may affect several pages.
Missing boxes produce a warning and do not fail the normal check; use
`--strict` to make missing configuration an error.  `--suggest` prints
bounding boxes in this same coordinate convention.

## Browser extension

`extension/` contains a minimal MV3 extension for Chromium and Firefox.  It
matches the URLs in `extension/patches.json`, fetches the currently viewed PDF,
and applies unified patches entirely in memory.  The generated manifest is
refreshed with:

```sh
node tools/generate-patches-manifest.mjs
```

Load `extension/` as an unpacked extension.  The Python `patch.py` entries are
shown in the popup but are deliberately marked as pipeline-only; the browser
path executes only unified patches.  No patched PDF is written to storage or
the repository.  Run the Node tests (the real-PDF visual checks use `.work/`
fixtures when present) with `npm test`; the optional Playwright E2E is skipped
unless Playwright and Chromium are installed.
