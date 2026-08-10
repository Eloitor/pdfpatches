/*
 * Client-side unified-diff and PDF stream patching.
 *
 * The patches in this repository were authored against mutool's cleaned PDF.
 * An arXiv client normally has the original PDF instead: its content streams
 * are compressed and its object/xref layout is different.  The PDF functions
 * below therefore do a deliberately small, in-memory clean: decode Flate
 * streams, apply the hunk to the stream body, encode the changed streams, and
 * write a fresh classic xref table.
 */

export const DEFAULT_MAX_FUZZ = 2;

const textEncoder = new TextEncoder();
const latin1Decoder = new TextDecoder("iso-8859-1");
const asciiDecoder = new TextDecoder("ascii");

export class PatchApplyError extends Error {
  constructor(message, { code = "PATCH_APPLY_ERROR", hunkNumber = null, cause = null } = {}) {
    super(message, cause === null ? undefined : { cause });
    this.name = "PatchApplyError";
    this.code = code;
    this.hunkNumber = hunkNumber;
  }
}

function asBytes(value, label = "data") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${label} must be a Uint8Array or ArrayBuffer`);
}

function asciiBytes(value) {
  return textEncoder.encode(value);
}

function ascii(value) {
  return asciiDecoder.decode(value);
}

function latin1(value) {
  return latin1Decoder.decode(value);
}

function concatBytes(...parts) {
  const arrays = parts.map((part) => asBytes(part));
  const size = arrays.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of arrays) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function trimLineEnding(value) {
  let end = value.length;
  if (end > 0 && value[end - 1] === 10) end -= 1;
  if (end > 0 && value[end - 1] === 13) end -= 1;
  return value.slice(0, end);
}

function isLineEndingByte(value) {
  return value === 10 || value === 13;
}

function splitLines(data) {
  const bytes = asBytes(data);
  const lines = [];
  let start = 0;
  let index = 0;
  while (index < bytes.length) {
    if (bytes[index] === 10) {
      lines.push(bytes.slice(start, index + 1));
      start = index + 1;
      index += 1;
      continue;
    }
    if (bytes[index] === 13) {
      if (bytes[index + 1] === 10) {
        lines.push(bytes.slice(start, index + 2));
        start = index + 2;
        index += 2;
      } else {
        lines.push(bytes.slice(start, index + 1));
        start = index + 1;
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  if (start < bytes.length) lines.push(bytes.slice(start));
  return lines;
}

function parseHunkHeader(line) {
  const value = ascii(trimLineEnding(line));
  const match = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/.exec(value);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: Number.parseInt(match[2] ?? "1", 10),
    newStart: Number.parseInt(match[3], 10),
    newCount: Number.parseInt(match[4] ?? "1", 10),
  };
}

function removeOneLineEnding(value) {
  return trimLineEnding(value);
}

export function parseUnifiedDiff(patchData) {
  const bytes = asBytes(patchData, "patchData");
  const hunks = [];
  let current = null;
  let lastLine = null;

  const finish = () => {
    if (current !== null) hunks.push(current);
    current = null;
    lastLine = null;
  };

  for (const rawLine of splitLines(bytes)) {
    const header = parseHunkHeader(rawLine);
    if (header !== null) {
      finish();
      current = { ...header, lines: [] };
      continue;
    }

    if (current === null) continue;

    const kind = rawLine[0];
    if (kind === 32 || kind === 45 || kind === 43) {
      const line = { kind, text: rawLine.slice(1) };
      current.lines.push(line);
      lastLine = line;
      continue;
    }

    if (kind === 92) {
      if (lastLine !== null) lastLine.text = removeOneLineEnding(lastLine.text);
      continue;
    }

    // Metadata or malformed content after a hunk.  It is safer to stop this
    // hunk than to interpret arbitrary binary PDF data as diff lines.
    finish();
  }
  finish();
  return hunks;
}

function oldAndNew(lines) {
  const oldLines = [];
  const newLines = [];
  for (const line of lines) {
    if (line.kind !== 43) oldLines.push(line.text);
    if (line.kind !== 45) newLines.push(line.text);
  }
  return { oldLines, newLines };
}

function edgeContext(lines) {
  let leading = 0;
  while (leading < lines.length && lines[leading].kind === 32) leading += 1;
  let trailing = 0;
  while (
    trailing < lines.length - leading &&
    lines[lines.length - 1 - trailing].kind === 32
  ) {
    trailing += 1;
  }
  return { leading, trailing };
}

function* hunkVariants(hunk, maxFuzz) {
  const { leading, trailing } = edgeContext(hunk.lines);
  const yielded = new Set();

  for (let fuzz = 0; fuzz <= maxFuzz; fuzz += 1) {
    for (let left = 0; left <= Math.min(leading, fuzz); left += 1) {
      const right = fuzz - left;
      if (right < 0 || right > trailing) continue;
      const key = `${left}:${right}`;
      if (yielded.has(key)) continue;
      yielded.add(key);
      const end = right === 0 ? hunk.lines.length : hunk.lines.length - right;
      const selected = hunk.lines.slice(left, end);
      const { oldLines, newLines } = oldAndNew(selected);
      yield { fuzz, oldLines, newLines };
    }
  }

  // This also covers small insertion/deletion hunks when maxFuzz exceeds one
  // of their available context edges.
  for (let left = 0; left <= leading; left += 1) {
    for (let right = 0; right <= trailing; right += 1) {
      if (left + right > maxFuzz) continue;
      const key = `${left}:${right}`;
      if (yielded.has(key)) continue;
      yielded.add(key);
      const end = right === 0 ? hunk.lines.length : hunk.lines.length - right;
      const selected = hunk.lines.slice(left, end);
      const { oldLines, newLines } = oldAndNew(selected);
      yield { fuzz: left + right, oldLines, newLines };
    }
  }
}

function candidatePositions(targetLines, needle) {
  if (needle.length === 0) return [0];
  if (needle.length > targetLines.length) return [];
  const candidates = [];
  const first = needle[0];
  for (let index = 0; index <= targetLines.length - needle.length; index += 1) {
    if (!bytesEqual(targetLines[index], first)) continue;
    let matches = true;
    for (let line = 1; line < needle.length; line += 1) {
      if (!bytesEqual(targetLines[index + line], needle[line])) {
        matches = false;
        break;
      }
    }
    if (matches) candidates.push(index);
  }
  return candidates;
}

function chooseCandidate(candidates, hint, description, hunkNumber = null) {
  if (candidates.length === 0) {
    throw new PatchApplyError(description, {
      code: "PATCH_HUNK_NOT_FOUND",
      hunkNumber,
    });
  }
  if (candidates.length === 1) return candidates[0];

  const distances = candidates.map((candidate) => Math.abs(candidate - hint));
  const bestDistance = Math.min(...distances);
  const best = candidates.filter((candidate, index) => distances[index] === bestDistance);
  if (best.length !== 1) {
    const locations = candidates.slice(0, 8).map((candidate) => candidate + 1).join(", ");
    const suffix = candidates.length > 8 ? ", ..." : "";
    throw new PatchApplyError(
      `${description} (candidate lines: ${locations}${suffix})`,
      { code: "PATCH_AMBIGUOUS_CONTEXT", hunkNumber },
    );
  }
  return best[0];
}

function previewLine(lines) {
  if (lines.length === 0) return "<insertion>";
  return `${latin1(lines[0].slice(0, 120))}`;
}

function locateHunk(hunk, targetLines, maxFuzz, hint = Math.max(0, hunk.oldStart - 1)) {
  for (const variant of hunkVariants(hunk, maxFuzz)) {
    const candidates = candidatePositions(targetLines, variant.oldLines);
    if (candidates.length === 0) continue;
    const position = chooseCandidate(
      candidates,
      hint,
      `ambiguous hunk context`,
      null,
    );
    return { ...variant, position };
  }
  return null;
}

function applyHunkToLines(hunk, targetLines, maxFuzz, hint, hunkNumber) {
  for (const variant of hunkVariants(hunk, maxFuzz)) {
    const candidates = candidatePositions(targetLines, variant.oldLines);
    if (candidates.length === 0) continue;
    const position = chooseCandidate(
      candidates,
      hint,
      `hunk ${hunkNumber}: ambiguous hunk context`,
      hunkNumber,
    );
    const updated = targetLines.slice();
    updated.splice(position, variant.oldLines.length, ...variant.newLines);
    return {
      lines: updated,
      fuzz: variant.fuzz,
      fuzzLines: variant.fuzz,
    };
  }

  throw new PatchApplyError(
    `hunk ${hunkNumber} did not match the target (context starts ${previewLine(oldAndNew(hunk.lines).oldLines)})`,
    { code: "PATCH_HUNK_NOT_FOUND", hunkNumber },
  );
}

export function applyUnifiedDiff(
  patchData,
  targetData,
  { maxFuzz = DEFAULT_MAX_FUZZ } = {},
) {
  if (!Number.isInteger(maxFuzz) || maxFuzz < 0) {
    throw new RangeError("maxFuzz must be a non-negative integer");
  }
  const hunks = parseUnifiedDiff(patchData);
  const target = splitLines(targetData);
  let lines = target;
  let fuzzHunks = 0;
  let fuzzLines = 0;

  for (let index = 0; index < hunks.length; index += 1) {
    const result = applyHunkToLines(
      hunks[index],
      lines,
      maxFuzz,
      Math.max(0, hunks[index].oldStart - 1),
      index + 1,
    );
    lines = result.lines;
    if (result.fuzz > 0) {
      fuzzHunks += 1;
      fuzzLines += result.fuzzLines;
    }
  }

  return {
    data: concatBytes(...lines),
    result: {
      hunksApplied: hunks.length,
      fuzz: fuzzHunks > 0,
      fuzzHunks,
      fuzzLines,
      usedFuzz: fuzzHunks > 0,
    },
  };
}

export function applyPatch(patchData, targetData, options = {}) {
  return applyUnifiedDiff(patchData, targetData, options);
}

function findSequence(haystack, needle, from = 0, to = haystack.length) {
  const source = asBytes(haystack);
  const wanted = asBytes(needle);
  const limit = Math.min(to, source.length - wanted.length);
  if (wanted.length === 0) return Math.max(0, Math.min(from, source.length));
  for (let index = Math.max(0, from); index <= limit; index += 1) {
    let matches = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (source[index + offset] !== wanted[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function findLastSequence(haystack, needle, before = haystack.length) {
  const source = asBytes(haystack);
  const wanted = asBytes(needle);
  const start = Math.min(before, source.length - wanted.length);
  if (wanted.length === 0) return start;
  for (let index = start; index >= 0; index -= 1) {
    let matches = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (source[index + offset] !== wanted[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function skipWhitespace(bytes, start) {
  let index = start;
  while (index < bytes.length) {
    const value = bytes[index];
    if (value === 0 || value === 9 || value === 10 || value === 12 || value === 13 || value === 32) {
      index += 1;
    } else {
      break;
    }
  }
  return index;
}

function readLine(bytes, start) {
  let index = start;
  while (index < bytes.length && !isLineEndingByte(bytes[index])) index += 1;
  if (index >= bytes.length) return { line: bytes.slice(start), next: bytes.length };
  if (bytes[index] === 13 && bytes[index + 1] === 10) {
    return { line: bytes.slice(start, index + 2), next: index + 2 };
  }
  return { line: bytes.slice(start, index + 1), next: index + 1 };
}

function parseDecimal(bytes) {
  const value = ascii(bytes).trim();
  if (!/^\d+$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

function parseXrefEntries(pdfData, xrefOffset) {
  const bytes = asBytes(pdfData);
  const xrefWord = asciiBytes("xref");
  if (findSequence(bytes, xrefWord, xrefOffset, xrefOffset + 4) !== xrefOffset) {
    throw new PatchApplyError(
      "the PDF uses an xref stream; the lightweight client parser only supports classic xref tables",
      { code: "PDF_XREF_UNSUPPORTED" },
    );
  }

  let cursor = xrefOffset + xrefWord.length;
  const entries = [];
  let trailerOffset = -1;
  while (cursor < bytes.length) {
    cursor = skipWhitespace(bytes, cursor);
    const lineInfo = readLine(bytes, cursor);
    const line = ascii(trimLineEnding(lineInfo.line)).trim();
    cursor = lineInfo.next;
    if (line === "trailer") {
      trailerOffset = lineInfo.next;
      break;
    }
    const subsection = /^(\d+)\s+(\d+)$/.exec(line);
    if (!subsection) {
      throw new PatchApplyError(`invalid xref subsection near offset ${cursor}`, {
        code: "PDF_XREF_INVALID",
      });
    }
    const firstObject = Number.parseInt(subsection[1], 10);
    const count = Number.parseInt(subsection[2], 10);
    for (let index = 0; index < count; index += 1) {
      const entryInfo = readLine(bytes, cursor);
      const fields = ascii(trimLineEnding(entryInfo.line)).trim().split(/\s+/);
      cursor = entryInfo.next;
      if (fields.length < 3 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) {
        throw new PatchApplyError(`invalid xref entry for object ${firstObject + index}`, {
          code: "PDF_XREF_INVALID",
        });
      }
      entries.push({
        number: firstObject + index,
        offset: Number.parseInt(fields[0], 10),
        generation: Number.parseInt(fields[1], 10),
        free: fields[2] !== "n",
      });
    }
  }

  if (trailerOffset < 0) {
    throw new PatchApplyError("PDF xref table has no trailer", { code: "PDF_XREF_INVALID" });
  }
  return { entries, trailerOffset };
}

function findTrailerDictionary(pdfData, trailerOffset, startxrefOffset) {
  const bytes = asBytes(pdfData);
  const start = findSequence(bytes, asciiBytes("<<"), trailerOffset, startxrefOffset);
  const end = findSequence(bytes, asciiBytes(">>"), start + 2, startxrefOffset);
  if (start < 0 || end < 0) {
    throw new PatchApplyError("could not read the PDF trailer dictionary", {
      code: "PDF_TRAILER_INVALID",
    });
  }
  return bytes.slice(start, end + 2);
}

function findStartxref(bytes) {
  const marker = asciiBytes("startxref");
  const position = findLastSequence(bytes, marker);
  if (position < 0) {
    throw new PatchApplyError("PDF has no startxref marker", { code: "PDF_XREF_INVALID" });
  }
  const numberStart = skipWhitespace(bytes, position + marker.length);
  const line = readLine(bytes, numberStart);
  const offset = parseDecimal(line.line);
  if (offset === null || offset < 0 || offset >= bytes.length) {
    throw new PatchApplyError("PDF startxref is not a valid offset", { code: "PDF_XREF_INVALID" });
  }
  return { offset, marker: position };
}

function tokenBoundary(bytes, position, length) {
  const before = position > 0 ? bytes[position - 1] : 32;
  const after = position + length < bytes.length ? bytes[position + length] : 32;
  const delimiter = (value) =>
    value === 0 || value === 9 || value === 10 || value === 12 || value === 13 || value === 32 ||
    value === 40 || value === 41 || value === 60 || value === 62 || value === 91 || value === 93 ||
    value === 123 || value === 125 || value === 47 || value === 37;
  return delimiter(before) && delimiter(after);
}

function findToken(bytes, token, from = 0, to = bytes.length) {
  const wanted = asciiBytes(token);
  let cursor = from;
  while (cursor < to) {
    const position = findSequence(bytes, wanted, cursor, to);
    if (position < 0) return -1;
    if (tokenBoundary(bytes, position, wanted.length)) return position;
    cursor = position + 1;
  }
  return -1;
}

function directLengthField(objectBytes, streamPosition) {
  const prefix = ascii(objectBytes.slice(0, streamPosition));
  const regex = /\/Length\b\s+(\d+)(?:\s+(\d+)\s+R\b)?/g;
  let match = null;
  for (const candidate of prefix.matchAll(regex)) match = candidate;
  if (match === null) return null;
  const first = match[1];
  const digitsStart = match.index + match[0].lastIndexOf(first);
  if (match[2] !== undefined) {
    return {
      start: digitsStart,
      end: digitsStart + first.length,
      length: null,
      reference: {
        number: Number.parseInt(first, 10),
        generation: Number.parseInt(match[2], 10),
      },
    };
  }
  return { start: digitsStart, end: digitsStart + first.length, length: Number.parseInt(first, 10), reference: null };
}

function detectStream(objectBytes) {
  const dictionaryEnd = findSequence(objectBytes, asciiBytes(">>"));
  if (dictionaryEnd < 0) return null;
  const streamPosition = findToken(objectBytes, "stream", dictionaryEnd + 2);
  if (streamPosition < 0) return null;
  const lengthField = directLengthField(objectBytes, streamPosition);
  if (lengthField === null) return null;
  let dataStart = streamPosition + 6;
  if (objectBytes[dataStart] === 13 && objectBytes[dataStart + 1] === 10) dataStart += 2;
  else if (objectBytes[dataStart] === 10 || objectBytes[dataStart] === 13) dataStart += 1;
  else {
    throw new PatchApplyError("PDF stream is not separated from its dictionary by an EOL", {
      code: "PDF_STREAM_INVALID",
    });
  }
  const dictionary = ascii(objectBytes.slice(0, streamPosition));
  const flate = /\/FlateDecode\b/.test(dictionary);
  if (lengthField.length === null) {
    return {
      streamPosition,
      dataStart,
      dataEnd: null,
      rawLength: null,
      lengthStart: lengthField.start,
      lengthEnd: lengthField.end,
      lengthReference: lengthField.reference,
      flate,
    };
  }
  const dataEnd = dataStart + lengthField.length;
  if (dataEnd > objectBytes.length) {
    throw new PatchApplyError("PDF stream length extends beyond its object", {
      code: "PDF_STREAM_INVALID",
    });
  }
  return {
    streamPosition,
    dataStart,
    dataEnd,
    rawLength: lengthField.length,
    lengthStart: lengthField.start,
    lengthEnd: lengthField.end,
    lengthReference: null,
    flate,
  };
}

async function transformStream(data, mode) {
  const bytes = asBytes(data);
  const Transform = mode === "decompress" ? globalThis.DecompressionStream : globalThis.CompressionStream;
  if (typeof Transform !== "function") {
    throw new PatchApplyError(`${mode}ion requires DecompressionStream/CompressionStream`, {
      code: "PDF_FLATE_UNAVAILABLE",
    });
  }
  try {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const transformed = source.pipeThrough(new Transform("deflate"));
    return new Uint8Array(await new Response(transformed).arrayBuffer());
  } catch (error) {
    throw new PatchApplyError(`could not ${mode} FlateDecode stream: ${error.message}`, {
      code: mode === "decompress" ? "PDF_STREAM_DECOMPRESS" : "PDF_STREAM_COMPRESS",
      cause: error,
    });
  }
}

export const decompressFlate = (data) => transformStream(data, "decompress");
export const compressFlate = (data) => transformStream(data, "compress");

async function parsePdfObjects(pdfData) {
  const bytes = asBytes(pdfData, "pdfData");
  const startxref = findStartxref(bytes);
  const xref = parseXrefEntries(bytes, startxref.offset);
  const trailerDictionary = findTrailerDictionary(bytes, xref.trailerOffset, startxref.marker);
  const inUse = xref.entries
    .filter((entry) => !entry.free && entry.offset > 0)
    .sort((left, right) => left.offset - right.offset);
  const records = [];
  const seenOffsets = new Set();

  for (let index = 0; index < inUse.length; index += 1) {
    const entry = inUse[index];
    if (seenOffsets.has(entry.offset)) continue;
    seenOffsets.add(entry.offset);
    const nextOffset = index + 1 < inUse.length ? inUse[index + 1].offset : startxref.offset;
    if (nextOffset <= entry.offset || nextOffset > bytes.length) {
      throw new PatchApplyError(`invalid object offset for ${entry.number} ${entry.generation} R`, {
        code: "PDF_OBJECT_INVALID",
      });
    }
    const chunk = bytes.slice(entry.offset, nextOffset);
    const endobj = findToken(chunk, "endobj");
    if (endobj < 0) {
      throw new PatchApplyError(`object ${entry.number} ${entry.generation} has no endobj`, {
        code: "PDF_OBJECT_INVALID",
      });
    }
    const objectBytes = chunk.slice(0, endobj + 6);
    const stream = detectStream(objectBytes);
    const record = {
      number: entry.number,
      generation: entry.generation,
      offset: entry.offset,
      objectBytes,
      stream,
      data: null,
      modified: false,
    };
    records.push(record);
  }

  const recordsByReference = new Map(
    records.map((record) => [`${record.number}:${record.generation}`, record]),
  );
  for (const record of records) {
    if (record.stream === null) continue;
    if (record.stream.lengthReference !== null) {
      const lengthRecord = recordsByReference.get(
        `${record.stream.lengthReference.number}:${record.stream.lengthReference.generation}`,
      );
      if (lengthRecord === undefined) {
        throw new PatchApplyError(
          `stream object ${record.number} refers to missing /Length ${record.stream.lengthReference.number} ${record.stream.lengthReference.generation} R`,
          { code: "PDF_STREAM_INVALID" },
        );
      }
      const bodyStart = findToken(lengthRecord.objectBytes, "obj") + 3;
      const body = ascii(lengthRecord.objectBytes.slice(bodyStart));
      const value = /^\s*(\d+)\b/.exec(body);
      if (value === null) {
        throw new PatchApplyError(`could not resolve /Length for stream object ${record.number}`, {
          code: "PDF_STREAM_INVALID",
        });
      }
      record.stream.lengthRecord = lengthRecord;
      record.stream.rawLength = Number.parseInt(value[1], 10);
      record.stream.dataEnd = record.stream.dataStart + record.stream.rawLength;
    }
    if (record.stream.dataEnd > record.objectBytes.length) {
      throw new PatchApplyError(`PDF stream object ${record.number} length is invalid`, {
        code: "PDF_STREAM_INVALID",
      });
    }
    if (record.stream.flate) {
      record.data = await decompressFlate(
        record.objectBytes.slice(record.stream.dataStart, record.stream.dataEnd),
      );
    }
  }

  return {
    bytes,
    records,
    entries: xref.entries,
    size: Math.max(...xref.entries.map((entry) => entry.number + 1), 1),
    trailerDictionary,
    xrefOffset: startxref.offset,
  };
}

function isBlankContextLine(line) {
  return line.kind === 32 && trimLineEnding(line.text).length === 0;
}

function streamHunk(hunk) {
  const lines = hunk.lines;
  const streamIndex = lines.findIndex(
    (line) => line.kind === 32 && ascii(trimLineEnding(line.text)).trim() === "stream",
  );
  const endstreamIndex = lines.findIndex(
    (line) => line.kind === 32 && ascii(trimLineEnding(line.text)).trim() === "endstream",
  );
  let selected;
  let wrapped = false;
  if (streamIndex >= 0 && endstreamIndex > streamIndex) {
    selected = lines.slice(streamIndex + 1, endstreamIndex);
    wrapped = true;
  } else if (endstreamIndex >= 0) {
    selected = lines.slice(0, endstreamIndex);
    wrapped = true;
  } else {
    selected = lines.slice();
  }

  if (wrapped) {
    while (
      selected.length > 0 &&
      selected[selected.length - 1].kind === 32 &&
      ["endobj", "endstream"].includes(ascii(trimLineEnding(selected[selected.length - 1].text)).trim())
    ) {
      selected.pop();
    }
    // mutool writes an empty separator line before endstream.  It is outside
    // the decoded stream in the raw PDF, so do not make it consume fuzz.
    if (selected.length > 0 && isBlankContextLine(selected[selected.length - 1])) {
      selected.pop();
    }
  }

  if (selected.length === 0) return null;
  return { ...hunk, oldStart: 1, lines: selected };
}

function locateStreamHunk(hunk, targetLines, maxFuzz) {
  for (const variant of hunkVariants(hunk, maxFuzz)) {
    const candidates = candidatePositions(targetLines, variant.oldLines);
    if (candidates.length === 0) continue;
    const position = chooseCandidate(
      candidates,
      0,
      "ambiguous stream hunk context",
      null,
    );
    return { ...variant, position };
  }
  return null;
}

function patchErrorForStream(hunkNumber, hunk) {
  return new PatchApplyError(
    `hunk ${hunkNumber} did not match any decoded Flate stream (context starts ${previewLine(oldAndNew(hunk.lines).oldLines)})`,
    { code: "PDF_STREAM_HUNK_NOT_FOUND", hunkNumber },
  );
}

async function applyPatchToStreams(pdf, patchData, maxFuzz, patchName = "patch") {
  const hunks = parseUnifiedDiff(patchData);
  const result = {
    name: patchName,
    hunksApplied: 0,
    fuzz: false,
    fuzzHunks: 0,
    fuzzLines: 0,
    streamMatches: [],
  };
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const originalHunk = hunks[hunkIndex];
    const hunk = streamHunk(originalHunk);
    if (hunk === null) {
      throw patchErrorForStream(hunkIndex + 1, originalHunk);
    }
    let match = null;
    for (const record of pdf.records) {
      if (record.data === null) continue;
      const targetLines = splitLines(record.data);
      const located = locateStreamHunk(hunk, targetLines, maxFuzz);
      if (located === null) continue;
      if (match !== null) {
        throw new PatchApplyError(
          `hunk ${hunkIndex + 1} matched multiple PDF streams (${match.record.number} and ${record.number})`,
          { code: "PDF_STREAM_AMBIGUOUS", hunkNumber: hunkIndex + 1 },
        );
      }
      match = { record, targetLines, located };
    }
    if (match === null) throw patchErrorForStream(hunkIndex + 1, hunk);

    const { record, targetLines, located } = match;
    targetLines.splice(located.position, located.oldLines.length, ...located.newLines);
    record.data = concatBytes(...targetLines);
    record.modified = true;
    result.hunksApplied += 1;
    result.streamMatches.push({ object: record.number, fuzz: located.fuzz });
    if (located.fuzz > 0) {
      result.fuzz = true;
      result.fuzzHunks += 1;
      result.fuzzLines += located.fuzz;
    }
  }
  return result;
}

function replaceBytes(data, start, end, replacement) {
  return concatBytes(data.slice(0, start), replacement, data.slice(end));
}

async function rewriteModifiedStreams(records) {
  const encodedByRecord = new Map();
  for (const record of records) {
    if (record.stream === null || !record.modified || record.data === null) continue;
    encodedByRecord.set(record, await compressFlate(record.data));
  }

  const indirectLengths = new Map();
  for (const [record, encoded] of encodedByRecord) {
    const stream = record.stream;
    if (stream.lengthReference !== null && stream.lengthRecord !== undefined) {
      indirectLengths.set(stream.lengthRecord, encoded.length);
    }
  }

  const objectBytesByRecord = new Map();
  for (const record of records) {
    let objectBytes = record.objectBytes;
    const stream = record.stream;
    const encoded = encodedByRecord.get(record);
    if (stream !== null && encoded !== undefined) {
      if (stream.lengthReference === null) {
        const lengthText = asciiBytes(String(encoded.length));
        objectBytes = replaceBytes(objectBytes, stream.lengthStart, stream.lengthEnd, lengthText);
        const lengthDelta = lengthText.length - (stream.lengthEnd - stream.lengthStart);
        const dataStart = stream.dataStart + lengthDelta;
        objectBytes = replaceBytes(objectBytes, dataStart, dataStart + stream.rawLength, encoded);
      } else {
        objectBytes = replaceBytes(objectBytes, stream.dataStart, stream.dataEnd, encoded);
      }
    }

    const indirectLength = indirectLengths.get(record);
    if (indirectLength !== undefined) {
      const objectStart = findToken(objectBytes, "obj");
      if (objectStart < 0) {
        throw new PatchApplyError(`could not update indirect /Length object ${record.number}`, {
          code: "PDF_STREAM_INVALID",
        });
      }
      const bodyStart = objectStart + 3;
      const body = ascii(objectBytes.slice(bodyStart));
      const value = /^(\s*)(\d+)(\b)/.exec(body);
      if (value === null) {
        throw new PatchApplyError(`could not update indirect /Length object ${record.number}`, {
          code: "PDF_STREAM_INVALID",
        });
      }
      const digitsStart = bodyStart + value[1].length;
      objectBytes = replaceBytes(
        objectBytes,
        digitsStart,
        digitsStart + value[2].length,
        asciiBytes(String(indirectLength)),
      );
    }
    objectBytesByRecord.set(record, objectBytes);
  }
  return objectBytesByRecord;
}

function updateTrailerSize(trailerDictionary, size) {
  const trailer = asBytes(trailerDictionary);
  const value = ascii(trailer);
  const match = /\/Size\b\s+\d+/.exec(value);
  if (match !== null) {
    const numberStart = match.index + match[0].length - match[0].match(/\d+$/)[0].length;
    return replaceBytes(trailer, numberStart, numberStart + match[0].match(/\d+$/)[0].length, asciiBytes(String(size)));
  }
  const close = findSequence(trailer, asciiBytes(">>"));
  if (close < 0) throw new PatchApplyError("could not update PDF trailer size", { code: "PDF_TRAILER_INVALID" });
  return concatBytes(trailer.slice(0, close), asciiBytes(`/Size ${size}\n`), trailer.slice(close));
}

function formatXrefEntry(offset, generation, free = false) {
  if (offset > 9_999_999_999) {
    throw new PatchApplyError("PDF is too large for a classic xref table", { code: "PDF_XREF_INVALID" });
  }
  const offsetText = String(offset).padStart(10, "0");
  const generationText = String(free ? generation : generation).padStart(5, "0");
  return asciiBytes(`${offsetText} ${generationText} ${free ? "f" : "n"} \n`);
}

async function rebuildPdf(pdf) {
  const objectBytesByRecord = await rewriteModifiedStreams(pdf.records);
  const byNumber = new Map(
    pdf.records.map((record) => [
      record.number,
      { record, objectBytes: objectBytesByRecord.get(record) ?? record.objectBytes },
    ]),
  );
  const maxObject = Math.max(pdf.size - 1, ...pdf.entries.map((entry) => entry.number));
  const firstOffset = Math.min(...pdf.records.map((record) => record.offset));
  const chunks = [pdf.bytes.slice(0, firstOffset)];
  let outputLength = chunks[0].length;
  const offsets = new Map();

  for (let number = 1; number <= maxObject; number += 1) {
    const item = byNumber.get(number);
    if (item === undefined) continue;
    offsets.set(number, outputLength);
    chunks.push(item.objectBytes, asciiBytes("\n"));
    outputLength += item.objectBytes.length + 1;
  }

  const xrefOffset = outputLength;
  chunks.push(asciiBytes(`xref\n0 ${maxObject + 1}\n`));
  chunks.push(formatXrefEntry(0, 65535, true));
  for (let number = 1; number <= maxObject; number += 1) {
    const item = byNumber.get(number);
    if (item === undefined) {
      chunks.push(formatXrefEntry(0, 0, true));
    } else {
      chunks.push(formatXrefEntry(offsets.get(number), item.record.generation, false));
    }
  }
  chunks.push(asciiBytes("trailer\n"));
  chunks.push(updateTrailerSize(pdf.trailerDictionary, maxObject + 1));
  chunks.push(asciiBytes(`\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return concatBytes(...chunks);
}

