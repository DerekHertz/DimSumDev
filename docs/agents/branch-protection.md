# Branch protection and CI checks

Owned by `security`. Applying or changing protection on `main` is a pass gate: security prepares the command, the user runs it. Origin: organism-infra/161 (158 security finding: the repo is public and `main` was unprotected).

## CI check names

`.github/workflows/ci.yml` defines two jobs, and the job `name:` is the check name GitHub reports:

- `test`: `npm ci`, Playwright Chromium, `npm test`.
- `security`: gitleaks secret scan plus `npm audit --audit-level=high`.

Both come from the GitHub Actions app (app id 15368). `gh pr checks <n>` lists them as `test` and `security`. Renaming a job breaks the required check (merges then wait forever), so change the workflow and the settings below together.

## Settings for `main` (classic branch protection)

The exact payload is `docs/agents/branch-protection-main.json`.

- Pull request required before merging, zero required approvals (single maintainer; relay autonomy merges on green).
- Required status checks `test` and `security`, pinned to app id 15368 so no other app can satisfy them. `strict: false`: the branch need not be up to date with `main` (up-to-date would force a rebase and a CI re-run on every concurrent PR).
- Force pushes and branch deletion blocked.
- `enforce_admins: false`: admin bypass stays on (user, 2026-10-06), so the orchestrator's board-only pushes to `main` (organism-infra/158) keep working under the user's credentials. organism-infra/159 adds the pre-push gitleaks check for that path.

Why classic and not a ruleset: the ticket asks for "admins not enforced", which classic expresses in one field. A ruleset would need a bypass actor entry for the repository admin role to get the same result, and it adds nothing else here. Revisit if the repo gains collaborators or needs tag protection.

Residual risk (low): with admin bypass, the owner's credentials can push directly to `main` and can force push. The protection stops non-admin pushes, red PRs, and accidental deletion. A stolen admin token is not covered; keep the token scope narrow.

## Apply (user runs this)

```
gh api -X PUT repos/DerekHertz/DimSumDev/branches/main/protection --input docs/agents/branch-protection-main.json
```

Run it from a checkout that contains the JSON file (after this branch merges, or from the branch's worktree).

## Verify

```
gh api repos/DerekHertz/DimSumDev/branches/main/protection --jq '{checks: .required_status_checks.checks, strict: .required_status_checks.strict, approvals: .required_pull_request_reviews.required_approving_review_count, admins: .enforce_admins.enabled, force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'
```

Expected:

```
{"admins":false,"approvals":0,"checks":[{"app_id":15368,"context":"test"},{"app_id":15368,"context":"security"}],"deletions":false,"force_push":false,"strict":false}
```

A 404 `Branch not protected` means protection is off. Do not verify with a live test push.

## Roll back

```
gh api -X DELETE repos/DerekHertz/DimSumDev/branches/main/protection
```

## For a target

A target project's `main` needs its own protection; the den never applies it. Onboard with `--checks <names>` (the required status check names in the target's CI), then:

1. `npm run den:project -- verify <slug>` reads the target's `main` protection through the bridge's `gh` login (a GET only). It passes when every named check is required.
2. If one is missing it prints the `gh api -X PUT repos/<owner>/<name>/branches/main/protection --input -` command, built from `branch-protection-main.json` with the target's check names in place of `test` and `security`. The user reads it and runs it; the bridge never does.
3. Merge policy (`apps/bridge/project-policy.mjs`): security reviews every change; a change to the root `package.json`, a lockfile, a root dot path or CI config waits for the user; the bridge merges the rest on green. The delivery applies it (team-and-den-ux/05).
