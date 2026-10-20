// organism-infra/77: the one source for what may leave the machine.
// SECRET_PATTERNS is shared by risk-check.mjs (diff scan) and jev.mjs (input
// block); DENIED_PATHS is the file list no caller may read into a request.
// Every pattern is non-global (stateless `.test`) and anchored so it runs in
// linear time on long input.
import path from "node:path";

import { SECRET_PATTERNS } from "../apps/shared/secret-patterns.mjs";
export { SECRET_PATTERNS, hasSecret } from "../apps/shared/secret-patterns.mjs";

// Matched against the absolute path with forward slashes.
export const DENIED_PATHS = [
  { name: ".env file", re: /(^|\/)\.env[^/]*$/i },
  { name: "credentials file", re: /(^|\/)credentials[^/]*$/i },
  { name: "key or certificate", re: /\.(pem|key)$/i },
  { name: "git directory", re: /(^|\/)\.git(\/|$)/ },
  { name: "hidden path", re: /(^|\/)\.[^/]+/ },
  { name: "board handoffs", re: /(^|\/)\.scratch\/(.+\/)?handoffs(\/|$)/ },
  { name: "handoff inbox", re: /(^|\/)_handoffs(\/|$)/ },
  { name: "gate requests", re: /(^|\/)_requests(\/|$)/ },
  { name: "lock file", re: /\.lock$/i },
  { name: "usage log", re: /(^|\/)usage\.jsonl$/i },
];

export function isDenied(p) {
  const abs = path.resolve(String(p)).split(path.sep).join("/");
  return DENIED_PATHS.some((d) => d.re.test(abs));
}
