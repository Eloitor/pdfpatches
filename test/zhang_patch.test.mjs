import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyPdfPatches } from "../common/apply_patch.mjs";

const sourcePath = ".work/sources/zhang.pdf";
const patchPath =
  "documents/Zhang - Heights of Heegner points on Shimura curves/patches/duplicate_words.patch";

const textCheck = String.raw`
import re
import sys
import pymupdf

def norm(text):
    return " ".join(text.split())

def real_duplicates(text):
    # real full-word duplicates ("the the", "and and"); not prefixes like
    # "the theorem" or math variables like "F F"
    return re.findall(r"\b([a-z]{3,})\s+\1\b", norm(text))

before = pymupdf.open(sys.argv[1])
after = pymupdf.open(sys.argv[2])
assert len(before) == len(after), (len(before), len(after))
changed = []
for i, (a, b) in enumerate(zip(before, after), 1):
    ta, tb = norm(a.get_text()), norm(b.get_text())
    dup_before = real_duplicates(ta)
    dup_after = real_duplicates(tb)
    if dup_before:
        assert i in (13, 52), f"page {i} has unexpected duplicate {dup_before}"
        assert dup_after == [], f"page {i}: duplicate not fixed: {dup_after}"
    elif dup_after:
        raise AssertionError(f"page {i}: new duplicate introduced: {dup_after}")
    if ta != tb:
        changed.append(i)
assert changed == [13, 52], f"unexpected changed pages: {changed}"
print("text check OK: duplicates fixed on pages 13 and 52 only")
`;

test("Zhang raw PDF: duplicate_words.patch fixes 'and and' and 'the the'", { skip: !existsSync(sourcePath) }, async () => {
  const source = await readFile(sourcePath);
  const patch = await readFile(patchPath);
  const result = await applyPdfPatches(source, [patch]);
  assert.equal(result.strategy, "decoded-streams");
  assert.deepEqual(result.results.map((r) => r.hunksApplied), [2]);

  const directory = await mkdtemp(join(tmpdir(), "pdfpatches-zhang-"));
  const output = join(directory, "patched.pdf");
  try {
    await writeFile(output, result.data);
    const python = existsSync(".venv/bin/python") ? ".venv/bin/python" : "python3";
    const check = spawnSync(python, ["-c", textCheck, sourcePath, output], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(check.status, 0, `${check.stdout ?? ""}\n${check.stderr ?? ""}`);
    assert.match(check.stdout, /text check OK/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
