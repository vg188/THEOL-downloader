"""Compatibility CLI; website and standalone ZIP use the same deterministic Node packager."""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PERMISSIONS = ["alarms", "downloads", "offscreen", "scripting", "storage", "tabs"]


def main():
    manifest = json.loads((ROOT / "dist" / "extension" / "manifest.json").read_text(encoding="utf-8-sig"))
    assert sorted(manifest["permissions"]) == PERMISSIONS
    result = subprocess.run(["node", "scripts/package-release.mjs"], cwd=ROOT, capture_output=True,
                            text=True, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    print(result.stdout, end="")
    print(result.stderr, end="", file=sys.stderr)
    if result.returncode:
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
