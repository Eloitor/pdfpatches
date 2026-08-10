import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

test("patch manifest generator includes templates and patch contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdfpatches-manifest-"));
  const output = join(directory, "patches.json");
  try {
    const result = spawnSync(
      process.execPath,
      ["tools/generate-patches-manifest.mjs", "--root", root, "--output", output],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.equal(manifest.documents.length, 3);
    const darmon = manifest.documents.find((document) => document.id.startsWith("darmon-"));
    const greenberg = manifest.documents.find((document) => document.id.startsWith("greenberg-"));
    const zhang = manifest.documents.find((document) => document.id.startsWith("zhang-"));
    assert.equal(darmon.title, "Rational points on modular elliptic curves");
    assert.ok(darmon.patches.some((patch) => patch.name === "and_order.patch" && patch.supportedClientSide));
    assert.ok(darmon.patches.some((patch) => patch.type === "python-script"));
    assert.equal(greenberg.patches.filter((patch) => patch.type === "unified").length, 3);
    assert.match(greenberg.patches[0].content, /eigensymbolsymbol/);
    assert.equal(zhang.patches.length, 1);
    assert.ok(zhang.patches.some((patch) => patch.name === "duplicate_words.patch" && patch.supportedClientSide));
    assert.equal(existsSync("extension/patches.json"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
