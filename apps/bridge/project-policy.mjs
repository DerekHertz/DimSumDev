// multi-project/03: a project's policy, read from its registry row (design decisions 28 and 30).
// The delivery that consumes it is team-and-den-ux/05.
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "Cargo.lock", "poetry.lock", "Pipfile.lock", "go.sum", "Gemfile.lock", "composer.lock", "uv.lock"]);
const ROOT_CI_FILES = new Set(["Jenkinsfile", "azure-pipelines.yml"]); // the CI files not under a root dot path

/** True when a changed path (repo-relative) waits for the user under the default merge rule. */
export function waitsForUser(file) {
  const p = String(file).replace(/^\.\//, "");
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (p === "package.json") return true;
  if (LOCKFILES.has(base)) return true;
  if (p.startsWith(".")) return true; // a root dot path: .github, .npmrc, .env, .husky ...
  return ROOT_CI_FILES.has(p);
}

/** -> { checks, mergeRule } for a registry row. */
export function projectPolicy(row) {
  const checks = Array.isArray(row?.checks) ? row.checks.filter((c) => typeof c === "string" && c !== "") : [];
  return {
    checks,
    mergeRule: {
      security: "every-change",
      /** -> { action: "user" | "bridge", reasons: [paths that wait] } */
      classify(files) {
        const reasons = (files ?? []).filter(waitsForUser);
        return { action: reasons.length > 0 ? "user" : "bridge", reasons };
      },
    },
  };
}
