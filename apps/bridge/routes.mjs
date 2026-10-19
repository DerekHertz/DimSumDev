// organism-infra/139 (ADR 0016 decision 6.1): the one route registry. Every route the bridge answers is a row
// here; the server dispatches from it and the auth tests enumerate it, so a new route is gated by default.
//   auth: "none"   a read; no Origin or token needed (GET only)
//         "origin" Origin and Content-Type checked, no Bearer (POST /session: this is how a token is obtained)
//         "token"  Origin, Content-Type and a valid session token
//         "run"    Origin, Content-Type and the token of a live run (den-mvp/38: the den script calling back for Bao)
// service: true  den-mvp/88: the router's service token is accepted too (a session token always is on a "token" row)
// A request that matches no row is a 404 (GET and HEAD fall through to the static UI build).
export const ROUTES = [
  { method: "GET", path: "/state", auth: "none", mutating: false },
  { method: "GET", path: "/metrics", auth: "none", mutating: false },
  { method: "GET", path: "/events", auth: "none", mutating: false },
  { method: "GET", path: "/library", auth: "none", mutating: false },
  { method: "POST", path: "/session", auth: "origin", mutating: true },
  { method: "POST", path: "/requests", auth: "token", mutating: true },
  { method: "POST", path: "/agents", auth: "token", mutating: true },
  { method: "POST", path: "/tasks", auth: "token", mutating: true },
  { method: "POST", path: "/agents/:id/stop", auth: "token", mutating: true },
  { method: "POST", path: "/agents/:id/message", auth: "token", mutating: true },
  { method: "POST", path: "/agents/:id/message/cancel", auth: "token", mutating: true },
  { method: "POST", path: "/agents/:id/handover", auth: "token", mutating: true },
  { method: "GET", path: "/approvals/:id", auth: "token", mutating: false },
  { method: "POST", path: "/approvals/:id", auth: "token", mutating: true },
  { method: "GET", path: "/conversations/:role", auth: "token", mutating: false },
  { method: "POST", path: "/conversations/:role/message", auth: "token", mutating: true },
  { method: "POST", path: "/deliveries", auth: "token", mutating: true, service: true },
  { method: "POST", path: "/deliveries/:id/resume", auth: "token", mutating: true, service: true },
  { method: "POST", path: "/router-stops", auth: "token", mutating: true, service: true },
  { method: "POST", path: "/router-stops/:id/dismiss", auth: "token", mutating: true },
  { method: "POST", path: "/deliveries/:id/stop", auth: "token", mutating: true },
  { method: "POST", path: "/deliveries/:id/close", auth: "token", mutating: true },
  { method: "POST", path: "/meetings", auth: "token", mutating: true },
  { method: "GET", path: "/meetings/:id", auth: "token", mutating: false },
  { method: "POST", path: "/meetings/:id/resume", auth: "token", mutating: true },
  { method: "POST", path: "/meetings/:id/stop", auth: "token", mutating: true },
  { method: "POST", path: "/meetings/:id/close", auth: "token", mutating: true },
  { method: "POST", path: "/meetings/:id/decide", auth: "token", mutating: true },
  { method: "POST", path: "/meetings/:id/ask", auth: "token", mutating: true },
  { method: "POST", path: "/build/rollback", auth: "token", mutating: true },
  { method: "POST", path: "/tickets/approve", auth: "token", mutating: true },
  { method: "POST", path: "/tickets/decline", auth: "token", mutating: true },
  { method: "POST", path: "/tickets/transfer", auth: "token", mutating: true },
  { method: "POST", path: "/admission/runtime", auth: "token", mutating: true },
  { method: "POST", path: "/release/approve", auth: "token", mutating: true },
  { method: "POST", path: "/release/decline", auth: "token", mutating: true },
  { method: "POST", path: "/update/now", auth: "token", mutating: true },
  { method: "POST", path: "/update/relaunch", auth: "token", mutating: true },
  { method: "POST", path: "/update/auto", auth: "token", mutating: true },
  { method: "POST", path: "/checks", auth: "token", mutating: true },
  { method: "GET", path: "/projects", auth: "token", mutating: false },
  { method: "POST", path: "/projects/active", auth: "token", mutating: true },
  { method: "GET", path: "/projects/:slug/board", auth: "token", mutating: false },
  { method: "POST", path: "/den-tools/:tool", auth: "run", mutating: true },
  { method: "GET", path: "/recover", auth: "none", mutating: false },
  { method: "GET", path: "/recover/script", auth: "none", mutating: false },
];

// den-mvp/09 (ADR 0026 decision 5): the reads a preview listener answers, written out. A row is not on this list by being
// a GET: a read added to ROUTES is refused on a preview until it is added here too. Each entry is a GET row above.
// Every entry is a read that needs no token on the den: a preview has no token of its own, so a read that needs one (a
// meeting, a conversation) is not offered there.
export const PREVIEW_READS = ["/state", "/events", "/library"];

// ":name" segments match any one non-empty segment. Paths are matched exactly (no trailing slash, case-sensitive).
const compile = (path) => new RegExp(`^${path.replace(/:\w+/g, "[^/]+")}$`);
const COMPILED = ROUTES.map((row) => ({ row, re: compile(row.path) }));

export function matchRoute(method, pathname) {
  return COMPILED.find(({ row, re }) => row.method === method && re.test(pathname))?.row ?? null;
}

/** Whether any row, of any method, has this path. */
export const isRoutePath = (pathname) => COMPILED.some(({ re }) => re.test(pathname));
