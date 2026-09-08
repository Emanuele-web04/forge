#!/usr/bin/env bash
set -Eeuo pipefail

# Automates sequential conflict resolution and PR merging through GitHub's REST API.
#
# Safe by default: without --execute, the script only validates prerequisites and
# prints the planned operations. Use --execute only after reviewing the plan.
# Conflict strategy:
#   When updating a PR branch with the current base branch, -X ours preserves the
#   PR branch's changes at conflict hunks. This is intentional for stacked PRs;
#   review the resulting branch and checks before enabling automatic merging.
#
# Required environment:
#   GITHUB_TOKEN or GH_TOKEN  GitHub token with contents:write and pull_requests:write
#   GITHUB_REPOSITORY         owner/repository (or pass --repo owner/repository)
#
# Example:
#   export GITHUB_TOKEN=...
#   export GITHUB_REPOSITORY=Frankenstein-Labs/synara
#   ./scripts/merge-prs-via-github-api.sh --prs 6,7,8 --execute

API_ROOT="https://api.github.com"
REPO="${GITHUB_REPOSITORY:-}"
BASE_BRANCH="main"
PRS="6,7,8"
WORKTREE=""
CONFLICT_STRATEGY="ours"
MERGE_METHOD="merge"
EXECUTE=0
KEEP_WORKTREE=0
POLL_SECONDS=3
POLL_ATTEMPTS=20

usage() {
  cat <<'EOF'
Usage:
  merge-prs-via-github-api.sh [options]

Options:
  --repo OWNER/REPO              GitHub repository (default: $GITHUB_REPOSITORY)
  --base BRANCH                  Base branch (default: main)
  --prs N,N,N                    PRs in merge order (default: 6,7,8)
  --worktree PATH                Temporary working directory
  --conflict-strategy ours|theirs
                                 Conflict preference when merging base into PR branch
                                 (default: ours; preserves PR changes)
  --merge-method merge|squash|rebase
                                 GitHub merge method (default: merge)
  --execute                      Push branches and merge PRs; otherwise dry-run
  --keep-worktree                Keep the temporary worktree after completion
  -h, --help                     Show this help

Environment:
  GITHUB_TOKEN or GH_TOKEN       API token
  GITHUB_REPOSITORY              owner/repository
EOF
}

log() { printf '[merge-prs] %s\n' "$*"; }
die() { printf '[merge-prs] ERROR: %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --base) BASE_BRANCH="$2"; shift 2 ;;
    --prs) PRS="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    --conflict-strategy) CONFLICT_STRATEGY="$2"; shift 2 ;;
    --merge-method) MERGE_METHOD="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --keep-worktree) KEEP_WORKTREE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
[[ -n "$TOKEN" ]] || die 'Set GITHUB_TOKEN or GH_TOKEN.'
[[ "$REPO" =~ ^[^/]+/[^/]+$ ]] || die 'Repository must be owner/name.'
[[ "$CONFLICT_STRATEGY" == ours || "$CONFLICT_STRATEGY" == theirs ]] || die 'Conflict strategy must be ours or theirs.'
[[ "$MERGE_METHOD" == merge || "$MERGE_METHOD" == squash || "$MERGE_METHOD" == rebase ]] || die 'Merge method must be merge, squash, or rebase.'
command -v curl >/dev/null || die 'curl is required.'
command -v jq >/dev/null || die 'jq is required.'
command -v git >/dev/null || die 'git is required.'

