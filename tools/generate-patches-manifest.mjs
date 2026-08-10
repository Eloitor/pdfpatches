#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));

function parseTemplate(source) {
  const fields = {};
  const keyPattern = /^([A-Za-z_][A-Za-z0-9_]*)=/gm;
  const matches = [...source.matchAll(keyPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    let value = source.slice(start, end).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    fields[match[1]] = value;
  }
  return fields;
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseArguments(argv) {
  let root = resolve(process.cwd());
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") root = resolve(argv[++index]);
    else if (argument === "--output") output = resolve(argv[++index]);
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node tools/generate-patches-manifest.mjs [--root REPO] [--output FILE]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { root, output: output ?? join(root, "extension", "patches.json") };
}

async function generate(root) {
  const documentsRoot = join(root, "documents");
  const directories = (await readdir(documentsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const documents = [];

  for (const directory of directories) {
    const documentRoot = join(documentsRoot, directory.name);
    const template = parseTemplate(await readFile(join(documentRoot, "template"), "utf8"));
    const patchesRoot = join(documentRoot, "patches");
    let patchEntries = [];
    try {
      patchEntries = (await readdir(patchesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && (entry.name.endsWith(".patch") || entry.name.endsWith(".py")))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const patches = [];
    for (const entry of patchEntries) {
      const content = await readFile(join(patchesRoot, entry.name), "utf8");
      const unified = entry.name.endsWith(".patch");
      patches.push({
        name: entry.name,
        type: unified ? "unified" : "python-script",
        supportedClientSide: unified,
        content,
      });
    }

    const id = slugify(directory.name) || slugify(template.title ?? directory.name);
    documents.push({
      id,
      title: String(template.title ?? directory.name).replace(/\s+/g, " ").trim(),
      author: template.author ?? "",
      revision: Number.parseInt(template.revision ?? "1", 10),
      url: template.url ?? "",
      urlPattern: template.url ?? "",
      patches,
    });
  }

  return {
    manifestVersion: 1,
    repository: "https://github.com/Eloitor/pdfpatches",
    rawBaseUrl: "https://raw.githubusercontent.com/Eloitor/pdfpatches/main/extension/patches.json",
    documents,
  };
}

const { root, output } = parseArguments(process.argv.slice(2));
const manifest = await generate(root);
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${output} (${manifest.documents.length} documents, ${manifest.documents.reduce((n, document) => n + document.patches.length, 0)} patches)`);
