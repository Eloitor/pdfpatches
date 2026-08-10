import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PatchApplyError,
  applyPdfPatches,
  applyUnifiedDiff,
  parseUnifiedDiff,
} from "../common/apply_patch.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value) {
  return encoder.encode(value);
}

const pythonCompare = String.raw`
import sys
import pymupdf

left = pymupdf.open(sys.argv[1])
right = pymupdf.open(sys.argv[2])
assert len(left) == len(right), (len(left), len(right))
for page_number, (a, b) in enumerate(zip(left, right), 1):
    assert a.get_text() == b.get_text(), f"text differs on page {page_number}"
    pa = a.get_pixmap(matrix=pymupdf.Matrix(1, 1), alpha=False)
    pb = b.get_pixmap(matrix=pymupdf.Matrix(1, 1), alpha=False)
    assert (pa.width, pa.height, pa.n) == (pb.width, pb.height, pb.n), page_number
    assert pa.samples == pb.samples, f"render differs on page {page_number}"
print(f"{len(left)} pages: text and pixels identical")
`;

test("ports unified diff matching and two-line fuzz", () => {
  const patch = bytes(
    "@@ -1,5 +1,5 @@\n" +
      " stale before\n" +
      " alpha\n" +
      "-beta\n" +
      "+gamma\n" +
      " omega\n" +
      " stale after\n",
  );
  const applied = applyUnifiedDiff(patch, bytes("alpha\nbeta\nomega\n"));
  assert.equal(decoder.decode(applied.data), "alpha\ngamma\nomega\n");
  assert.deepEqual(applied.result, {
    hunksApplied: 1,
    fuzz: true,
    fuzzHunks: 1,
    fuzzLines: 2,
    usedFuzz: true,
  });
});

test("reports typed errors for missing and ambiguous context", () => {
  assert.throws(
    () => applyUnifiedDiff(bytes("@@ -1 +1 @@\n-missing\n+new\n"), bytes("present\n")),
    (error) => error instanceof PatchApplyError && error.code === "PATCH_HUNK_NOT_FOUND",
  );
  assert.throws(
    () => applyUnifiedDiff(bytes("@@ -2 +1 @@\n-same\n+new\n"), bytes("same\nother\nsame\n")),
    (error) => error instanceof PatchApplyError && error.code === "PATCH_AMBIGUOUS_CONTEXT",
  );
});

test("accepts compact repository patches", () => {
  const patch = bytes("@@ -1 +1 @@\n-old\n+new\n");
  assert.equal(parseUnifiedDiff(patch).length, 1);
});

const realCases = [
  {
    name: "Darmon raw PDF",
    source: ".work/sources/darmon.pdf",
    expected: ".work/visual-test/darmon/patched.pdf",
    patches: [
      "documents/Darmon - Rational points on modular elliptic curves/patches/and_order.patch",
    ],
  },
  {
    name: "Greenberg raw PDF",
    source: ".work/sources/greenberg.pdf",
    expected: ".work/visual-test/greenberg/patched.pdf",
    patches: [
      "documents/Greenberg - Heegner points and rigid analytic modular forms/patches/eigensymbolsymbol.patch",
      "documents/Greenberg - Heegner points and rigid analytic modular forms/patches/elliptic_curve_typo.patch",
      "documents/Greenberg - Heegner points and rigid analytic modular forms/patches/factorization_conductor.patch",
    ],
  },
];

for (const fixture of realCases) {
  const available = existsSync(fixture.source) && existsSync(fixture.expected);
  test(
    `${fixture.name}: JS raw-stream patch equals Python pipeline`,
    { skip: !available },
    async () => {
      const source = await readFile(fixture.source);
      const patchData = await Promise.all(fixture.patches.map((path) => readFile(path)));
      const actual = await applyPdfPatches(source, patchData);
      assert.equal(actual.strategy, "decoded-streams");
      assert.deepEqual(
        actual.results.map((result) => result.hunksApplied),
        fixture.patches.map(() => 1),
      );

      const directory = await mkdtemp(join(tmpdir(), "pdfpatches-js-"));
      const output = join(directory, "patched.pdf");
      try {
        await writeFile(output, actual.data);
        const python = existsSync(".venv/bin/python") ? ".venv/bin/python" : "python3";
        const comparison = spawnSync(python, ["-c", pythonCompare, fixture.expected, output], {
          encoding: "utf8",
          timeout: 120_000,
        });
        assert.equal(
          comparison.status,
          0,
          `${comparison.stdout ?? ""}\n${comparison.stderr ?? ""}`,
        );
        assert.match(comparison.stdout, /text and pixels identical/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
