#!/usr/bin/env bash
# Layer 1 of docs/DELIVERY-ARCHITECTURE.md, as a script rather than a promise.
#
# What it describes for `main`:
#   - changes arrive only through a pull request: `required_pull_request_reviews`
#     is set, with zero required approvals — the owner works alone, and a rule
#     nobody can satisfy stops delivery instead of protecting it
#   - the required status checks are the two jobs of the acceptance workflow,
#     `acceptance` and `fresh-install`: that workflow runs on EVERY pull
#     request, with no path filter and neither job behind `if:`/`needs:`, so
#     requiring them cannot leave a pull request waiting for ever
#   - the rules apply to administrators too (`enforce_admins`): nobody merges a
#     red pull request. That is what GitHub has for this branch today, and what
#     the owner decided for pharmacy-monitor on 2026-10-11; kept here
#   - no force push, no branch deletion
# That these settings behave as named — a direct push is refused, a status of
# the same name from another source does not count — is GitHub's description
# of them. Nobody here tried.
#
# THIS IS STILL NOT WHAT GITHUB HAS, and that is known (read again 2026-10-31,
# unchanged since 2026-10-11). The pull-request requirement, `enforce_admins`
# and the two "no" rules are on GitHub as written here. The required checks are
# not: GitHub has the single context `agent-review`, so nothing has tested the
# code of a mergeable pull request. `--check` ends in "RESULT: MISMATCH" with
# exit code 1, naming `required_status_checks`, until the owner writes:
#   bash scripts/ci/configure-main-protection.sh --apply
# The test keeps the 2026-10-11 reading as the fixture it is
# (scripts/ci/tests/fixtures/).
#
# Why `agent-review` is not in the payload, and why the acceptance jobs are.
# The owner's decision for all his repositories (2026-09-11): the gate before
# `main` is the CI that GitHub itself runs; no paid AI reviewer in CI, and never
# a required one. This repository has the reviewer required and its own tests
# required of nothing — the one state that decision rules out.
# agent-review.yml is red by design in two cases: a blocking finding of its
# model, and a diff over 400 000 bytes (refused whenever a key is set, before
# the API is called). When its API key is missing, or the API answers with an
# error status, it is green — on purpose, so that a provider outage cannot
# stop delivery. A key is set in this repository's secrets and the API has been
# answering it 400 insufficient-credit, so what it has been doing here is
# passing without reading anything.
# Before the pull request with this change (2026-10-11) the workflow had never
# run in this repository. In leaddrive-budgeting pull request #4 (2026-09-10)
# the same workflow was green under its own comment that the API had answered
# 400 and nobody had read the change. In this repository it was green that same
# way on nearly every pull request from #3 to #34: Anthropic answered 400
# insufficient-credit, and the check passed by design. Of its 112 runs up to
# this change two were red, and both refused the diff instead of reading it:
# 40455295157 on PR #2 (3 471 359 bytes) and 40584090620 on PR #3
# (404 283 bytes). Seven more were cancelled, which is not green either.
# While it is the only required check, a pull request can be merged with
# nothing having tested the code and nobody having read it. Requiring the
# acceptance jobs instead is what makes a red test stop a merge.
#
# Usage:
#   bash scripts/ci/configure-main-protection.sh --check [owner/repo]
#       read-only: compares the live protection with the payload below and
#       sends nothing.
#   bash scripts/ci/configure-main-protection.sh --apply [owner/repo]
#       writes the payload — only after a comparison that ended in "MISMATCH",
#       or on a branch GitHub reports as unprotected. Then reads the result
#       back.
# Exit codes, both modes: 0 = GitHub has what is written here (and nothing was
# sent, or the write was read back and equals the payload); 1 = it has
# something else; 2 = arguments not understood, nothing requested; 3 = could
# not tell — a read or the write failed. A status of 1 with neither a
# "RESULT: MISMATCH" line nor the "no branch protection" line above it is the
# script itself failing, not a finding.
# Without a flag it is `--check`. Always type `--check` anyway: the copies of
# this file from before this change (see below) do not know flags, and every
# run of one is a write attempt.
#
# Changed 2026-10-11, after the same file was fixed in pharmacy-monitor (its
# pull request #87), from which this one is copied. Before this change:
#   - the payload said `"required_pull_request_reviews": null`, while the
#     header promised "only through a pull request". GitHub's API description
#     reads null as "disable", and the PUT replaces the whole protection
#     object: a run against this repository would have removed the
#     pull-request requirement that is set on GitHub, and a commit could then
#     have been pushed straight to `main`. (Read from the API description.
#     Never tried. The requirement that is on GitHub was not put there by this
#     script.)
#   - it sent `"enforce_admins": false`, where GitHub has it switched on
#   - the closing report printed `pull_request_only` from the status-check
#     field, so it said `true` whatever the pull-request field held
#   - it wrote on every run, with no comparison first. Run with no arguments
#     it aimed at this repository's name under the previous account
#     (`rashadrahimov/…`), not at this repository; given `rashadoni/…` as its
#     argument it would have written here
# Now the payload carries the pull-request requirement, the report is a
# comparison of what GitHub returns with the payload, and writing takes an
# explicit flag.
#
# NOT VERIFIED BY A RUN, as of 2026-10-31: `--apply` has never sent its write
# to GitHub — branch protection is not changed for the sake of a test, and the
# session that wrote this payload had the write refused by its own sandbox.
# What was checked instead: the payload against the live protection, by reading
# it on 2026-10-31 (it differs in the required checks only, as said above —
# `--check`, exit 1); the comparison filter in gh's own jq, on that same read;
# and the script against a stand-in `gh` that never reaches the network
# (scripts/ci/tests/test_main_protection_script.py — run by hand, see its first
# lines; 176 passed, 1 skipped on 2026-10-31; no workflow of this repository
# runs it).
# This payload is what the repository's own test had been asking for since the
# acceptance workflow appeared: before this change it failed with "a workflow
# that runs on pull request appeared, and the protection script requires no
# check".
# The pull request carrying this payload already rewrote every place that
# called `agent-review` the required check: Layers 1 and 2 and rule 3 of
# docs/DELIVERY-ARCHITECTURE.md, the delivery section at the top of AGENTS.md,
# and the header of .github/workflows/agent-review.yml ("the ONLY required
# check on main" is nowhere in the repository now). What is left for AFTER the
# first real write is every place that says the write has not happened:
#   - this paragraph and the "STILL NOT WHAT GITHUB HAS" one above
#   - the note in Layer 1 of docs/DELIVERY-ARCHITECTURE.md
#   - the warning line in the delivery section of AGENTS.md, and the
#     parenthetical in the sentence above it
#   - the last paragraph of the .github/workflows/agent-review.yml header
#
# Before `--apply`:
#   - it is the owner's call for this repository, not an agent's
#   - know what it does here: it requires the acceptance workflow's two jobs and
#     removes `agent-review` from the required checks. What is lost with it is
#     its refusal of a diff over 400 000 bytes — the ONLY thing that has ever
#     made this gate red here (PR #2 and PR #3, see above), and the acceptance
#     jobs have no diff-size cap — plus a blocking finding of its model, which
#     the credit-exhausted key has never produced. What is gained is that the
#     tests, the build, the migrations and the browser acceptance now have to
#     pass before a merge
#   - and know what it costs: a CANCELLED run is not a success, and sessions
#     here routinely cancel a "redundant doc-only" acceptance run (the session
#     log records twenty of them, and commit 18e7f1c carries `acceptance` and
#     `fresh-install` as cancelled). That already blocks a merge today — four
#     commits carry a cancelled `agent-review` — but agent-review.yml cancels
#     itself by supersession (`cancel-in-progress: true`), while an acceptance
#     run is cancelled on purpose and costs ~7 minutes to start again. So:
#     cancel the run of a commit you do not intend to merge on, or re-run it
#     before merging
#   - use the file from `origin/main` after a `git fetch`, not a local `main`
#     and not another branch. Every branch and worktree cut before this change
#     was merged carries the old file, whatever its date. The old file is the
#     one without `--apply` in it:
#       grep -c -- '--apply' scripts/ci/configure-main-protection.sh   # 0 = old
#   - run `--check` first and read what differs: the write replaces every
#     setting below, including one somebody changed on purpose — a required
#     check added by hand is removed by it
set -euo pipefail
# Character ranges in the patterns below mean ASCII, whatever the caller's locale.
export LC_ALL=C

