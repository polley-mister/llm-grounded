#!/usr/bin/env python3
"""Cut a version. Refuses to move a tag that already exists elsewhere.

A tag is the durable record of what was built. Once pushed it identifies an
artifact, including artifacts that failed — `v0.3.0` names a build whose first
deployment failed plugin registration, and `v0.3.2` and `v0.3.3` name builds the
deployment gate rejected. Moving one to a fixed commit erases the only evidence
of what actually shipped, and the fixed build is a new version anyway.

That reasoning was written down and then not followed: `v0.3.2` was retargeted by
hand, minutes after agreeing it should not be. A convention that lives only in a
document is a convention until someone is in a hurry. This is the same rule with
no hurry-shaped hole in it.

    remote tag absent               create it
    remote tag at expected commit   idempotent success, nothing to do
    remote tag at another commit    hard failure; cut a new version

There is deliberately no --force, no --retarget and no --delete. Removing a tag
is a real operation with real reasons, and it should require reaching for git
directly and meaning it.

Usage:

    python3 scripts/release.py --version 0.4.0 [--remote origin] [--dry-run]
    python3 scripts/release.py --version 0.4.0 --publish   # minor bumps only
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def log(message):
    print(f"[release] {message}", flush=True)


def fail(message):
    print(f"[release] FAILED: {message}", file=sys.stderr, flush=True)


def git(*args, check=True):
    result = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip())
    return result.stdout.strip()


def remote_tag_commit(remote, tag):
    """
    The commit a remote tag points at, or None if it does not exist.

    Both refs are requested explicitly. An annotated tag is an object in its own
    right with its own sha, and `ls-remote` given a single exact pattern returns
    only that object — not the commit it dereferences to. Comparing the tag
    object's sha against HEAD compares two different kinds of thing and never
    matches, so every annotated tag would look like it pointed somewhere else
    and this script would refuse to do anything at all.
    """
    out = git("ls-remote", remote, f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}", check=False)
    if not out:
        return None
    lines = [line.split("\t") for line in out.splitlines() if "\t" in line]
    for sha, ref in lines:
        if ref.endswith("^{}"):
            return sha
    # A lightweight tag has no peeled ref: it already names a commit.
    return lines[0][0] if lines else None


def version_files_agree(version):
    """package.json, the manifest, and the changelog must already say so."""
    problems = []
    pkg = json.loads((REPO / "package.json").read_text())["version"]
    if pkg != version:
        problems.append(f"package.json says {pkg}")
    manifest = json.loads((REPO / "openclaw.plugin.json").read_text())["version"]
    if manifest != version:
        problems.append(f"openclaw.plugin.json says {manifest}")
    changelog = (REPO / "CHANGELOG.md").read_text()
    if f"## {version}" not in changelog:
        problems.append("CHANGELOG.md has no entry")
    return problems


def is_minor_boundary(version):
    """True for x.y.0 — the only versions that get a GitHub Release."""
    parts = version.split(".")
    return len(parts) == 3 and parts[2] == "0"


def main():
    ap = argparse.ArgumentParser(description="Cut a version without mutating tags.")
    ap.add_argument("--version", required=True, help="the version to tag, e.g. 0.4.0")
    ap.add_argument("--remote", default="origin")
    ap.add_argument("--message", default=None, help="tag annotation; read from the changelog entry if omitted")
    ap.add_argument("--publish", action="store_true", help="also create a GitHub Release (minor bumps only)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    version = args.version.lstrip("v")
    tag = f"v{version}"

    problems = version_files_agree(version)
    if problems:
        fail(f"the tree does not identify as {version}: {'; '.join(problems)}")
        log("bump the version files and write the changelog entry in the same commit as the work")
        return 1

    head = git("rev-parse", "HEAD")
    if git("status", "--porcelain"):
        fail("the working tree is dirty; commit before tagging")
        return 1

    existing = remote_tag_commit(args.remote, tag)
    if existing == head:
        log(f"{tag} already exists at {head[:7]} — nothing to do")
        return 0
    if existing is not None:
        # The whole reason this script exists.
        fail(f"{tag} already exists on {args.remote}, at {existing[:7]}, and HEAD is {head[:7]}")
        log("a pushed tag identifies what was built and is not moved.")
        log(f"if {existing[:7]} was wrong, the fix is a new version, not a new meaning for {tag}.")
        return 1

    local = git("rev-parse", f"{tag}^{{commit}}", check=False)
    if local and local != head:
        fail(f"a local {tag} points at {local[:7]}, not HEAD {head[:7]}")
        log("delete the local tag deliberately if it is stale; this script will not.")
        return 1

    message = args.message
    if message is None:
        # The changelog entry is the annotation. Two hand-written descriptions
        # of one release drift, and the one in the tag is the one nobody edits.
        body = (REPO / "CHANGELOG.md").read_text()
        start = body.index(f"## {version}")
        end = body.find("\n## ", start + 1)
        message = body[start:end if end != -1 else None].strip()

    if args.dry_run:
        log(f"would tag {tag} at {head[:7]}")
        log(f"would {'publish a GitHub Release' if args.publish else 'not publish a release'}")
        if args.publish and not is_minor_boundary(version):
            log(f"note: {version} is not a minor boundary; see docs/RELEASING.md")
        return 0

    if not local:
        git("tag", "-a", tag, "-m", message)
        log(f"tagged {tag} at {head[:7]}")
    git("push", args.remote, tag)
    log(f"pushed {tag} to {args.remote}")

    if not args.publish:
        return 0
    if not is_minor_boundary(version):
        fail(f"{version} is not a minor boundary; releases are for x.y.0 (see docs/RELEASING.md)")
        log("the tag is pushed; the release was not created")
        return 1
    result = subprocess.run(
        ["gh", "release", "create", tag, "--title", f"llm-grounded {tag}", "--notes", message],
        cwd=str(REPO), capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail(f"gh release create: {(result.stderr or result.stdout).strip()}")
        return 1
    log(result.stdout.strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