IFS=',' read -r -a PR_LIST <<< "$PRS"
((${#PR_LIST[@]} > 0)) || die 'At least one PR is required.'
for pr in "${PR_LIST[@]}"; do [[ "$pr" =~ ^[0-9]+$ ]] || die "Invalid PR number: $pr"; done

if [[ -z "$WORKTREE" ]]; then
  WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/github-pr-merge.XXXXXX")"
  AUTO_WORKTREE=1
else
  mkdir -p "$WORKTREE"
  AUTO_WORKTREE=0
fi

cleanup() {
  if ((AUTO_WORKTREE)) && ((KEEP_WORKTREE == 0)); then rm -rf "$WORKTREE"; fi
}
trap cleanup EXIT

AUTH_B64="$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
API_HEADERS=(-H "Accept: application/vnd.github+json" -H "Authorization: Bearer $TOKEN" -H 'X-GitHub-Api-Version: 2022-11-28')
GIT_AUTH_ARGS=(-c "http.extraHeader=AUTHORIZATION: basic $AUTH_B64")
API_REPO_URL="$API_ROOT/repos/$REPO"

api() {
  local method="$1" url="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl --fail-with-body --silent --show-error --request "$method" "${API_HEADERS[@]}" \
      --header 'Content-Type: application/json' --data "$body" "$url"
  else
    curl --fail-with-body --silent --show-error --request "$method" "${API_HEADERS[@]}" "$url"
  fi
}

git_auth() { git "${GIT_AUTH_ARGS[@]}" "$@"; }

PR_JSON=()
for pr in "${PR_LIST[@]}"; do
  log "Inspecting PR #$pr"
  json="$(api GET "$API_REPO_URL/pulls/$pr")" || die "Cannot read PR #$pr."
  state="$(jq -r '.state' <<<"$json")"
  base="$(jq -r '.base.ref' <<<"$json")"
  head_repo="$(jq -r '.head.repo.full_name // empty' <<<"$json")"
  [[ "$state" == open ]] || die "PR #$pr is not open (state=$state)."
  [[ "$base" == "$BASE_BRANCH" ]] || die "PR #$pr targets $base, expected $BASE_BRANCH."
  [[ "$head_repo" == "$REPO" ]] || die "PR #$pr comes from a fork ($head_repo); refusing automatic branch writes."
  PR_JSON+=("$json")
done

log "Repository: $REPO"
log "Base branch: $BASE_BRANCH"
log "PR order: ${PR_LIST[*]}"
log "Conflict strategy: -X $CONFLICT_STRATEGY"
log "Mode: $([[ $EXECUTE -eq 1 ]] && echo EXECUTE || echo DRY-RUN)"
((EXECUTE)) || { log 'Dry-run complete. Re-run with --execute to push and merge.'; exit 0; }

REMOTE_URL="$(git -C "$WORKTREE" remote get-url origin 2>/dev/null || true)"
if [[ -z "$REMOTE_URL" ]]; then
  git_auth clone "https://github.com/$REPO.git" "$WORKTREE"
else
  git_auth -C "$WORKTREE" fetch origin --prune
fi

# Ensure the worktree is a clean clone/worktree before making branch updates.
git -C "$WORKTREE" fetch origin "$BASE_BRANCH"
git -C "$WORKTREE" checkout --detach "origin/$BASE_BRANCH"
git -C "$WORKTREE" reset --hard "origin/$BASE_BRANCH"
git -C "$WORKTREE" clean -fd

git_identity_configured=0
if git -C "$WORKTREE" config user.email >/dev/null 2>&1; then git_identity_configured=1; fi
if ((git_identity_configured == 0)); then
  git -C "$WORKTREE" config user.name 'GitHub PR Merge Automation'
  git -C "$WORKTREE" config user.email 'github-pr-merge-automation@users.noreply.github.com'
fi

for i in "${!PR_LIST[@]}"; do
  pr="${PR_LIST[$i]}"
  json="${PR_JSON[$i]}"
  head_ref="$(jq -r '.head.ref' <<<"$json")"
  head_sha="$(jq -r '.head.sha' <<<"$json")"
  log "Preparing PR #$pr ($head_ref @ ${head_sha:0:12})"

  git_auth -C "$WORKTREE" fetch origin "$head_ref" "$BASE_BRANCH"
  git -C "$WORKTREE" checkout --detach "origin/$head_ref"
  git -C "$WORKTREE" reset --hard "origin/$head_ref"
  git -C "$WORKTREE" clean -fd

  # Merge the current base into the PR branch. With -X ours, conflict hunks
  # retain the PR branch's implementation while non-conflicting base changes land.
  if ! git -C "$WORKTREE" merge --no-edit --no-ff -X "$CONFLICT_STRATEGY" "origin/$BASE_BRANCH"; then
    git -C "$WORKTREE" merge --abort || true
    die "PR #$pr still has conflicts. Resolve manually; no push or merge was performed for it."
  fi
  if git -C "$WORKTREE" grep -n -E '^(<<<<<<<|=======|>>>>>>>)' HEAD -- ':!*.lock'; then
    die "Conflict markers remain after resolving PR #$pr."
  fi

  resolved_sha="$(git -C "$WORKTREE" rev-parse HEAD)"
  log "Resolved PR #$pr at $resolved_sha"
  git_auth -C "$WORKTREE" push --force-with-lease origin "HEAD:$head_ref"

  # Refresh the PR state after the branch update; GitHub may briefly report an
  # unknown mergeability state while it recalculates checks and mergeability.
  for ((attempt=1; attempt<=POLL_ATTEMPTS; attempt++)); do
    refreshed="$(api GET "$API_REPO_URL/pulls/$pr")"
    mergeable="$(jq -r '.mergeable // "unknown"' <<<"$refreshed")"
    merge_state="$(jq -r '.mergeable_state // "unknown"' <<<"$refreshed")"
    [[ "$mergeable" != unknown ]] && break
    sleep "$POLL_SECONDS"
  done
  [[ "$mergeable" == true ]] || die "PR #$pr is not mergeable (mergeable=$mergeable, state=$merge_state)."
  [[ "$merge_state" != blocked && "$merge_state" != dirty ]] || die "PR #$pr is blocked or dirty (state=$merge_state)."

  merge_payload="$(jq -cn --arg sha "$resolved_sha" --arg method "$MERGE_METHOD" '{sha:$sha,merge_method:$method}')"
  merge_result="$(api PUT "$API_REPO_URL/pulls/$pr/merge" "$merge_payload")" || die "GitHub refused merge of PR #$pr."
  merged="$(jq -r '.merged' <<<"$merge_result")"
  [[ "$merged" == true ]] || die "GitHub did not merge PR #$pr: $(jq -r '.message // "unknown error"' <<<"$merge_result")"
  log "Merged PR #$pr successfully."

  # The next PR must be based on the newly updated remote base.
  git_auth -C "$WORKTREE" fetch origin "$BASE_BRANCH"
done

log 'All requested PRs were resolved, pushed, and merged successfully.'
