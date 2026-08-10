#!/usr/bin/env python3
"""Apply a unified diff without depending on the ``patch`` executable.

The files handled by this module are deliberately kept as bytes.  A cleaned
PDF is a binary file even when most of its contents happen to look like text,
so decoding it (or applying a patch stream-by-stream) is unsafe.  Hunks are
located by their context; the line numbers in an ``@@`` header are only used
to disambiguate repeated context and are never required to be correct.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


# Keeping this small is intentional.  It catches a shifted hunk while still
# allowing the harmless offsets commonly introduced by cleaning a PDF again.
DEFAULT_MAX_FUZZ = 2


class PatchApplyError(RuntimeError):
    """Raised when a hunk cannot be located unambiguously."""


@dataclass
class HunkLine:
    kind: bytes
    text: bytes


@dataclass
class Hunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    lines: list[HunkLine]


@dataclass(frozen=True)
class ApplyResult:
    """Summary returned after applying a patch."""

    hunks_applied: int
    fuzz: bool = False
    fuzz_hunks: int = 0
    fuzz_lines: int = 0

    @property
    def used_fuzz(self) -> bool:
        """Readable alias for callers that prefer a longer attribute name."""

        return self.fuzz


_HUNK_RE = re.compile(
    rb"^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(?:.*)$"
)


def _split_lines(value: bytes) -> list[bytes]:
    """Split on LF only, retaining every byte in the file.

    ``bytes.splitlines`` also treats form-feed and several ASCII control
    characters as line separators.  Those bytes are valid inside a PDF
    content stream, so using it would not be bytes-safe.
    """

    if not value:
        return []
    lines: list[bytes] = []
    start = 0
    while True:
        end = value.find(b"\n", start)
        if end < 0:
            if start < len(value):
                lines.append(value[start:])
            break
        lines.append(value[start : end + 1])
        start = end + 1
        if start == len(value):
            break
    return lines


def _without_line_ending(value: bytes) -> bytes:
    """Remove one CR/LF ending from a patch payload."""

    if value.endswith(b"\n"):
        value = value[:-1]
        if value.endswith(b"\r"):
            value = value[:-1]
    return value


def _parse_hunk_header(line: bytes) -> tuple[int, int, int, int] | None:
    match = _HUNK_RE.match(line.rstrip(b"\r\n"))
    if match is None:
        return None
    old_start = int(match.group(1))
    old_count = int(match.group(2) or b"1")
    new_start = int(match.group(3))
    new_count = int(match.group(4) or b"1")
    return old_start, old_count, new_start, new_count


def parse_unified_diff(patch_data: bytes) -> list[Hunk]:
    """Parse hunks from *patch_data* without decoding it.

    Git headers (``diff --git``, ``---`` and ``+++``) are ignored.  This also
    accepts the compact patches used by the Greenberg document, which start
    directly with an ``@@`` header.
    """

    hunks: list[Hunk] = []
    current: Hunk | None = None
    last_line: HunkLine | None = None

    def finish() -> None:
        nonlocal current, last_line
        if current is not None:
            hunks.append(current)
        current = None
        last_line = None

    for raw_line in _split_lines(patch_data):
        header = _parse_hunk_header(raw_line)
        if header is not None:
            finish()
            current = Hunk(*header, lines=[])
            continue

        if current is None:
            # Diff metadata and any text before the first hunk.
            continue

        if raw_line.startswith((b" ", b"-", b"+")):
            line = HunkLine(raw_line[:1], raw_line[1:])
            current.lines.append(line)
            last_line = line
            continue

        if raw_line.startswith(b"\\"):
            # GNU diff writes this marker after a line that has no final
            # newline.  The marker itself is not part of the hunk.
            if last_line is not None:
                last_line.text = _without_line_ending(last_line.text)
            continue

        # A non-hunk line starts the next header/metadata section.  It is
        # unusual inside a valid hunk, but ignoring it is safer for PDFs than
        # interpreting arbitrary binary data as a diff line.
        finish()

    finish()
    return hunks


def _old_and_new(lines: Sequence[HunkLine]) -> tuple[list[bytes], list[bytes]]:
    old: list[bytes] = []
    new: list[bytes] = []
    for line in lines:
        if line.kind != b"+":
            old.append(line.text)
        if line.kind != b"-":
            new.append(line.text)
    return old, new


def _edge_context(lines: Sequence[HunkLine]) -> tuple[int, int]:
    leading = 0
    while leading < len(lines) and lines[leading].kind == b" ":
        leading += 1

    trailing = 0
    while trailing < len(lines) - leading and lines[len(lines) - 1 - trailing].kind == b" ":
        trailing += 1
    return leading, trailing


def _candidate_positions(
    target: Sequence[bytes], needle: Sequence[bytes], hint: int
) -> list[int]:
    """Return all exact positions for *needle* in *target*.

    The first-line check avoids constructing a slice for every line in a
    large PDF.  Empty needles are only meaningful for insertion hunks, where
    the header is the sole useful hint.
    """

    if not needle:
        return [max(0, min(hint, len(target)))]

    length = len(needle)
    first = needle[0]
    candidates: list[int] = []
    last = len(target) - length
    if last < 0:
        return candidates
    for index in range(last + 1):
        if target[index] == first and list(target[index : index + length]) == list(needle):
            candidates.append(index)
    return candidates


def _choose_candidate(candidates: Sequence[int], hint: int, description: str) -> int:
    if not candidates:
        raise PatchApplyError(description)
    if len(candidates) == 1:
        return candidates[0]

    # Context, rather than the header, selected these candidates.  The header
    # is useful only to choose between genuinely repeated contexts.  For a
    # hunk after an earlier edit this is an approximate position, which is
    # precisely why it is not used as the match itself.
    distances = [abs(candidate - hint) for candidate in candidates]
    best_distance = min(distances)
    best = [candidate for candidate, distance in zip(candidates, distances) if distance == best_distance]
    if len(best) != 1:
        locations = ", ".join(str(candidate + 1) for candidate in candidates[:8])
        if len(candidates) > 8:
            locations += ", ..."
        raise PatchApplyError(f"ambiguous hunk context (candidate lines: {locations})")
    return best[0]


def _variants(
    hunk: Hunk, max_fuzz: int
) -> Iterable[tuple[int, list[bytes], list[bytes]]]:
    """Yield exact and edge-context-fuzz variants in preference order."""

    lines = hunk.lines
    leading, trailing = _edge_context(lines)
    yielded: set[tuple[int, int]] = set()

    for fuzz in range(max_fuzz + 1):
        for left in range(min(leading, fuzz) + 1):
            right = fuzz - left
            if right < 0 or right > trailing:
                continue
            key = (left, right)
            if key in yielded:
                continue
            yielded.add(key)
            selected = lines[left : len(lines) - right if right else len(lines)]
            old, new = _old_and_new(selected)
            yield fuzz, old, new

    # If max_fuzz is larger than the available edge context, the loop above
    # may not have yielded every useful combination with a total *up to* the
    # limit.  The following is mostly relevant to tiny hand-written hunks.
    for left in range(leading + 1):
        for right in range(trailing + 1):
            if left + right > max_fuzz or (left, right) in yielded:
                continue
            selected = lines[left : len(lines) - right if right else len(lines)]
            old, new = _old_and_new(selected)
            yield left + right, old, new


def apply_unified_diff(
    patch_data: bytes, target_data: bytes, *, max_fuzz: int = DEFAULT_MAX_FUZZ
) -> tuple[bytes, ApplyResult]:
    """Apply a unified diff to bytes and return ``(new_bytes, summary)``.

    Hunk matching is global and content based.  A hunk's numeric location is
    used only as a tie-breaker for repeated context.  At most ``max_fuzz``
    leading/trailing context lines may be ignored when an exact match is not
    found.
    """

    if max_fuzz < 0:
        raise ValueError("max_fuzz must be non-negative")

    hunks = parse_unified_diff(patch_data)
    target = _split_lines(target_data)
    applied = 0
    fuzz_hunks = 0
    fuzz_lines = 0

    for hunk_number, hunk in enumerate(hunks, start=1):
        # Unified-diff line numbers are one-based.  A zero old start denotes
        # the conventional insertion-before-first-line case.
        hint = max(0, hunk.old_start - 1)
        selected_index: int | None = None
        selected_old: list[bytes] | None = None
        selected_new: list[bytes] | None = None
        selected_fuzz = 0

        for fuzz, old, new in _variants(hunk, max_fuzz):
            candidates = _candidate_positions(target, old, hint)
            if not candidates:
                continue
            selected_index = _choose_candidate(
                candidates,
                hint,
                f"hunk {hunk_number}: ambiguous hunk context",
            )
            selected_old = old
            selected_new = new
            selected_fuzz = fuzz
            break

        if selected_index is None or selected_old is None or selected_new is None:
            old, _ = _old_and_new(hunk.lines)
            preview = old[0][:120] if old else b"<insertion>"
            raise PatchApplyError(
                f"hunk {hunk_number} did not match the target (context starts {preview!r})"
            )

        end = selected_index + len(selected_old)
        target[selected_index:end] = selected_new
        applied += 1
        if selected_fuzz:
            fuzz_hunks += 1
            fuzz_lines += selected_fuzz

    return b"".join(target), ApplyResult(
        hunks_applied=applied,
        fuzz=bool(fuzz_hunks),
        fuzz_hunks=fuzz_hunks,
        fuzz_lines=fuzz_lines,
    )


def _atomic_write(path: Path, data: bytes) -> None:
    path = path.resolve()
    mode: int | None = None
    try:
        mode = path.stat().st_mode
    except FileNotFoundError:
        pass

    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        if mode is not None:
            os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def apply_patch_file(
    patch_file: str | os.PathLike[str],
    target_file: str | os.PathLike[str],
    *,
    max_fuzz: int = DEFAULT_MAX_FUZZ,
) -> ApplyResult:
    """Apply *patch_file* in place to *target_file* and return its summary."""

    patch_path = Path(patch_file)
    target_path = Path(target_file)
    new_data, result = apply_unified_diff(
        patch_path.read_bytes(), target_path.read_bytes(), max_fuzz=max_fuzz
    )
    _atomic_write(target_path, new_data)
    return result


# This short name is convenient for callers and keeps the command-line API
# obvious.  It intentionally returns the summary, while the file is updated
# in place as a normal patch command would do.
def apply_patch(
    patch_file: str | os.PathLike[str],
    target_file: str | os.PathLike[str],
    *,
    max_fuzz: int = DEFAULT_MAX_FUZZ,
) -> ApplyResult:
    return apply_patch_file(patch_file, target_file, max_fuzz=max_fuzz)


def _format_result(result: ApplyResult) -> str:
    suffix = " with fuzz" if result.fuzz else ""
    return f"applied {result.hunks_applied} hunk(s){suffix}"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("patchfile", help="unified diff to apply")
    parser.add_argument("file", help="target file, updated in place")
    parser.add_argument(
        "--max-fuzz",
        type=int,
        default=DEFAULT_MAX_FUZZ,
        help=f"maximum ignored edge-context lines (default: {DEFAULT_MAX_FUZZ})",
    )
    args = parser.parse_args(argv)

    try:
        result = apply_patch_file(args.patchfile, args.file, max_fuzz=args.max_fuzz)
    except (OSError, PatchApplyError, ValueError) as error:
        print(f"apply_patch: {error}", file=sys.stderr)
        return 1

    print(_format_result(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
