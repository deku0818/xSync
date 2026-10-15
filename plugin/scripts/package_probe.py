"""Package only the generated development probe. Never installs into a Vault."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

project = Path(__file__).resolve().parents[2]
root = project / "plugin/dist/obsidian-sync-probe"
version = json.loads((root / "manifest.json").read_text())["version"]
output = root.parent / f"obsidian-sync-probe-{version}.zip"
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in ("main.js", "manifest.json", "LICENSE", "THIRD-PARTY-NOTICES.txt"):
        archive.write(root / name, Path(root.name) / name)
with ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise RuntimeError("Probe archive CRC check failed")
print(f"Packaged {output}")