usage() {
  echo "Usage: bash scripts/ci/configure-main-protection.sh --check|--apply [owner/repo]" >&2
  exit 2
}

# Writing is never the default, and an argument that is not exactly a flag or
# an owner/repo pair stops the script before the first request.
MODE=check
case "${1:-}" in
  --check) shift ;;
  --apply) MODE=apply; shift ;;
esac
[[ $# -le 1 ]] || usage

# This repository under the rashadoni account. The old default named it under
# the previous account, `rashadrahimov/…`.
REPO="rashadoni/leadprocure"
[[ $# -eq 0 ]] || REPO="$1"
REPO_SHAPE='^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$'
[[ "${REPO}" =~ ${REPO_SHAPE} ]] || usage
[[ "${REPO##*/}" != "." && "${REPO##*/}" != ".." ]] || usage

# Not taken from the environment: a BRANCH exported for something else must not
# point a protection write at another branch.
BRANCH="main"
ENDPOINT="repos/${REPO}/branches/${BRANCH}/protection"

command -v gh >/dev/null || { echo "gh is required" >&2; exit 3; }

# The whole protection object. PUT replaces it. The API description gives every
# optional setting a default, so one left out is expected to fall back to that
# default rather than keep its value (inferred from the description, not stated
# there, not tried) — which is why every top-level setting the endpoint takes
# is spelled out, and why `required_pull_request_reviews` must never be null
# again. Inside it, `dismissal_restrictions` and
# `bypass_pull_request_allowances` are left out on purpose: nobody is to bypass
# the pull-request requirement. That leaving them out clears an allowance
# already set is assumed too; the comparison shows one that survived.
#
# `required_status_checks` names the two jobs of .github/workflows/acceptance.yml
# (15368 is GitHub Actions, so a status of the same name from anywhere else does
# not count). They qualify because that workflow starts on EVERY pull request:
# no path filter, no `types`, and neither job behind `if:`, `needs:` or a
# matrix. The presentation and release workflows are left out because they ARE
# path-filtered: a workflow that does not start publishes no check run at all,
# so a pull request outside its paths waits for it for ever. (A job skipped by
# `if:`/`needs:` inside a workflow that DID start is the other case: GitHub
# counts a skip as success, so such a job cannot hold a gate at all — which is
# why the test refuses `if:`/`needs:` on anything required here. Neither of
# those two workflows is shaped that way either.) Keep this list and
# REQUIRED_CHECKS of the test in step, in one pull request.
# The other workflow, agent-review.yml, is not a gate (see the header).
IFS= read -r -d '' DESIRED <<'JSON' || true
{
  "required_status_checks": {
    "strict": false,
    "checks": [
      {"context": "acceptance", "app_id": 15368},
      {"context": "fresh-install", "app_id": 15368}
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON

# Turns GitHub's answer into the shape of the payload and compares the two,
# setting by setting. It runs inside `gh api --jq`, with the payload bound to
# $want (JSON is valid jq). The last line it prints is the verdict; everything
# before it is for the reader, and is taken from GitHub's answer, not from the
# payload. Only the two exact verdict lines count: output that ends in anything
# else is "could not tell", never "different".
#
# What "match" means: every setting this script writes has, on GitHub, the
# value written here. A setting GitHub does not return counts as a difference,
# not as "off" — except `required_status_checks`: GitHub leaves it out when
# the setting is off, so there absent and null are the same thing. (The
# setting switched on with an empty list of checks is not the same thing, and
# counts as a difference from null.) What it does not look at: anything this
# endpoint does not write — commit signatures, repository rulesets.
IFS= read -r -d '' COMPARE <<'JQ' || true
| ($want
   | if .required_status_checks == null then .
     else .required_status_checks.checks |= sort_by(.context)
     end) as $want
| {
    required_status_checks: (
      .required_status_checks
      | if . == null then null
        else {strict, checks: ((.checks // []) | map({context, app_id}) | sort_by(.context))}
        end
    ),
    enforce_admins: .enforce_admins.enabled,
    required_pull_request_reviews: (
      .required_pull_request_reviews | if . == null then null else del(.url) end
    ),
    restrictions: .restrictions,
    required_linear_history: .required_linear_history.enabled,
    allow_force_pushes: .allow_force_pushes.enabled,
    allow_deletions: .allow_deletions.enabled,
    block_creations: .block_creations.enabled,
    required_conversation_resolution: .required_conversation_resolution.enabled,
    lock_branch: .lock_branch.enabled,
    allow_fork_syncing: .allow_fork_syncing.enabled
  } as $live
| [$want | keys[] | select($want[.] != $live[.])] as $differs
| "pull request required  : \($live.required_pull_request_reviews != null)",
  "required approvals     : \($live.required_pull_request_reviews.required_approving_review_count)",
  "required checks        : \([$live.required_status_checks.checks // [] | .[] | .context] | join(", "))",
  "applies to admins      : \($live.enforce_admins)",
  "force pushes allowed   : \($live.allow_force_pushes)",
  "branch deletion allowed: \($live.allow_deletions)",
  ($differs[] | "DIFFERS \(.): this script sets \($want[.] | tojson), GitHub has \($live[.] | tojson)"),
  (if ($differs | length) == 0 then "RESULT: match" else "RESULT: MISMATCH" end)
JQ

NL=$'\n'

# Reads the protection and sets STATE (what to show) and VERDICT:
#   match | mismatch   the comparison ran and said so
#   unprotected        GitHub answered that the branch has no protection
#   unknown            anything else: an error, a refusal, an answer this
#                      script cannot read. Never a reason to write.
# "Unprotected" is GitHub's 404 body, which gh prints on stdout: a JSON object
# carrying that message. The comparison's own output never starts with a brace.
compare() {
  VERDICT=unknown
  if STATE="$(gh api "${ENDPOINT}" -H "Accept: application/vnd.github+json" \
    --jq "(${DESIRED}) as \$want ${COMPARE}")"; then
    case "${STATE##*"${NL}"}" in
      "RESULT: match") VERDICT=match ;;
      "RESULT: MISMATCH") VERDICT=mismatch ;;
    esac
  elif [[ "${STATE}" == "{"* && "${STATE}" == *'"Branch not protected"'* ]]; then
    VERDICT=unprotected
  fi
}

show() {
  case "${VERDICT}" in
    match | mismatch) printf '%s\n' "${STATE}" ;;
    unprotected) echo "${REPO}@${BRANCH} has no branch protection at all." ;;
    *)
      [[ -z "${STATE}" ]] || printf '%s\n' "${STATE}" >&2
      echo "Could not read the protection of ${REPO}@${BRANCH}: see above." >&2
      ;;
  esac
}

echo "Comparing ${REPO}@${BRANCH} with this script."
compare
show
case "${VERDICT}" in
  match)
    echo "Nothing to change, nothing sent."
    exit 0
    ;;
  mismatch | unprotected) ;;
  *)
    # Writing over a state nobody has seen is exactly what this script is for
    # preventing.
    echo "Nothing was sent." >&2
    exit 3
    ;;
esac

if [[ "${MODE}" != apply ]]; then
  echo "Nothing was sent. Writing is --apply, and it is the owner's call."
  exit 1
fi

echo
echo "Writing branch protection to ${REPO}@${BRANCH}"
if ! response="$(gh api -X PUT "${ENDPOINT}" -H "Accept: application/vnd.github+json" \
  --input - <<<"${DESIRED}")"; then
  printf '%s\n' "${response}" >&2
  echo "The write request ended in an error: see above. What GitHub has now:" >&2
  compare
  show >&2
  exit 3
fi

echo "Sent. Read back from GitHub:"
compare
show
case "${VERDICT}" in
  match) ;;
  mismatch | unprotected)
    echo >&2
    echo "GitHub accepted the write, but ${REPO}@${BRANCH} is NOT in the state this" >&2
    echo "script describes: see above. Do not report it as protected." >&2
    exit 1
    ;;
  *)
    echo "The write was accepted, but the protection could not be read back." >&2
    echo "Treat ${REPO}@${BRANCH} as unverified until --check passes." >&2
    exit 3
    ;;
esac

echo
echo "Note: the rules apply to administrators too. The required checks are the"
echo "acceptance workflow's own jobs, so a red test stops a merge; the AI"
echo "reviewer is not among them, by the owner's decision (2026-09-11)."
