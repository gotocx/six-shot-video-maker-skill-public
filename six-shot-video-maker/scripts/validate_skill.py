#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def extract_frontmatter(markdown: str) -> str | None:
    match = re.match(r"\A---\s*\n([\s\S]*?)\n---\s*\n", markdown)
    return match.group(1) if match else None


def frontmatter_value(frontmatter: str, key: str) -> str:
    match = re.search(rf"^{re.escape(key)}:\s*(.+?)\s*$", frontmatter, re.MULTILINE)
    return match.group(1).strip().strip('"') if match else ""


def forbidden_terms() -> list[str]:
    return ["co" + "dex", "chat" + "gpt", "open" + "ai"]


def iter_files(skill_dir: Path):
    for path in skill_dir.rglob("*"):
        if "node_modules" in path.parts:
            continue
        if path.is_file():
            yield path


def rel(path: Path, root: Path) -> str:
    return str(path.relative_to(root))


def validate(skill_dir: Path) -> int:
    errors: list[str] = []
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        errors.append("Missing SKILL.md")
    else:
        content = read_text(skill_md)
        frontmatter = extract_frontmatter(content)
        if not frontmatter:
            errors.append("SKILL.md missing YAML frontmatter")
        else:
            for key in ("name", "description", "version"):
                if not frontmatter_value(frontmatter, key):
                    errors.append(f"SKILL.md frontmatter missing {key}")
            name = frontmatter_value(frontmatter, "name")
            if name != skill_dir.name:
                errors.append(f"frontmatter name {name!r} must match folder {skill_dir.name!r}")
        if "## @工作流" not in content:
            errors.append("SKILL.md must include a workflow heading")
        if "## 版本历史" not in content:
            errors.append("SKILL.md must include version history")
        if "TODO" in content:
            errors.append("SKILL.md contains TODO placeholder text")

    for file_path in iter_files(skill_dir):
        lowered_name = file_path.name.lower()
        for term in forbidden_terms():
            if term in lowered_name:
                errors.append(f"file name contains a forbidden provider word: {file_path.relative_to(skill_dir)}")
        try:
            text = read_text(file_path)
        except UnicodeDecodeError:
            continue
        lowered_text = text.lower()
        for term in forbidden_terms():
            if term in lowered_text:
                errors.append(f"file content contains a forbidden provider word: {file_path.relative_to(skill_dir)}")

    assets_dir = skill_dir / "assets"
    if assets_dir.exists() and any(assets_dir.rglob("*")):
        errors.append("assets directory must stay empty; run assets belong outside the skill package")

    required_files = [
        skill_dir / "scripts" / "asset_state.mjs",
        skill_dir / "scripts" / "preflight.mjs",
        skill_dir / "scripts" / "submit_images.mjs",
        skill_dir / "scripts" / "submit_video.mjs",
        skill_dir / "scripts" / "video_submit.mjs",
        skill_dir / "scripts" / "package.json",
        skill_dir / "scripts" / "package-lock.json",
        skill_dir / "scripts" / "image_workflow" / "run-browser-worker.ps1",
        skill_dir / "scripts" / "image_workflow" / "run-jimeng-worker.ps1",
        skill_dir / "scripts" / "image_workflow" / "providers" / "browser" / "scripts" / "browserConversationGenerate.mjs",
        skill_dir / "scripts" / "image_workflow" / "providers" / "jimeng" / "scripts" / "jimengBatchGenerate.mjs",
        skill_dir / "scripts" / "image_workflow" / "providers" / "shared" / "unifiedTask.mjs",
    ]
    for required in required_files:
        if not required.exists():
            errors.append(f"Missing {rel(required, skill_dir)}")

    mjs_files = sorted((skill_dir / "scripts").rglob("*.mjs"))
    for script in mjs_files:
        try:
            subprocess.run(["node", "--check", str(script)], check=True, capture_output=True, text=True)
        except FileNotFoundError:
            errors.append("node was not found for script syntax check")
            break
        except subprocess.CalledProcessError as exc:
            errors.append(f"{rel(script, skill_dir)} syntax check failed: " + (exc.stderr or exc.stdout).strip())

    if errors:
        for message in errors:
            print("ERROR: " + message)
        return 1

    print("OK: six-shot-video-maker validation passed")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill", required=True)
    args = parser.parse_args()
    skill_dir = Path(args.skill).resolve()
    if not skill_dir.exists():
        print("ERROR: skill folder not found: " + str(skill_dir))
        raise SystemExit(1)
    raise SystemExit(validate(skill_dir))


if __name__ == "__main__":
    main()
