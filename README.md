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
