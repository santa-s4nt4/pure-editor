"""Bind frontend and native artifacts to the current source commit before release."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys


PACKAGES = {
    "macos": ("pure-macos.zip", "aarch64-apple-darwin"),
    "ios": ("pure-ios-unsigned.ipa", "aarch64-apple-ios"),
}


def current_commit():
    commit = os.environ.get("GITHUB_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("GITHUB_SHA must be a full source commit SHA.")
    return commit


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def read_json(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Invalid artifact metadata: {path}")
    return value


def digest(path):
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"Missing or empty artifact: {path}")
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def frontend(root, stamp=False):
    dist = root / "dist"
    digest(dist / "index.html")
    expected = {"version": 1, "commit": current_commit()}
    marker = dist / "pure-build.json"
    if stamp:
        write_json(marker, expected)
    elif read_json(marker) != expected:
        raise ValueError("Frontend was not built from this source commit.")


def record_native(root, platform):
    asset, target = PACKAGES[platform]
    manifest = f"{platform}-build.json"
    metadata = {
        "version": 1,
        "platform": platform,
        "commit": current_commit(),
        "target": target,
        "runner": os.environ.get("PURE_BUILD_RUNNER", ""),
        "asset": asset,
        "sha256": digest(root / asset),
    }
    write_json(root / manifest, metadata)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        output.write(f"asset={asset}\nmanifest={manifest}\n")


def verify_release(root):
    release = root / "release"
    commit = current_commit()
    packages = []
    for platform, (asset, target) in PACKAGES.items():
        metadata = read_json(release / f"{platform}-build.json")
        expected = {
            "version": 1,
            "platform": platform,
            "commit": commit,
            "target": target,
            "asset": asset,
            "sha256": digest(release / asset),
        }
        if any(metadata.get(key) != value for key, value in expected.items()):
            raise ValueError(f"{platform} package does not match this commit or its recorded digest.")
        packages.append(metadata)
    write_json(release / "build-info.json", {
        "version": 1, "commit": commit, "packages": packages,
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=[
        "stamp-frontend", "verify-frontend", "record-native", "verify-release",
    ])
    parser.add_argument("platform", nargs="?", choices=PACKAGES)
    args = parser.parse_args()
    root = Path.cwd()
    try:
        if args.command in ("stamp-frontend", "verify-frontend"):
            frontend(root, stamp=args.command == "stamp-frontend")
        elif args.command == "record-native":
            if not args.platform:
                parser.error("record-native requires a platform")
            record_native(root, args.platform)
        else:
            verify_release(root)
    except (OSError, ValueError, KeyError) as error:
        print(f"Artifact verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
