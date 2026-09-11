"""Package only the explicit release asset allowlist; never browser data or downloads."""
from pathlib import Path
import json
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "dist" / "extension"
ASSETS = ["manifest.json", "popup.html", "popup.css", "popup.js", "background.js", "content.js",
          "icons/16.png", "icons/32.png", "icons/48.png", "icons/128.png"]


def main():
    manifest = json.loads((BUILD / "manifest.json").read_text(encoding="utf-8-sig"))
    assert manifest["manifest_version"] == 3
    assert sorted(manifest["permissions"]) == ["downloads", "scripting", "storage"]
    assert manifest["host_permissions"] == ["https://course.buct.edu.cn/*"]
    for name in ASSETS:
        path = (BUILD / name).resolve()
        if not path.is_relative_to(BUILD.resolve()) or not path.is_file():
            raise RuntimeError(f"Missing or unsafe release asset: {name}")
    output = ROOT / "dist" / "buct-course-downloader.zip"
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for name in ASSETS:
            archive.write(BUILD / name, arcname=name)
    with ZipFile(output) as archive:
        assert sorted(archive.namelist()) == sorted(ASSETS)
        assert archive.testzip() is None
    print(f"Package: {output}")
    print(f"Version: {manifest['version']} | assets: {len(ASSETS)} | bytes: {output.stat().st_size}")


if __name__ == "__main__":
    main()
