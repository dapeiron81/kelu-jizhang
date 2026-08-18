#!/usr/bin/env python3
"""Estimate comment density for source files maintained by the project."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path


SUPPORTED_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".css", ".html"}
IGNORED_DIRECTORIES = {"node_modules", "out", "release", "dist", ".git"}


@dataclass
class Counts:
    code: int = 0
    comments: int = 0

    @property
    def total(self) -> int:
        return self.code + self.comments

    @property
    def density(self) -> float:
        return self.comments / self.total if self.total else 0.0


def iter_source_files(paths: list[Path]) -> list[Path]:
    """Return supported source files while excluding dependencies and generated output."""
    files: set[Path] = set()
    for path in paths:
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES:
            files.add(path.resolve())
            continue
        if not path.is_dir():
            continue
        for candidate in path.rglob("*"):
            if not candidate.is_file() or candidate.suffix.lower() not in SUPPORTED_SUFFIXES:
                continue
            if any(part in IGNORED_DIRECTORIES for part in candidate.parts):
                continue
            files.add(candidate.resolve())
    return sorted(files)


def count_lines(path: Path) -> Counts:
    """Classify non-empty lines as code or comment-only lines using a conservative heuristic."""
    counts = Counts()
    in_block_comment = False
    block_end = "*/"

    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if in_block_comment:
            counts.comments += 1
            if block_end in line:
                in_block_comment = False
            continue

        if line.startswith("//"):
            counts.comments += 1
            continue

        if line.startswith("<!--"):
            counts.comments += 1
            if "-->" not in line:
                in_block_comment = True
                block_end = "-->"
            continue

        if line.startswith("/*"):
            counts.comments += 1
            if "*/" not in line:
                in_block_comment = True
                block_end = "*/"
            continue

        if line.startswith("*") or line.startswith("*/") or line.startswith("-->"):
            counts.comments += 1
            continue

        counts.code += 1

    return counts


def main() -> int:
    """Print per-file and total density, then return failure when the target is not met."""
    parser = argparse.ArgumentParser(description="统计项目源码的注释密度")
    parser.add_argument("paths", nargs="+", type=Path, help="要检查的文件或目录")
    parser.add_argument("--target", type=float, default=0.30, help="目标比例，默认 0.30")
    args = parser.parse_args()

    if not 0 <= args.target <= 1:
        parser.error("--target 必须在 0 和 1 之间")

    files = iter_source_files(args.paths)
    if not files:
        print("没有找到支持的源代码文件。")
        return 2

    total = Counts()
    print(f"{'文件':<58} {'代码':>7} {'注释':>7} {'密度':>8} {'结果':>6}")
    print("-" * 92)
    for path in files:
        counts = count_lines(path)
        total.code += counts.code
        total.comments += counts.comments
        result = "通过" if counts.density >= args.target else "不足"
        try:
            display_path = path.relative_to(Path.cwd())
        except ValueError:
            display_path = path
        print(f"{str(display_path):<58} {counts.code:>7} {counts.comments:>7} {counts.density:>7.1%} {result:>6}")

    print("-" * 92)
    overall = "通过" if total.density >= args.target else "不足"
    print(f"{'合计':<58} {total.code:>7} {total.comments:>7} {total.density:>7.1%} {overall:>6}")
    print("说明：密度只用于筛查，注释是否准确、有效和易懂仍需逐项阅读判断。")
    return 0 if total.density >= args.target else 1


if __name__ == "__main__":
    raise SystemExit(main())
