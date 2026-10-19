// den-mvp/85: the one list of paths that make a merge a release. A merge that touches one of these changes the code the
// den runs (bridge or service), so the bridge cuts a patch tag for it; docs-only and UI-only merges get none.
// A prefix ends in "/"; anything else is an exact file. A test file never counts.
export const BRIDGE_PATHS = [
  "apps/bridge/",
  "apps/organism-infra/", // the board code the bridge imports
  "scripts/risk-check.mjs", // the scripts the bridge runs on a delivery
  "scripts/test-guard.mjs",
  "scripts/exposure.mjs",
  "package.json",
  "package-lock.json",
];

/** Whether one repository path is bridge or service code. */
export const isBridgePath = (file) => {
  const f = String(file ?? "");
  if (/\.test\.mjs$/.test(f)) return false;
  return BRIDGE_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
};

/** Whether a change (a list of paths) touches bridge or service code. */
export const touchesBridge = (files) => (Array.isArray(files) ? files : []).some(isBridgePath);
