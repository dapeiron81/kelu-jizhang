#!/usr/bin/env python3
"""Find likely secrets without printing the matched secret value."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path


IGNORED_DIRECTORIES = {".git", "node_modules", "out", "release", "dist", "__pycache__"}
IGNORED_SUFFIXES = {
    ".7z", ".avi", ".db", ".db-shm", ".db-wal", ".dll", ".exe", ".gif",
    ".ico", ".jpg", ".jpeg", ".mp3", ".mp4", ".node", ".pdf", ".png",
    ".sqlite", ".webp", ".zip",
}
MAX_FILE_BYTES = 2_000_000


@dataclass(frozen=True)
class Rule:
    name: str
    severity: str
    pattern: re.Pattern[str]
    value_group: int | None = None


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    rule: Rule


RULES = (
    Rule("私钥内容", "严重", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    Rule("OpenAI 风格密钥", "严重", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    Rule("GitHub 访问令牌", "严重", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    Rule("AWS 访问密钥编号", "严重", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    Rule(
        "带明文凭据的连接地址",
        "严重",
        re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s/:]+:([^\s/@]+)@", re.IGNORECASE),
        1,
    ),
    Rule(
        "疑似明文密码或令牌",
        "高",
        re.compile(
            r"\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b"
            r"\s*[:=]\s*[\"']([^\"']{4,})[\"']",
            re.IGNORECASE,
        ),
        1,
    ),
)

PLACEHOLDER_MARKERS = (
    "${", "process.env", "import.meta.env", "placeholder", "example", "your_", "your-",
    "<secret", "<token", "<password", "dummy", "fake", "sample",
)


def is_placeholder(value: str) -> bool:
    """Avoid reporting values that clearly instruct users to provide their own secret."""
    lowered = value.strip().lower()
    return any(marker in lowered for marker in PLACEHOLDER_MARKERS)


def iter_files(paths: list[Path]) -> list[Path]:
    """Collect readable project files while skipping generated output and binary data."""
    files: set[Path] = set()
    for path in paths:
        candidates = [path] if path.is_file() else path.rglob("*") if path.is_dir() else []
        for candidate in candidates:
            if not candidate.is_file():
                continue
            if any(part in IGNORED_DIRECTORIES for part in candidate.parts):
                continue
            if candidate.suffix.lower() in IGNORED_SUFFIXES:
                continue
            try:
                if candidate.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            files.add(candidate.resolve())
    return sorted(files)


def scan_file(path: Path) -> list[Finding]:
    """Return secret candidates while keeping all matched values out of the result."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []

    findings: list[Finding] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for rule in RULES:
            for match in rule.pattern.finditer(line):
                if rule.value_group is not None and is_placeholder(match.group(rule.value_group)):
                    continue
                findings.append(Finding(path, line_number, rule))
    return findings


def main() -> int:
    """Print only location and category, never the matched secret or source line."""
    parser = argparse.ArgumentParser(description="扫描疑似明文秘密并输出脱敏位置")
    parser.add_argument("paths", nargs="+", type=Path, help="要扫描的文件或目录")
    args = parser.parse_args()

    files = iter_files(args.paths)
    if not files:
        print("没有找到可扫描的文本文件。")
        return 2

    findings = [finding for path in files for finding in scan_file(path)]
    for finding in findings:
        try:
            display_path = finding.path.relative_to(Path.cwd())
        except ValueError:
            display_path = finding.path
        print(f"[{finding.rule.severity}] {display_path}:{finding.line} - {finding.rule.name}（内容已隐藏）")

    print(f"已扫描 {len(files)} 个文件，发现 {len(findings)} 个候选项。")
    print("说明：候选项需人工核对；报告不会显示任何匹配到的秘密值。")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
