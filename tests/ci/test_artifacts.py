"""Exercise release boundaries with synthetic files; never compile the application."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("artifacts", REPO / "scripts/ci/artifacts.py")
artifacts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifacts)
COMMIT = "a" * 40
OTHER_COMMIT = "b" * 40


class ReleaseArtifactsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="pure-ci-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        env = patch.dict(os.environ, {
            "GITHUB_SHA": COMMIT,
            "GITHUB_OUTPUT": str(self.root / "step-output"),
            "GITHUB_REPOSITORY": "test/pure",
            "PURE_BUILD_RUNNER": "test-runner",
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        env.start()
        self.addCleanup(env.stop)

    def make_frontend(self):
        (self.root / "dist").mkdir()
        (self.root / "dist/index.html").write_text("<html>test</html>")
        artifacts.frontend(self.root, stamp=True)

    def make_pair(self):
        release = self.root / "release"
        release.mkdir()
        for platform, (asset, _) in artifacts.PACKAGES.items():
            (self.root / asset).write_bytes(f"synthetic {platform}".encode())
            artifacts.record_native(self.root, platform)
            for name in (asset, f"{platform}-build.json"):
                shutil.move(self.root / name, release / name)
        return release

    def test_frontend_requires_source_commit_and_entrypoint(self):
        self.make_frontend()
        artifacts.frontend(self.root)
        with patch.dict(os.environ, {"GITHUB_SHA": OTHER_COMMIT}):
            with self.assertRaisesRegex(ValueError, "source commit"):
                artifacts.frontend(self.root)
        (self.root / "dist/index.html").unlink()
        with self.assertRaisesRegex(ValueError, "Missing or empty"):
            artifacts.frontend(self.root)

    def test_valid_pair_has_commit_and_verified_package_digests(self):
        release = self.make_pair()
        artifacts.verify_release(self.root)
        info = json.loads((release / "build-info.json").read_text())
        self.assertEqual(info["commit"], COMMIT)
        self.assertEqual({p["platform"] for p in info["packages"]}, {"macos", "ios"})
        for package in info["packages"]:
            self.assertEqual(package["sha256"], artifacts.digest(release / package["asset"]))
        self.assertIn("manifest=ios-build.json", (self.root / "step-output").read_text())

    def test_modified_package_is_rejected(self):
        release = self.make_pair()
        (release / "pure-ios-unsigned.ipa").write_bytes(b"different package")
        with self.assertRaisesRegex(ValueError, "ios package"):
            artifacts.verify_release(self.root)
        self.assertFalse((release / "build-info.json").exists())

    def test_packages_from_different_commits_are_rejected(self):
        release = self.make_pair()
        manifest = release / "ios-build.json"
        value = json.loads(manifest.read_text())
        value["commit"] = OTHER_COMMIT
        artifacts.write_json(manifest, value)
        with self.assertRaisesRegex(ValueError, "ios package"):
            artifacts.verify_release(self.root)
        self.assertFalse((release / "build-info.json").exists())

    def test_missing_platform_is_rejected(self):
        release = self.make_pair()
        (release / "pure-macos.zip").unlink()
        with self.assertRaisesRegex(ValueError, "Missing or empty"):
            artifacts.verify_release(self.root)

    def install_ci_tools(self):
        scripts = self.root / "scripts/ci"
        scripts.mkdir(parents=True)
        shutil.copy(REPO / "scripts/ci/artifacts.py", scripts)
        binary = self.root / "bin"
        binary.mkdir()
        # Every gh command is recorded, so a failed guard cannot publish silently.
        gh = binary / "gh"
        gh.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_TEST_LOG"\n'
                      'if [ "$1" = api ]; then printf "%s\\n" "$GH_TEST_MAIN"; fi\n')
        gh.chmod(0o755)
        os.environ["PATH"] = str(binary) + os.pathsep + os.environ["PATH"]
        os.environ["GH_TEST_LOG"] = str(self.root / "gh-log")
        os.environ["GH_TEST_MAIN"] = COMMIT

    def publish(self):
        return subprocess.run(["bash", str(REPO / "scripts/ci/publish-release.sh")],
                              cwd=self.root, capture_output=True, text=True)

    def test_stale_run_never_uploads(self):
        self.install_ci_tools()
        os.environ["GH_TEST_MAIN"] = OTHER_COMMIT
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("keeping the existing release", result.stdout)
        self.assertNotIn("release", (self.root / "gh-log").read_text())

    def test_publication_rejects_mixed_pair_before_any_release_command(self):
        self.install_ci_tools()
        self.make_pair()
        (self.root / "release/pure-macos.zip").write_bytes(b"changed")
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("release", (self.root / "gh-log").read_text())

    def test_publication_uploads_only_verified_pair_and_build_info(self):
        self.install_ci_tools()
        self.make_pair()
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = (self.root / "gh-log").read_text()
        self.assertIn("release upload latest-build release/pure-macos.zip "
                      "release/pure-ios-unsigned.ipa release/build-info.json --clobber", commands)

    def test_native_build_stops_before_npm_when_frontend_is_wrong(self):
        self.install_ci_tools()
        self.make_frontend()
        npm = self.root / "bin/npm"
        npm.write_text('#!/bin/sh\necho "npm must not run" >&2\nexit 99\n')
        npm.chmod(0o755)
        with patch.dict(os.environ, {"GITHUB_SHA": OTHER_COMMIT, "PURE_BUILD_PLATFORM": "ios"}):
            result = subprocess.run(["bash", str(REPO / "scripts/ci/build-native.sh")],
                                    cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source commit", result.stderr)
        self.assertNotIn("npm must not run", result.stderr)


if __name__ == "__main__":
    unittest.main()
