#!/usr/bin/env python3
"""Render and verify the visual effect of every document patch.

Usage::

    python3 common/visual_diff.py DOCUMENT BEFORE.pdf OUTDIR [--dpi 150]

``DOCUMENT`` is the document directory.  Unified ``*.patch`` files and a
``patch.py`` in its ``patches`` directory (or in the document directory) are
applied in lexical order.  A patch is rendered against the result of the
previous patch, so the visual report follows the real pipeline.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:  # Works both as ``python common/visual_diff.py`` and as a module.
    from .apply_patch import ApplyResult, apply_patch_file
except ImportError:  # pragma: no cover - exercised by the CLI invocation.
    from apply_patch import ApplyResult, apply_patch_file

try:
    import pymupdf
except ImportError:  # Older installations expose the same API as ``fitz``.
    import fitz as pymupdf  # type: ignore[no-redef]


DEFAULT_DPI = 150.0
DIFF_THRESHOLD = 12
CROP_MARGIN_POINTS = 24.0


@dataclass(frozen=True)
class Box:
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    label: str | None = None

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "page": self.page,
            "x0": _rounded(self.x0),
            "y0": _rounded(self.y0),
            "x1": _rounded(self.x1),
            "y1": _rounded(self.y1),
        }
        if self.label is not None:
            result["label"] = self.label
        return result


@dataclass
class RenderedPage:
    pixels: np.ndarray
    width_points: float
    height_points: float


@dataclass
class PageComparison:
    page: int
    pixels_before: np.ndarray
    pixels_after: np.ndarray
    mask: np.ndarray
    outside_mask: np.ndarray
    width_points: float
    height_points: float
    scale_x: float
    scale_y: float
    diff_bbox: dict[str, Any] | None
    outside_bbox: dict[str, Any] | None
    diff_pixels: int
    outside_pixels: int


@dataclass
class PatchComparison:
    name: str
    relative_path: str
    kind: str
    boxes: list[Box]
    configured: bool
    apply_result: ApplyResult | None
    pages: list[PageComparison]
    warnings: list[str]
    images: list[str]
    status: str


def _rounded(value: float) -> float | int:
    rounded = round(float(value), 3)
    if rounded == int(rounded):
        return int(rounded)
    return rounded


def _patch_files(document_dir: Path) -> list[Path]:
    """Return all supported patch files in one deterministic order."""

    patch_dir = document_dir / "patches"
    files: list[Path] = []
    if patch_dir.is_dir():
        for path in patch_dir.iterdir():
            if path.is_file() and (path.name == "patch.py" or path.suffix == ".patch"):
                files.append(path)

    # Zhang's initial pikepdf patch lives at document root.  Supporting this
    # location also keeps the CLI useful for existing documents while the
    # normal convention remains patches/patch.py.
    root_patch = document_dir / "patch.py"
    if root_patch.is_file():
        files.append(root_patch)

    return sorted(files, key=lambda path: path.relative_to(document_dir).as_posix())


def _load_config(document_dir: Path) -> tuple[dict[str, Any], Path | None]:
    config_path = document_dir / "patches" / "visualdiff.json"
    if not config_path.is_file():
        return {}, None
    try:
        value = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read {config_path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{config_path} must contain a JSON object")
    patches = value.get("patches", {})
    if patches is None:
        patches = {}
    if not isinstance(patches, dict):
        raise ValueError(f"{config_path}: 'patches' must be an object")
    return value, config_path


def _patch_config_entry(
    patch_path: Path, document_dir: Path, patches_config: dict[str, Any]
) -> Any:
    relative = patch_path.relative_to(document_dir).as_posix()
    # Basename is the documented convention.  The other spellings make a
    # report resilient to documents that already used a stem or relative path.
    for key in (patch_path.name, relative, patch_path.stem):
        if key in patches_config:
            return patches_config[key]
    return None


def _boxes_for_patch(
    patch_path: Path, document_dir: Path, config: dict[str, Any]
) -> list[Box]:
    patches_config = config.get("patches", {})
    if not isinstance(patches_config, dict):
        raise ValueError("visualdiff.json: 'patches' must be an object")
    entry = _patch_config_entry(patch_path, document_dir, patches_config)
    if entry is None:
        return []
    if not isinstance(entry, dict):
        raise ValueError(f"visualdiff entry for {patch_path.name} must be an object")
    raw_boxes = entry.get("boxes", [])
    if raw_boxes is None:
        return []
    if not isinstance(raw_boxes, list):
        raise ValueError(f"visualdiff entry for {patch_path.name}: boxes must be a list")

    boxes: list[Box] = []
    for number, raw_box in enumerate(raw_boxes, start=1):
        if not isinstance(raw_box, dict):
            raise ValueError(f"{patch_path.name}: box {number} must be an object")
        try:
            page = int(raw_box["page"])
            coordinates = [float(raw_box[key]) for key in ("x0", "y0", "x1", "y1")]
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"{patch_path.name}: invalid box {number}: {error}") from error
        if page < 1 or not all(math.isfinite(value) for value in coordinates):
            raise ValueError(f"{patch_path.name}: invalid coordinates in box {number}")
        x0, x1 = sorted((coordinates[0], coordinates[2]))
        y0, y1 = sorted((coordinates[1], coordinates[3]))
        label = raw_box.get("label")
        if label is not None:
            label = str(label)
        boxes.append(Box(page, x0, y0, x1, y1, label))
    return boxes


def _render_pdf(path: Path, dpi: float) -> list[RenderedPage]:
    scale = dpi / 72.0
    document = pymupdf.open(str(path))
    pages: list[RenderedPage] = []
    try:
        for page_number in range(len(document)):
            page = document.load_page(page_number)
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            channels = pixmap.n
            pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height, pixmap.width, channels
            )
            # ``samples`` belongs to the pixmap.  A copy also gives callers a
            # compact RGB array regardless of PyMuPDF's channel count.
            if channels > 3:
                pixels = pixels[:, :, :3]
            pixels = np.ascontiguousarray(pixels.copy())
            rect = page.rect
            pages.append(RenderedPage(pixels, float(rect.width), float(rect.height)))
    finally:
        document.close()
    return pages


def _pad_pixels(pixels: np.ndarray | None, height: int, width: int) -> np.ndarray:
    if pixels is None:
        return np.full((height, width, 3), 255, dtype=np.uint8)
    result = np.full((height, width, 3), 255, dtype=np.uint8)
    copy_height = min(height, pixels.shape[0])
    copy_width = min(width, pixels.shape[1])
    result[:copy_height, :copy_width] = pixels[:copy_height, :copy_width, :3]
    return result


def _pixel_box(box: Box, width_points: float, height_points: float, scale_x: float, scale_y: float) -> tuple[int, int, int, int] | None:
    left = max(0, int(math.floor(box.x0 * scale_x)))
    right = min(int(math.ceil(width_points * scale_x)), int(math.ceil(box.x1 * scale_x)))
    # PDF coordinates have their origin at the lower left; image rows start
    # at the upper left.
    top = max(0, int(math.floor((height_points - box.y1) * scale_y)))
    bottom = min(
        int(math.ceil(height_points * scale_y)),
        int(math.ceil((height_points - box.y0) * scale_y)),
    )
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _bbox_from_mask(
    mask: np.ndarray,
    page: int,
    width_points: float,
    height_points: float,
    scale_x: float,
    scale_y: float,
) -> dict[str, Any] | None:
    coordinates = np.nonzero(mask)
    if len(coordinates[0]) == 0:
        return None
    ys, xs = coordinates
    bbox: dict[str, Any] = {
        "page": page,
        "x0": _rounded(float(xs.min()) / scale_x),
        "y0": _rounded(height_points - float(ys.max() + 1) / scale_y),
        "x1": _rounded(float(xs.max() + 1) / scale_x),
        "y1": _rounded(height_points - float(ys.min()) / scale_y),
    }
    # Rendering dimensions can be rounded by PyMuPDF.  Keep suggestions in
    # the page, which makes them directly usable in visualdiff.json.
    bbox["x0"] = _rounded(max(0.0, min(width_points, float(bbox["x0"]))))
    bbox["x1"] = _rounded(max(0.0, min(width_points, float(bbox["x1"]))))
    bbox["y0"] = _rounded(max(0.0, min(height_points, float(bbox["y0"]))))
    bbox["y1"] = _rounded(max(0.0, min(height_points, float(bbox["y1"]))))
    return bbox


def _compare_pdfs(
    before_path: Path, after_path: Path, dpi: float, boxes: Sequence[Box]
) -> list[PageComparison]:
    before_pages = _render_pdf(before_path, dpi)
    after_pages = _render_pdf(after_path, dpi)
    page_count = max(len(before_pages), len(after_pages))
    comparisons: list[PageComparison] = []

    for index in range(page_count):
        before = before_pages[index] if index < len(before_pages) else None
        after = after_pages[index] if index < len(after_pages) else None
        if before is None and after is None:
            continue
        width_points = max(
            before.width_points if before is not None else 0.0,
            after.width_points if after is not None else 0.0,
        )
        height_points = max(
            before.height_points if before is not None else 0.0,
            after.height_points if after is not None else 0.0,
        )
        width = max(
            before.pixels.shape[1] if before is not None else 0,
            after.pixels.shape[1] if after is not None else 0,
        )
        height = max(
            before.pixels.shape[0] if before is not None else 0,
            after.pixels.shape[0] if after is not None else 0,
        )
        before_pixels = _pad_pixels(before.pixels if before else None, height, width)
        after_pixels = _pad_pixels(after.pixels if after else None, height, width)
        delta = np.abs(
            before_pixels.astype(np.int16) - after_pixels.astype(np.int16)
        ).max(axis=2)
        mask = delta > DIFF_THRESHOLD
        scale_x = width / width_points if width_points else 1.0
        scale_y = height / height_points if height_points else 1.0

        page_boxes = [box for box in boxes if box.page == index + 1]
        box_mask = np.zeros(mask.shape, dtype=bool)
        for box in page_boxes:
            coordinates = _pixel_box(
                box, width_points, height_points, scale_x, scale_y
            )
            if coordinates is None:
                continue
            left, top, right, bottom = coordinates
            left = max(0, min(width, left))
            right = max(0, min(width, right))
            top = max(0, min(height, top))
            bottom = max(0, min(height, bottom))
            if right > left and bottom > top:
                box_mask[top:bottom, left:right] = True
        outside_mask = mask & ~box_mask if boxes else mask.copy()
        comparisons.append(
            PageComparison(
                page=index + 1,
                pixels_before=before_pixels,
                pixels_after=after_pixels,
                mask=mask,
                outside_mask=outside_mask,
                width_points=width_points,
                height_points=height_points,
                scale_x=scale_x,
                scale_y=scale_y,
                diff_bbox=_bbox_from_mask(
                    mask,
                    index + 1,
                    width_points,
                    height_points,
                    scale_x,
                    scale_y,
                ),
                outside_bbox=_bbox_from_mask(
                    outside_mask,
                    index + 1,
                    width_points,
                    height_points,
                    scale_x,
                    scale_y,
                ),
                diff_pixels=int(mask.sum()),
                outside_pixels=int(outside_mask.sum()),
            )
        )
    return [comparison for comparison in comparisons if comparison.diff_pixels]


def _crop_rectangle(
    comparison: PageComparison, boxes: Sequence[Box]
) -> tuple[int, int, int, int]:
    page_boxes = [box for box in boxes if box.page == comparison.page]
    if page_boxes:
        left_points = min(box.x0 for box in page_boxes)
        right_points = max(box.x1 for box in page_boxes)
        bottom_points = min(box.y0 for box in page_boxes)
        top_points = max(box.y1 for box in page_boxes)
    elif comparison.diff_bbox is not None:
        left_points = float(comparison.diff_bbox["x0"])
        right_points = float(comparison.diff_bbox["x1"])
        bottom_points = float(comparison.diff_bbox["y0"])
        top_points = float(comparison.diff_bbox["y1"])
    else:
        left_points = 0.0
        right_points = comparison.width_points
        bottom_points = 0.0
        top_points = comparison.height_points

    margin_x = CROP_MARGIN_POINTS * comparison.scale_x
    margin_y = CROP_MARGIN_POINTS * comparison.scale_y
    left = int(math.floor(left_points * comparison.scale_x - margin_x))
    right = int(math.ceil(right_points * comparison.scale_x + margin_x))
    top = int(math.floor((comparison.height_points - top_points) * comparison.scale_y - margin_y))
    bottom = int(math.ceil((comparison.height_points - bottom_points) * comparison.scale_y + margin_y))
    height, width = comparison.mask.shape
    left = max(0, min(width, left))
    right = max(left + 1, min(width, right))
    top = max(0, min(height, top))
    bottom = max(top + 1, min(height, bottom))
    return left, top, right, bottom


def _red_overlay(pixels: np.ndarray, mask: np.ndarray, rectangle: tuple[int, int, int, int]) -> Image.Image:
    left, top, right, bottom = rectangle
    cropped = np.ascontiguousarray(pixels[top:bottom, left:right].copy())
    red = mask[top:bottom, left:right]
    cropped[red] = np.array((255, 0, 0), dtype=np.uint8)
    return Image.fromarray(cropped, mode="RGB")


def _draw_box(
    draw: ImageDraw.ImageDraw,
    box: Box,
    comparison: PageComparison,
    rectangle: tuple[int, int, int, int],
    x_offset: int,
    title_height: int,
) -> None:
    left, top, right, bottom = rectangle
    pixel_box = _pixel_box(
        box,
        comparison.width_points,
        comparison.height_points,
        comparison.scale_x,
        comparison.scale_y,
    )
    if pixel_box is None:
        return
    x0, y0, x1, y1 = pixel_box
    coordinates = (
        x_offset + x0 - left,
        title_height + y0 - top,
        x_offset + x1 - left,
        title_height + y1 - top,
    )
    draw.rectangle(coordinates, outline=(0, 190, 0), width=3)
    if box.label:
        draw.text(
            (coordinates[0] + 3, max(title_height, coordinates[1] + 3)),
            box.label,
            fill=(0, 150, 0),
        )


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_") or "patch"


def _write_page_png(
    output_dir: Path,
    patch_number: int,
    patch_name: str,
    comparison: PageComparison,
    boxes: Sequence[Box],
    status: str,
) -> str:
    rectangle = _crop_rectangle(comparison, boxes)
    before = _red_overlay(comparison.pixels_before, comparison.outside_mask, rectangle)
    after = _red_overlay(comparison.pixels_after, comparison.outside_mask, rectangle)
    title_height = 30
    panel_width = before.width
    panel_height = before.height
    image = Image.new("RGB", (panel_width * 2, panel_height + title_height), "white")
    image.paste(before, (0, title_height))
    image.paste(after, (panel_width, title_height))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()
    title = (
        f"{patch_name} — page {comparison.page} — {status} "
        f"(diff {comparison.diff_pixels}, outside {comparison.outside_pixels})"
    )
    draw.text((6, 6), title, fill=(0, 0, 0), font=font)
    draw.text((6, title_height + 5), "before", fill=(0, 100, 0), font=font)
    draw.text((panel_width + 6, title_height + 5), "after", fill=(0, 100, 0), font=font)
    draw.line((panel_width, title_height, panel_width, title_height + panel_height), fill=(80, 80, 80), width=1)
    for box in boxes:
        _draw_box(draw, box, comparison, rectangle, 0, title_height)
        _draw_box(draw, box, comparison, rectangle, panel_width, title_height)

    filename = (
        f"{patch_number:02d}_{_safe_name(patch_name)}"
        f"_page-{comparison.page:03d}.png"
    )
    path = output_dir / filename
    image.save(path, format="PNG")
    return filename


def _run_python_patch(
    script: Path,
    input_pdf: Path,
    output_pdf: Path,
    python_executable: str,
) -> None:
    """Run a pikepdf patch while supporting old default-name scripts."""

    with tempfile.TemporaryDirectory(prefix="pdfpatches-patch-") as temporary:
        work_dir = Path(temporary)
        # Existing scripts historically opened cleaned.pdf and wrote test.pdf.
        # The aliases let those scripts continue to work without ever touching
        # the document checkout.
        shutil.copyfile(input_pdf, work_dir / "cleaned.pdf")
        requested_output = work_dir / "result.pdf"
        command = [
            python_executable,
            str(script.resolve()),
            str(input_pdf.resolve()),
            str(requested_output),
        ]
        completed = subprocess.run(
            command,
            cwd=work_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode != 0:
            stderr = completed.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(
                f"{script.name} failed with exit code {completed.returncode}"
                + (f": {stderr}" if stderr else "")
            )

        candidates = [requested_output, work_dir / "test.pdf", work_dir / "patched.pdf"]
        candidate = next((path for path in candidates if path.is_file()), None)
        if candidate is None:
            # A few hand-written scripts modify their default input in place.
            alias = work_dir / "cleaned.pdf"
            if alias.is_file() and alias.read_bytes() != input_pdf.read_bytes():
                candidate = alias
        if candidate is None:
            raise RuntimeError(f"{script.name} did not create an output PDF")
        shutil.copyfile(candidate, output_pdf)


def _entry_report(entry: PatchComparison) -> dict[str, Any]:
    return {
        "name": entry.name,
        "path": entry.relative_path,
        "kind": entry.kind,
        "configured": entry.configured,
        "boxes": [box.as_dict() for box in entry.boxes],
        "status": entry.status,
        "warnings": entry.warnings,
        "images": entry.images,
        "apply": (
            {
                "hunks_applied": entry.apply_result.hunks_applied,
                "fuzz": entry.apply_result.fuzz,
                "fuzz_hunks": entry.apply_result.fuzz_hunks,
                "fuzz_lines": entry.apply_result.fuzz_lines,
            }
            if entry.apply_result is not None
            else None
        ),
        "pages": [
            {
                "page": comparison.page,
                "diff_pixels": comparison.diff_pixels,
                "outside_pixels": comparison.outside_pixels,
                "diff_bbox": comparison.diff_bbox,
                "outside_bbox": comparison.outside_bbox,
            }
            for comparison in entry.pages
        ],
    }


def _print_suggestion(patch_name: str, comparison: PageComparison) -> None:
    if comparison.diff_bbox is None:
        return
    print(
        "SUGGEST "
        + patch_name
        + ": "
        + json.dumps(
            {"boxes": [comparison.diff_bbox]}, ensure_ascii=False, sort_keys=True
        )
    )


def run_visual_diff(
    document_dir: Path,
    before_pdf: Path,
    output_dir: Path,
    *,
    dpi: float | None = None,
    strict: bool = False,
    suggest: bool = False,
    python_executable: str | None = None,
) -> int:
    document_dir = document_dir.resolve()
    before_pdf = before_pdf.resolve()
    output_dir = output_dir.resolve()
    if not document_dir.is_dir():
        raise ValueError(f"document directory does not exist: {document_dir}")
    if not before_pdf.is_file():
        raise ValueError(f"input PDF does not exist: {before_pdf}")
    output_dir.mkdir(parents=True, exist_ok=True)

    config, config_path = _load_config(document_dir)
    if dpi is None:
        configured_dpi = config.get("dpi", DEFAULT_DPI)
        try:
            dpi = float(configured_dpi)
        except (TypeError, ValueError) as error:
            raise ValueError(f"invalid visualdiff dpi: {configured_dpi!r}") from error
    if not math.isfinite(dpi) or dpi <= 0:
        raise ValueError("dpi must be a positive number")
    executable = python_executable or sys.executable
    patch_paths = _patch_files(document_dir)
    if not patch_paths:
        print(f"warning: no patches found in {document_dir}", file=sys.stderr)

    entries: list[PatchComparison] = []
    overall_failure = False
    with tempfile.TemporaryDirectory(prefix="pdfpatches-visual-") as temporary:
        work_dir = Path(temporary)
        current_pdf = work_dir / "current.pdf"
        shutil.copyfile(before_pdf, current_pdf)

        for patch_number, patch_path in enumerate(patch_paths, start=1):
            patch_before = work_dir / f"before-{patch_number:03d}.pdf"
            patch_after = work_dir / f"after-{patch_number:03d}.pdf"
            shutil.copyfile(current_pdf, patch_before)
            kind = "python" if patch_path.name == "patch.py" else "unified"
            apply_result: ApplyResult | None = None
            if kind == "unified":
                shutil.copyfile(patch_before, patch_after)
                apply_result = apply_patch_file(patch_path, patch_after)
            else:
                _run_python_patch(
                    patch_path, patch_before, patch_after, executable
                )

            boxes = _boxes_for_patch(patch_path, document_dir, config)
            configured = bool(boxes)
            pages = _compare_pdfs(patch_before, patch_after, dpi, boxes)
            warnings: list[str] = []
            if not configured:
                warning = f"no visualdiff boxes configured for {patch_path.name}"
                warnings.append(warning)
                print(f"warning: {warning}", file=sys.stderr)
            status = "PASS"
            if not configured:
                status = "FAIL" if strict else "WARN"
                if strict:
                    overall_failure = True
            elif any(page.outside_pixels for page in pages):
                status = "FAIL"
                overall_failure = True

            image_names: list[str] = []
            for comparison in pages:
                if suggest:
                    _print_suggestion(patch_path.name, comparison)
                image_names.append(
                    _write_page_png(
                        output_dir,
                        patch_number,
                        patch_path.name,
                        comparison,
                        boxes,
                        status,
                    )
                )
            if suggest and not pages:
                print(f"SUGGEST {patch_path.name}: no pixel differences")

            relative_path = patch_path.relative_to(document_dir).as_posix()
            entry = PatchComparison(
                name=patch_path.name,
                relative_path=relative_path,
                kind=kind,
                boxes=boxes,
                configured=configured,
                apply_result=apply_result,
                pages=pages,
                warnings=warnings,
                images=image_names,
                status=status,
            )
            entries.append(entry)
            print(
                f"{patch_path.name}: {status} "
                f"({sum(page.diff_pixels for page in pages)} diff pixels, "
                f"{sum(page.outside_pixels for page in pages)} outside boxes)"
            )
            shutil.copyfile(patch_after, current_pdf)

    report = {
        "document": str(document_dir),
        "before": str(before_pdf),
        "dpi": _rounded(dpi),
        "threshold": DIFF_THRESHOLD,
        "config": str(config_path) if config_path is not None else None,
        "strict": strict,
        "suggest": suggest,
        "status": "FAIL" if overall_failure else "PASS",
        "patches": [_entry_report(entry) for entry in entries],
    }
    report_path = output_dir / "report.json"
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    if overall_failure:
        print(f"visual diff: FAIL (report: {report_path})", file=sys.stderr)
        return 1
    print(f"visual diff: PASS (report: {report_path})")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("doc_dir", help="document directory containing patches")
    parser.add_argument("before_pdf", help="cleaned/before PDF")
    parser.add_argument("outdir", help="directory for PNGs and report.json")
    parser.add_argument(
        "--dpi",
        type=float,
        default=None,
        help=f"rendering resolution (default: config value or {int(DEFAULT_DPI)})",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="treat missing visualdiff boxes as an error",
    )
    parser.add_argument(
        "--suggest",
        action="store_true",
        help="print PDF-coordinate boxes around each detected diff",
    )
    args = parser.parse_args(argv)

    try:
        return run_visual_diff(
            Path(args.doc_dir),
            Path(args.before_pdf),
            Path(args.outdir),
            dpi=args.dpi,
            strict=args.strict,
            suggest=args.suggest,
        )
    except (OSError, RuntimeError, ValueError) as error:
        print(f"visual_diff: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