function patchEntryBytes(entry) {
  if (entry instanceof Uint8Array || entry instanceof ArrayBuffer || ArrayBuffer.isView(entry)) {
    return asBytes(entry, "patch");
  }
  if (entry && entry.data !== undefined) return asBytes(entry.data, "patch.data");
  if (entry && entry.content !== undefined) return asBytes(entry.content, "patch.content");
  throw new TypeError("each patch must be bytes or an object with data/content bytes");
}

/**
 * Apply unified patches to a PDF in memory.
 *
 * Clean/uncompressed PDFs use the direct byte patcher.  If that fails, the
 * input is treated as a raw classic-xref PDF and hunks are matched against
 * decoded Flate stream bodies before the PDF is rebuilt.
 */
export async function applyPdfPatches(
  pdfData,
  patches,
  { maxFuzz = DEFAULT_MAX_FUZZ } = {},
) {
  if (!Array.isArray(patches)) throw new TypeError("patches must be an array");
  const input = asBytes(pdfData, "pdfData");
  const patchBytes = patches.map(patchEntryBytes);
  if (patchBytes.length === 0) {
    return { data: input.slice(), strategy: "none", results: [] };
  }

  // Keep the normal cleaned-PDF path byte-for-byte compatible with the
  // Python reference implementation.
  try {
    let current = input.slice();
    const results = [];
    for (let index = 0; index < patchBytes.length; index += 1) {
      const applied = applyUnifiedDiff(patchBytes[index], current, { maxFuzz });
      current = applied.data;
      results.push({ name: patches[index]?.name ?? `patch-${index + 1}`, ...applied.result });
    }
    return { data: current, strategy: "whole-file", results };
  } catch (wholeFileError) {
    // The raw-stream path below gives a more useful error if the PDF is not a
    // supported classic-xref/Flate file.  Keep the original failure as cause.
    let parsed;
    try {
      parsed = await parsePdfObjects(input);
    } catch (parseError) {
      if (parseError instanceof PatchApplyError) {
        parseError.cause = wholeFileError;
        throw parseError;
      }
      throw parseError;
    }

    const results = [];
    try {
      for (let index = 0; index < patchBytes.length; index += 1) {
        results.push(
          await applyPatchToStreams(
            parsed,
            patchBytes[index],
            maxFuzz,
            patches[index]?.name ?? `patch-${index + 1}`,
          ),
        );
      }
    } catch (error) {
      if (error instanceof PatchApplyError) {
        error.cause = wholeFileError;
      }
      throw error;
    }
    return { data: await rebuildPdf(parsed), strategy: "decoded-streams", results };
  }
}

export const patchPdf = applyPdfPatches;

export const __internal = {
  splitLines,
  hunkVariants,
  streamHunk,
  parsePdfObjects,
  rebuildPdf,
  findSequence,
  detectStream,
};
