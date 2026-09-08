#!/usr/bin/env python3
"""Publish a Git bundle to GitHub using the Git Database REST API.

The GitHub REST API cannot accept a .bundle file directly. This program imports
that bundle into a temporary repository, recreates reachable commits, trees, and
blobs through the REST API, then creates or updates the destination ref.

Safe by default: use --execute to write. Use --force only when intentionally
replacing an existing destination branch.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

API_VERSION = "2022-11-28"


def die(message: str) -> "NoReturn":
    raise SystemExit(f"[publish-bundle] ERROR: {message}")


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        die(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


class GitHub:
    def __init__(self, token: str, repo: str, dry_run: bool) -> None:
        self.repo = repo
        self.dry_run = dry_run
        self.base = f"https://api.github.com/repos/{repo}"
        self.headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": API_VERSION,
            "Content-Type": "application/json",
            "User-Agent": "synara-bundle-publisher",
        }
        self.calls = 0

    def request(self, method: str, path: str, payload: dict | None = None) -> dict:
        if self.dry_run:
            self.calls += 1
            return {}
        body = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.base + path, data=body,
                                         headers=self.headers, method=method)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode(errors="replace")
                if exc.code in (403, 429) and attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                die(f"GitHub API {method} {path} returned {exc.code}: {raw[:1000]}")
            except urllib.error.URLError as exc:
                if attempt == 4:
                    die(f"GitHub API connection failed: {exc}")
                time.sleep(2 ** attempt)
        die("unreachable")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", default="/home/ubuntu/synara-transfer/synara-integration.bundle")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""), help="owner/name")
    parser.add_argument("--branch", default="integration")
    parser.add_argument("--token", default=None, help="Avoid this option when possible; use GITHUB_TOKEN")
    parser.add_argument("--execute", action="store_true", help="Write objects and update the ref")
    parser.add_argument("--force", action="store_true", help="Force-update an existing destination branch")
    parser.add_argument("--keep-worktree", action="store_true")
    return parser.parse_args()


def import_bundle(bundle: Path, work: Path) -> None:
    if not bundle.is_file():
        die(f"bundle not found: {bundle}")
    git(work, "init", "--quiet")
    git(work, "fetch", str(bundle), "refs/heads/*:refs/remotes/bundle/*",
        "refs/tags/*:refs/tags/*")


def reachable_commits(repo: Path, branch: str) -> list[str]:
    ref = f"refs/remotes/bundle/{branch}"
    if git(repo, "rev-parse", "--verify", ref, check=False) == "":
        die(f"bundle does not contain refs/remotes/bundle/{branch}")
    # rev-list --reverse gives parents before children, required for REST commits.
    return git(repo, "rev-list", "--reverse", ref).splitlines()


def tree_entries(repo: Path, commit: str, gh: GitHub) -> list[dict]:
    entries: list[dict] = []
    raw = subprocess.check_output(["git", "-C", str(repo), "ls-tree", "-r", "-z", commit])
    for item in raw.split(b"\0"):
        if not item:
            continue
        header, path_bytes = item.split(b"\t", 1)
        mode, kind, sha = header.decode().split()
        path = path_bytes.decode("utf-8", errors="surrogateescape")
        if kind == "commit":
            entries.append({"path": path, "mode": mode, "type": "commit", "sha": sha})
            continue
        content = subprocess.check_output(["git", "-C", str(repo), "cat-file", "blob", sha])
        blob = gh.request("POST", "/git/blobs", {
            "content": base64.b64encode(content).decode(), "encoding": "base64"
        })
        entries.append({"path": path, "mode": mode, "type": "blob",
                        "sha": blob.get("sha", sha)})
    return entries


def commit_payload(repo: Path, commit: str, mapped_parents: list[str], tree_sha: str) -> dict:
    fmt = "%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B"
    fields = git(repo, "show", "-s", f"--format={fmt}", commit).split("\0", 6)
    if len(fields) != 7:
        die(f"could not read metadata for {commit}")
    author_name, author_email, author_date, committer_name, committer_email, committer_date, message = fields
    payload = {
        "message": message, "tree": tree_sha, "parents": mapped_parents,
        "author": {"name": author_name, "email": author_email, "date": author_date},
        "committer": {"name": committer_name, "email": committer_email, "date": committer_date},
    }
    return payload


def main() -> int:
    args = parse_args()
    token = args.token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        die("set GITHUB_TOKEN or GH_TOKEN")
    if not args.repo or "/" not in args.repo:
        die("use --repo owner/name or set GITHUB_REPOSITORY")
    bundle = Path(args.bundle).expanduser().resolve()
    work = Path(tempfile.mkdtemp(prefix="github-bundle-import-"))
    try:
        import_bundle(bundle, work)
        commits = reachable_commits(work, args.branch)
        tip = commits[-1]
        gh = GitHub(token, args.repo, dry_run=not args.execute)
        print(f"[publish-bundle] repository: {args.repo}")
        print(f"[publish-bundle] branch: {args.branch}")
        print(f"[publish-bundle] commits to publish: {len(commits)}")
        print(f"[publish-bundle] bundle tip: {tip}")
        print(f"[publish-bundle] mode: {'EXECUTE' if args.execute else 'DRY-RUN'}")

        if args.execute:
            existing = gh.request("GET", f"/git/ref/heads/{args.branch}")
            if existing and not args.force:
                die(f"destination branch {args.branch} exists; use --force only intentionally")

        mapped: dict[str, str] = {}
        for index, commit in enumerate(commits, 1):
            parents = git(work, "show", "-s", "--format=%P", commit).split()
            missing = [p for p in parents if p not in mapped]
            if missing:
                die(f"parent ordering error for {commit}: {missing}")
            entries = tree_entries(work, commit, gh)
            tree = gh.request("POST", "/git/trees", {"tree": entries})
            tree_sha = tree.get("sha", f"dry-run-tree-{index}")
            created = gh.request("POST", "/git/commits",
                                 commit_payload(work, commit, [mapped[p] for p in parents], tree_sha))
            mapped[commit] = created.get("sha", commit)
            print(f"[publish-bundle] {index}/{len(commits)} {commit[:12]} -> {mapped[commit][:12]}")

        if args.execute:
            ref_path = f"/git/refs/heads/{args.branch}"
            existing = gh.request("GET", f"/git/ref/heads/{args.branch}")
            payload = {"sha": mapped[tip], "force": args.force}
            if existing:
                gh.request("PATCH", ref_path, payload)
            else:
                gh.request("POST", "/git/refs", {"ref": f"refs/heads/{args.branch}", **payload})
            print(f"[publish-bundle] published {args.repo}:{args.branch} at {mapped[tip]}")
        else:
            print("[publish-bundle] dry-run complete; no GitHub objects or refs were changed")
        return 0
    finally:
        if args.keep_worktree:
            print(f"[publish-bundle] temporary repository kept at {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
