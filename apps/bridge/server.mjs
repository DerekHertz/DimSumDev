// Localhost bridge (ADR 0011 decision 2). Tickets 04 and 05: GET /state and GET /events, plus
// the loopback binding and Host-header hardening that apply to every route.
// SSE, /metrics, POST /requests and static files arrive in tickets 05 and 06.
import { goalProblem } from "../board/goals.mjs";
import http from "node:http";
import { wallTables } from "./agents/claude-adapter.mjs";
import { createProfile } from "./agents/profile.mjs";
import { fileURLToPath } from "node:url";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { createHost } from "./agents/host.mjs";
import { COORDINATORS } from "./agents/admission.mjs";
import { createProjects } from "./projects.mjs";
import { buildSnapshot } from "./snapshot.mjs";
import { branchesOf } from "./delivery/branches.mjs";
import { createLedger } from "./agents/ledger.mjs";
import { createDelivery } from "./delivery/runner.mjs";
import { createProjectBoards } from "./board/project-boards.mjs";
import { createRunClaims, ownerGone } from "./run-claims.mjs";
import { createReleaseDrafts } from "./delivery/release-draft.mjs";
import { createAutoRelease } from "./delivery/release-auto.mjs";
import { createReadyRelease } from "./build/ready-release.mjs";
import { createGitHost } from "./delivery/git-host.mjs";
import { createJobLog } from "./delivery/jobs.mjs";
import { createCiWatch } from "./delivery/ci-watch.mjs";
import { summarize } from "./delivery/checks.mjs";
import { createMeetings } from "./meetings/runner.mjs";
import { createMeetingStore } from "./meetings/store.mjs";
import { createMeetingLog } from "./meetings/log.mjs";
import { TOPIC_MAX_BYTES } from "./meetings/types.mjs";
import { DEN_FEATURE, DESK_REF, TASK_MAX_BYTES, deskRefOf } from "./agents/policy.mjs";
import { BoardError, comment, isBoardRole, modeAllowed, resolve, resolveShortRef } from "../board/board-service.mjs";
import { appendToOrder } from "../router/order.mjs";
import { cleanText } from "./agents/approvals.mjs";

// den-mvp/55: Bao's board_file batch. The allow is matched against the whole batch as the user saw it (cleaned the way
// the approval store cleans an input), so a changed list is a new request.
const FILE_BATCH_MAX = 12;
const FILE_TEXT_MAX_BYTES = 8192; // F34: a ticket body; a design ticket runs past the 2 KB message cap
const FULL_REF_RE = /^[a-z0-9-]+\/\d+(?:-[a-z0-9-]+)?$/;
const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const slugOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "ticket";
const cleanDeep = (v) => (typeof v === "string" ? cleanText(v) : Array.isArray(v) ? v.map(cleanDeep)
  : isPlainObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [cleanText(k), cleanDeep(x)])) : v);
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : isPlainObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
import { hasSecret } from "../../scripts/exposure.mjs";
import { REQUEST_KINDS, ROUTER_STOP, appendRequestLine, foldRequests, readRequestRows } from "./requests-log.mjs";
import { createHub } from "./watch.mjs";
import { createUsageReading } from "./usage-reading.mjs";
import { parseCatalog } from "./library/catalog.mjs";
import { createLibrary } from "./library/library.mjs";
import { createAuth } from "./auth.mjs";
import { PREVIEW_READS, matchRoute } from "./routes.mjs";
import { computeMetrics, parseJsonl } from "../../scripts/metrics.mjs";
import { contentTypeFor } from "../ci-cd/dev-server.mjs";
import { ReleaseError, readBuild, resolveUi } from "./build/releases.mjs";
import { createUpdater } from "./build/update.mjs";
import { createDenBuild } from "./build/den-build.mjs";
import { redactChange, redactSnapshot } from "./build/preview.mjs";
import { RECOVER_HTML, RECOVER_SCRIPT } from "./build/recover.mjs";

const DEFAULT_UI_DIR = fileURLToPath(new URL("../ui/dist", import.meta.url));

const HOST = "127.0.0.1";
const MAX_BODY = 4096;
const DEN_TOOL_MAX_BODY = 256 * 1024; // F34: a full board_file batch, 12 bodies of up to 8 KB each, escaped as JSON
// 07 security forward: the panel renders agent text; forbid inline and foreign script.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";

// den-mvp/30: Bao's desk ticket, written the first time the user talks to Bao, if it is missing (flag "wx": never over the board's own copy). Parked, so it is
// in no queue, no audit flags it idle, and no route can dispatch a run on it.
const DESK_TICKET = `# ${DESK_REF.split("/")[1].slice(0, 2)}: Bao's desk

**Type:** task

**Priority:** P3

**Status:** parked

**Blocked by:** none

**Source:** den-mvp/30. The bridge keeps this ticket: the user's conversation with Bao in the den runs on it. It is never worked.

## Comments
`;
async function ensureDesk(root, runtime = "claude") {
  const [feature, name] = deskRefOf(runtime).split("/");
  const dir = path.join(root, ".scratch", feature, "issues");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.md`), runtime === "codex" ? DESK_TICKET.replaceAll("Bao", "Jiao") : DESK_TICKET, { flag: "wx" }).catch((err) => {
    if (err?.code !== "EEXIST") throw err;
  });
}

// Process-level handlers (ADR 0016 decision 2, process lifetime): the bridge owns its children, so a signal, a crash
// or an exit ends them. Returns the function that removes every handler it installed.
function installProcessHandlers(host) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (sig) => {
    host.shutdown().finally(() => process.exit(128 + (os.constants.signals[sig] ?? 15)));
  };
  const handlers = signals.map((sig) => [sig, () => onSignal(sig)]);
  const onCrash = (err) => {
    process.stderr.write(`bridge: uncaught exception: ${err?.stack ?? err}\n`);
    host.shutdown().finally(() => process.exit(1));
  };
  const onExit = () => host.killAllSync();
  for (const [sig, fn] of handlers) process.on(sig, fn);
  process.on("uncaughtException", onCrash);
  process.on("exit", onExit);
  return () => {
    for (const [sig, fn] of handlers) process.off(sig, fn);
    process.off("uncaughtException", onCrash);
    process.off("exit", onExit);
  };
}

// runtime: a CellRuntime (organism-infra/140). With none, POST /agents is 503 and no process-level handler is
// installed. policy: test-only overrides of agents/policy.mjs (the production entry point passes none).
// den-mvp outcome 3: gitHost is the bridge's git-host operations (delivery/git-host.mjs; a test passes a fake), and stateDir
// is where the delivery log is kept. The production entry point passes a directory outside the repository; the default is
// the bridge's run directory, which is outside every agent's worktree.
// den-mvp outcome 4: library is the catalog of connections and its record (library/library.mjs); a test passes its own.
// den-mvp outcome 5: denState is the den's state folder ($XDG_STATE_HOME/den). When its ui/current link names a complete release,
// the UI is served from that release (a hashed file it lacks is looked for in ui/previous); with no usable link, and when
// denState is not given, the UI comes from uiDir, the checkout's build, as before. `box` is the build box (build/box.mjs) a
// preview and a go-live are built in; with none, both are refused.
// den-mvp/29: watchCi starts the CI watch's timer (delivery/ci-watch.mjs); the production entry point passes true. Without
// it the watch only reads its record, so a test never reaches the git host by the timer.
// den-mvp/34: checks (delivery/checks.mjs) runs ci.yml's checks here: before a delivery pushes, and on POST /checks for an
// open pull request. With none, a delivery skips them and POST /checks is a 503.
// The routes that start a run, a delivery or a meeting, or resume one.
const STARTS = /^\/(?:agents|tasks|deliveries|meetings)(?:\/[^/]+\/resume)?$/;

export async function startBridge({ root, orderFile = path.join(root, ".scratch", "work-order.md"), port = 4317, uiDir = DEFAULT_UI_DIR, denState, box, auth: authOptions, runtime, runtimes, policy, gitHost, stateDir, library: libraryOption, watchCi = false, proxy, usage: usageOption, usageByRuntime = {}, checks: checksOption = null, exit, updatePollMs, profile: profileOption, ghExec } = {}) {
  let actualPort = port;
  const git = gitHost ?? createGitHost(root);
  // den-mvp/10 and 11: the den's own build, when it is served from release folders: previews, go-live and roll back. The
  // live build is read from the links every time. A preview is given the read handlers below and nothing else.
  const readBuild_ = async () => (denState ? readBuild(denState) : null);
  let previewReads;
  let haveReads;
  const readsMade = new Promise((resolve) => (haveReads = resolve)); // the handlers are made further down
  const denBuild = denState
    ? createDenBuild({ stateDir: denState, repo: root, box, reads: () => readsMade, fetchMain: () => git.mainSha(), onSwitch: async () => hub.publish({ type: "build", build: await readBuild_() }) })
    : null;
  // den-mvp/45: Bao's release draft; only the user's Approve (POST /release/approve) tags and publishes.
  const releases = createReleaseDrafts({ git, onChange: (release) => hub.publish({ type: "release", release }) });
  // den-mvp/85: the bridge tags a patch release for a merged bridge change, and builds the newest tag ahead of the update.
  // Both run on timers (watchCi) and are no agent's tool.
  const autoRelease = createAutoRelease({ git });
  const readyRelease = denBuild ? createReadyRelease({ git, releases: denBuild.releases, stateDir: denState, repo: root, onChange: (change) => (hub.publish(change), updater?.check().catch(() => {})) }) : null;
  const auth = createAuth(authOptions);
  let host;
  let updater = null;
  let delivery;
  let meetings;
  // A pull request a delivery is running or waiting on is the delivery's: its runner re-runs a timeout or sends a red back.
  const ownedByDelivery = (number) => (delivery?.snapshot() ?? []).some((d) => (d.state === "running" || d.state === "paused") && d.pr?.number === number);
  const ciWatch = createCiWatch({ git, file: path.join(stateDir ?? path.join(root, ".scratch", "_run"), "ci-watch.json"), onChange: (change) => hub.publish(change), skip: ownedByDelivery,
    // den-mvp/29: a red pull request outside the den is a message to Bao's desk (den-mvp/30), once per commit.
    wake: (text) => host.converse("orchestrator", { text }) });
  // den-mvp/34: every local run is told to the den when it starts and when it ends.
  const checksView = async () => (checksOption ? { recent: (await checksOption.recent(10)).map(summarize), running: checksOption.running() } : null);
  const publishChecks = () => checksView().then((checks) => hub.publish({ type: "checks", checks }), () => {});
  const checks = checksOption && {
    ...checksOption,
    run(input) {
      const done = checksOption.run(input);
      publishChecks();
      done.then(publishChecks, publishChecks);
      return done;
    },
  };
  // Friction F19: the production bridge reads the plan-usage cache; a test bridge reads only usage.jsonl rows.
  const usageReading = usageOption ?? (() => null);
  // den-mvp/49: the den and the projects onboarded beside it. The registry is the user's (den:project); the active project is ours.
  const projects = createProjects({ control: root, denState: denState ?? stateDir ?? path.join(root, ".scratch", "_run") });
  // multi-project/01 (ADR 0021 A7 decision 25): one Board per project, made in this one place; `ghExec` is the test seam for `gh`.
  const boards = createProjectBoards({ projects, exec: ghExec });
  const snapshotOf = async (slug, opts = {}) => { const board = await boards.get(slug); return buildSnapshot(board.root, 0, { ...opts, board }); };
  // trust-ladder/01 (ADR 0032): the lean/full Profile is the user's, kept in the den's state folder beside the other settings.
  const profile = profileOption ?? createProfile({ file: path.join(denState ?? stateDir ?? path.join(root, ".scratch", "_run"), "profile.json") });
  const hub = createHub(root, {
    agents: () => host.snapshot(), approvals: () => host.approvals(), transcripts: () => host.transcripts(), capacity: async (lockedRefs) => {
      const project = await projects.active();
      return host.capacity(lockedRefs.filter(ref => !meetings?.snapshot().some(m => m.held && m.ref === ref && m.project === project)), project);
    },
    deliveries: () => delivery?.snapshot() ?? [],
    meetings: () => meetings?.publicSnapshot() ?? [],
    ci: () => ciWatch.snapshot(),
    checks: () => checksView(),
    build: () => readBuild_(),
    release: () => releases.current(),
    readyRelease: () => readyRelease?.snapshot() ?? null,
    update: () => updater?.snapshot() ?? null,
    accounts: async () => (proxy ? proxy.status() : null),
    wall: () => wallTables(),
    profile: () => profile.view(),
    readUsage: usageReading,
    boardRoot: () => projects.activeRoot(),
    board: async () => boards.peek(await projects.active()),
  });
  // den-mvp outcome 4: the production entry point passes the den's catalog; with none, no agent is given a connection.
  const runClaims = createRunClaims(path.join(stateDir ?? path.join(root, ".scratch", "_run"), "run-claims.json"));
  const library = libraryOption ?? createLibrary({ catalog: parseCatalog({ connections: [] }) });
  host = createHost({
    root,
    profile,
    projects,
    readTicket: async (project, ref) => (await boards.get(project)).read(ref),
    runtime,
    runtimes,
    bridgeUrl: () => `http://127.0.0.1:${actualPort}`,
    policy,
    library,
    meetingHold: (ref, project) => meetings?.snapshot().find(m => m.held && m.ref === ref && m.project === project)?.id ?? null,
    onChange: (change) => hub.publish(change),
    recordRun: createLedger(root).record,
    onEnd: (run) => Promise.all([delivery.onEnd(run), meetings.onEnd(run)]),
    meetingApproval: (approval) => meetings?.onApproval(approval),
    settleRun: settle,
    readUsage: async (runtime) => typeof usageByRuntime[runtime] === "function" ? usageByRuntime[runtime]() : runtime === "claude" ? (await hub.snapshot()).usage?.fiveHour ?? null : null,
    // organism-infra/226: a dispatch needs the ticket to be in the frontier (ready, unblocked, unlocked), not to hold the gate.
    checkGate: async (ref, { project }) => {
      const snap = await snapshotOf(project);
      return !snap.tickets.some((t) => t.ref === ref) ? "unknown" : snap.frontier.includes(ref) ? "ok" : "nofrontier";
    },
    // den-mvp/89: a Run's claim, made by the bridge after the gate and before the agent starts. The board's refusal is the Run's.
    // A board refusal is the Run's reason; any other failure (a file path, say) is not passed on.
    claimRun: async (agent) => {
      if (!isBoardRole(agent.role)) return;
      try {
        await (await boards.get(agent.project)).claim(agent.ref, { role: agent.role, mode: boardMode(agent), run: agent.id });
      } catch (err) {
        if (err instanceof BoardError) throw err;
        console.error(`bridge: could not claim ${agent.ref} for a run: ${err?.message ?? err}`);
        throw new Error("the board could not claim the ticket");
      }
      await runClaims.add({ id: agent.id, ref: agent.ref, project: agent.project, role: agent.role }).catch((err) => console.error(`bridge: could not record the claim on ${agent.ref}: ${err?.message ?? err}`));
    },
    // A forced release logs an override row, so a run that never started gives the claim back with a handoff saying so, the board's plain path.
    releaseRun: async (agent, reason) => {
      if (!isBoardRole(agent.role)) return;
      const board = await boards.get(agent.project);
      await board.handoff(agent.ref, { role: agent.role, mode: boardMode(agent), runId: agent.id, sha: "", report: `The run did not start: ${reason}.`, committed: false, source: "den run", status: "ready-for-agent" }).catch(() => board.drop(agent.ref, { status: "ready-for-agent", reason: `${agent.role} run did not start: ${reason}` }));
      await runClaims.remove(agent.id);
    },
    lockedRefs: async ({ project }) => (await snapshotOf(project)).tickets.filter((t) => t.holder && !meetings?.snapshot().some(m => m.held && m.ref === t.ref && m.project === project && t.holder.role === 'chief-of-staff' && t.holder.since === m.holdSince)).map((t) => t.ref),
    openDesk: (runtime) => ensureDesk(root, runtime),
    createDelegatedTicket: async ({ parent, role, brief }) => (await boards.get(parent.project)).create({
      feature: DEN_FEATURE, slug: role, title: `Delegated ${role}: ${brief.task}`.slice(0, 100),
      text: `${brief.task}\n\nConstraints: ${brief.constraints.join('; ')}\n\n## Acceptance criteria\n\n${brief.acceptance.map(a => `- [ ] ${a}`).join('\n')}`,
      source: `delegated by ${parent.id}`, status: "ready-for-agent",
    }),
    // F34: a batch the bridge would refuse is denied when it asks, with the reason, so the user is not asked for it.
    checkCall: (tool, input) => (tool === "mcp__den__board_file" ? checkFileBatch(input).error ?? null : null),
  });
  await host.ready;
  await recoverRunClaims();
  delivery = createDelivery({
    host: { start: host.start, stop: host.stop, retire: host.retire, worktreeOf: (id) => host.snapshot().find((a) => a.id === id)?.worktree ?? null },
    board: await boards.get("den"),
    activeProject: () => projects.active(),
    profile,
    git,
    build: denBuild,
    checks,
    log: createJobLog(stateDir ?? path.join(root, ".scratch", "_run")),
    onChange: (change) => hub.publish(change),
    readInReview: async () => Promise.all((await snapshotOf("den")).tickets.filter((t) => t.status === "in-review" && !t.holder).map(async (t) => ({ ref: t.ref, branches: await branchesOf(root, t.ref) }))),
    readTicket: async (ref, { project = "den" } = {}) => {
      const snap = await snapshotOf(project), ticket = snap.tickets.find((t) => t.ref === ref);
      return ticket ? { title: ticket.title, type: ticket.type, frontier: snap.frontier.includes(ref) } : null;
    },
  });
  // den-mvp outcome 4: meetings. The bridge writes a meeting's files and both of its tickets; no agent does.
  meetings = createMeetings({
    host: { start: host.start, stop: host.stop, retire: host.retire },
    store: createMeetingStore(root),
    readProject: async project => Boolean(await projects.get(project).catch(() => null)),
    recordUrl: m => `http://127.0.0.1:${actualPort}/?meeting=${m.id}&project=${m.project}`,
    log: createMeetingLog(stateDir ?? path.join(root, ".scratch", "_run")),
    onChange: (change) => hub.publish(change),
    readUsage: async () => (await hub.snapshot()).usage?.fiveHour ?? null,
    readTicket: async (ref, { project = "den" } = {}) => {
      const ticket = (await snapshotOf(project)).tickets.find((t) => t.ref === ref);
      return ticket ? { title: ticket.title, status: ticket.status, owner: host.admission.ownerOf(ref).owner, project } : null;
    },
    // The work a chosen option proposes: a ticket at ready-for-human, so it is in no queue until the user approves it.
    proposeTicket: async ({ title, text, project }) => (await boards.get(project)).create({ feature: DEN_FEATURE, slug: "proposed", title, text, source: "den meeting", status: "ready-for-human" }),
    claimTicket: async m => {
      const before = (await snapshotOf(m.project)).tickets.find(t => t.ref === m.ref);
      await (await boards.get(m.project)).claim(m.ref, { role: 'chief-of-staff' });
      m.holdSince = (await snapshotOf(m.project)).tickets.find(t => t.ref === m.ref)?.holder?.since;
      m.ticketStatus = before?.status ?? m.ticketStatus;
    },
    releaseTicket: async m => {
      const holder = (await snapshotOf(m.project)).tickets.find(t => t.ref === m.ref)?.holder;
      if (!holder) return;
      if (holder.role !== 'chief-of-staff' || holder.since !== m.holdSince) return;
      await (await boards.get(m.project)).drop(m.ref, { status: m.ticketStatus ?? 'ready-for-agent', reason: 'Meeting stopped starting work' });
    },
  });
  await meetings.ready;
  await ciWatch.ready;
  // den-mvp/86: an update applies when nothing is running. Work is live while a run is, a delivery is running (a step, a check,
  // a merge) or a meeting is. Stopping is the ordinary shutdown: whatever is left pauses and waits for Resume.
  if (denBuild && readyRelease) {
    updater = createUpdater({
      stateDir: denState,
      releases: denBuild.releases,
      ready: () => readyRelease.snapshot(),
      busy: () => host.busy() || (delivery.snapshot() ?? []).some((d) => d.state === "running") || (meetings.snapshot() ?? []).some((m) => m.state === "running"),
      stop: () => stopWork(),
      exit,
      pollMs: updatePollMs,
      onChange: (change) => hub.publish(change),
      onDrain: (text) => host.drain(text),
    });
    await updater.ready;
  }
  if (watchCi) {
    ciWatch.start();
    autoRelease.start();
    readyRelease?.start();
  }
  let postChain = Promise.resolve();
  await hub.ready;
  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      console.error(`bridge: request failed: ${err.stack ?? err}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("internal error");
    }
  });
  async function handle(req, res) {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url, "http://x").pathname;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad request target");
      return;
    }
    // Default deny (ADR 0016 decision 6.1): a request no registry row matches is a 404. Reads of the UI build
    // (GET, HEAD) fall through to the static files.
    const route = matchRoute(req.method, pathname);
    if (!route) {
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(pathname, req, res);
      return reply(res, 404, { error: "not found" });
    }
    if (route.auth !== "none" && !passesGate(req, res, route)) return;
    // den-mvp/86: while the bridge drains for an update it starts nothing new; `draining` tells the router this is a wait.
    const drainText = updater?.drainingText();
    if (drainText && req.method === "POST" && STARTS.test(pathname)) return reply(res, 503, { error: drainText, draining: true });
    const handler = HANDLERS[`${route.method} ${route.path}`];
    if (!handler) return reply(res, 404, { error: "not found" });
    await handler(req, res);
  }
  const routerRequests = new WeakSet(); // requests that passed only verifyService
  const bearerOf = (req) => /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
  // Gate order: Origin and Content-Type (403), then the session token (401). All before the body is read, so an
  // unauthenticated caller learns nothing about ids or validation.
  function passesGate(req, res, route) {
    const origin = req.headers.origin;
    // A browser sends no Origin on a same-origin GET, so a token-gated read checks it only when present.
    if (!(req.method === "GET" && origin === undefined) && origin !== `http://127.0.0.1:${actualPort}` && origin !== `http://localhost:${actualPort}`) {
      reply(res, 403, { error: "foreign or missing origin" });
      return false;
    }
    if (req.method !== "GET" && !/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
      reply(res, 403, { error: "content-type must be application/json" });
      return false;
    }
    if (route.auth === "run" && !host.runAgent(bearerOf(req))) {
      reply(res, 401, { error: "unauthorized" });
      return false;
    }
    if (route.auth === "token" && !auth.verify(req.headers.authorization)) {
      // den-mvp/88 (ADR 0027 decisions 3, 8): a request that passed only the service token is the router's, and the handlers narrow it.
      if (!(route.service && auth.verifyService(req.headers.authorization))) {
        reply(res, 401, { error: "unauthorized" });
        return false;
      }
      routerRequests.add(req);
    }
    return true;
  }
  const HANDLERS = {
    "GET /state": async (req, res) => reply(res, 200, await hub.snapshot()),
    "GET /metrics": async (req, res) => {
      const [usageLines, eventLines] = await Promise.all(["usage.jsonl", "events.jsonl"].map((f) => readRows(path.join(root, ".scratch", f))));
      reply(res, 200, computeMetrics({ usageLines, eventLines }));
    },
    "GET /events": (req, res) => hub.connect(req, res),
    "POST /session": (req, res) => postSession(req, res),
    "POST /requests": async (req, res) => {
      // Serialised so two racing POSTs cannot both pass the pending-request check.
      const run = postChain.then(() => postRequest(req, res));
      postChain = run.catch(() => {});
      await run;
    },
    "GET /projects": async (req, res) => reply(res, 200, { projects: await projects.list() }),
    "POST /projects/active": async (req, res) => {
      const body = await readJsonObject(req, res);
      if (!body) return;
      if (typeof body.slug !== "string") return reply(res, 400, { error: "slug must be a string" });
      const result = await projects.activate(body.slug, { runs: host.projectRuns() });
      if (result.refused) return reply(res, 409, { error: result.reason, blocking: result.blocking });
      reply(res, 200, { ok: true, active: body.slug });
    },
    "GET /projects/:slug/board": async (req, res) => {
      const slug = new URL(req.url, "http://x").pathname.split("/")[2];
      const board = await boards.get(slug);
      if (!board) return reply(res, 404, { error: "no such project" });
      reply(res, 200, await buildSnapshot(board.root, 0, { readUsage: usageReading, board }));
    },
    "POST /agents": (req, res) => postAgent(req, res),
    "POST /tasks": (req, res) => postTask(req, res),
    "POST /agents/:id/stop": (req, res) => stopAgent(req, res),
    "POST /agents/:id/message": (req, res) => messageAgent(req, res),
    "POST /agents/:id/message/cancel": (req, res) => cancelMessage(req, res),
    "POST /agents/:id/handover": (req, res) => handoverAgent(req, res),
    "GET /approvals/:id": (req, res) => {
      const approval = host.approval(new URL(req.url, "http://x").pathname.split("/")[2]);
      reply(res, approval ? 200 : 404, approval ?? { error: "no such approval" });
    },
    // den-mvp outcome 2: a page of a role's durable conversation. `before` and `limit` are whole numbers or left out.
    "GET /conversations/:role": async (req, res) => {
      const url = new URL(req.url, "http://x");
      const whole = (name) => (/^\d{1,9}$/.test(url.searchParams.get(name) ?? "") ? Number(url.searchParams.get(name)) : undefined);
      const page = await host.conversation(url.pathname.split("/")[2], { before: whole("before"), limit: whole("limit"), ...(url.searchParams.has("runtime") ? { runtime: url.searchParams.get("runtime") } : {}), ...(url.searchParams.has("project") ? { project: url.searchParams.get("project") } : {}) });
      if (page?.ok === false) return reply(res, page.status, { error: page.error });
      reply(res, page ? 200 : 404, page ?? { error: "no such role" });
    },
    "POST /conversations/:role/message": (req, res) => converse(req, res),
    // den-mvp outcome 4: the library panel's data: each connection with its status, roles and tools, and each skill.
    "GET /library": async (req, res) => reply(res, 200, await library.view()),
    "POST /deliveries": (req, res) => postDelivery(req, res),
    // den-mvp/88: a stop the router met, kept in requests.jsonl so Needs you shows it until the user dismisses it.
    "POST /router-stops": async (req, res) => {
      const run = postChain.then(() => postRouterStop(req, res));
      postChain = run.catch(() => {});
      await run;
    },
    "POST /router-stops/:id/dismiss": async (req, res) => {
      const run = postChain.then(() => dismissRouterStop(req, res));
      postChain = run.catch(() => {});
      await run;
    },
    "POST /deliveries/sweep": async (req, res) => {
      if (!(await readJsonObject(req, res))) return;
      const { status, error, resolved } = await delivery.sweep();
      reply(res, status, error ? { error } : { resolved });
    },
    "POST /deliveries/:id/resume": (req, res) => steerDelivery(req, res, "resume"),
    "POST /deliveries/:id/stop": (req, res) => steerDelivery(req, res, "stop"),
    "POST /deliveries/:id/close": (req, res) => steerDelivery(req, res, "close"),
    "POST /meetings": (req, res) => postMeeting(req, res),
    "GET /meetings": async (req, res) => reply(res, 200, { meetings: meetings.snapshot().map(({ events, preview, chain, ...record }) => record) }),
    "GET /run/meetings/:id": async (req, res) => {
      const agent = host.runAgent(bearerOf(req));
      const id = new URL(req.url, 'http://x').pathname.split('/')[3];
      const result = await meetings.read(id);
      if (!result.ok || result.meeting.project !== agent.project || !(['chief-of-staff', 'orchestrator'].includes(agent.role) || result.meeting.seats.some(s => s.role === agent.role && s.active))) return reply(res, 404, { error: 'No accessible meeting' });
      reply(res, 200, result);
    },
    "GET /meetings/:id": async (req, res) => {
      const { ok, status, error, ...body } = await meetings.read(new URL(req.url, "http://x").pathname.split("/")[2]);
      reply(res, status, ok ? body : { error });
    },
    "POST /meetings/:id/resume": (req, res) => steerMeeting(req, res, "resume"),
    "POST /meetings/:id/stop": (req, res) => steerMeeting(req, res, "stop"),
    "POST /meetings/:id/close": (req, res) => steerMeeting(req, res, "close"),
    "POST /meetings/:id/decide": (req, res) => steerMeeting(req, res, "decide"),
    "POST /meetings/:id/ask": (req, res) => steerMeeting(req, res, "ask"),
    "POST /meetings/:id/budget": (req, res) => steerMeeting(req, res, "approveBudget"),
    "POST /meetings/:id/retry": (req, res) => steerMeeting(req, res, "retry"),
    "POST /meetings/:id/participants": (req, res) => steerMeeting(req, res, "participants"),
    "POST /meetings/:id/preview": (req, res) => steerMeeting(req, res, "preview"),
    "POST /meetings/:id/publish": (req, res) => steerMeeting(req, res, "publish"),
    "POST /meetings/:id/continue": (req, res) => steerMeeting(req, res, "continueMeeting"),
    "POST /update/now": async (req, res) => {
      if (!(await readJsonObject(req, res))) return;
      if (!updater) return reply(res, 409, { error: "the den runs from the checkout: there is nothing to update" });
      const { status, update, started, reason } = await updater.updateNow();
      reply(res, status, { update, started, ...(reason ? { reason } : {}) });
    },
    "POST /update/relaunch": async (req, res) => {
      if (!(await readJsonObject(req, res))) return;
      if (!updater) return reply(res, 409, { error: "the den runs from the checkout: it cannot restart itself" });
      reply(res, 202, { restarting: true });
      updater.restartNow().catch((err) => console.error(`bridge: restart failed: ${err?.message ?? err}`));
    },
    "POST /update/auto": async (req, res) => {
      const body = await readJsonObject(req, res);
      if (!body) return;
      if (typeof body.auto !== "boolean") return reply(res, 400, { error: "auto must be true or false" });
      if (!updater) return reply(res, 409, { error: "the den runs from the checkout: there are no updates" });
      reply(res, 200, { update: await updater.setAuto(body.auto) });
    },
    "POST /build/rollback": (req, res) => rollBack(req, res),
    "POST /release/approve": (req, res) => steerRelease(req, res, "approve"),
    "POST /release/decline": (req, res) => steerRelease(req, res, "decline"),
    "POST /tickets/approve": (req, res) => steerTicket(req, res, "approve"),
    "POST /tickets/transfer": steerTransfer,
    "POST /admission/runtime": steerAllowlist,
    "POST /accounts/active": steerAccount,
    "POST /profile": steerProfile,
    "POST /admission/reconcile": steerReconcile,
    "POST /tickets/decline": (req, res) => steerTicket(req, res, "decline"),
    "POST /checks": (req, res) => postChecks(req, res),
    "POST /den-tools/:tool": (req, res) => denTool(req, res),
    // The recovery page is the bridge's own code, not a file of the UI build.
    "GET /recover": (req, res) => sendOwn(res, "text/html; charset=utf-8", RECOVER_HTML),
    "GET /recover/script": (req, res) => sendOwn(res, "text/javascript; charset=utf-8", RECOVER_SCRIPT),
    "POST /approvals/:id": async (req, res) => {
      const body = await readJsonObject(req, res);
      if (!body) return;
      const result = await host.decide(new URL(req.url, "http://x").pathname.split("/")[2], body);
      if (!result.ok) return reply(res, result.status, { error: result.error });
      reply(res, 200, { approval: result.approval });
    },
  };
  // den-mvp/09: what a preview listener (build/preview.mjs) is given. It holds these read handlers and no other. The
  // snapshot and the event stream it gets are lists of what it may see (redactSnapshot, redactChange): a preview
  // is unreviewed code, and nothing can stop a page from carrying what it reads somewhere else.
  previewReads = {
    "/state": async (req, res) => reply(res, 200, redactSnapshot(await hub.snapshot())),
    "/events": (req, res) => hub.connect(req, res, { snapshot: redactSnapshot, change: redactChange }),
    "/library": HANDLERS["GET /library"],
  };
  haveReads(previewReads);
  const readRows = (file) => readFile(file, "utf8").then(parseJsonl, () => []);
  const reply = (res, status, obj, extra = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
    res.end(JSON.stringify(obj));
  };
  // Read a body of at most `max` bytes. Replies 413 itself and returns undefined when it is too large.
  async function readBody(req, res, max = MAX_BODY) {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) return void reply(res, 413, { error: "body too large" }, { Connection: "close" });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) return void reply(res, 413, { error: "body too large" }, { Connection: "close" });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  // Read a JSON object body of at most `max` bytes. Replies 413 or 400 itself and returns undefined on failure.
  async function readJsonObject(req, res, max) {
    const raw = await readBody(req, res, max);
    if (!raw) return;
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return void reply(res, 400, { error: "malformed JSON" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return void reply(res, 400, { error: "body must be an object" });
    return body;
  }
  // POST /session (ADR 0016 decision 6.2): exchange the one-time launch code for a session token.
  async function postSession(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (typeof body.code !== "string") return reply(res, 400, { error: "code must be a string" });
    const { status, token } = auth.redeem(body.code);
    if (status === 200) return reply(res, 200, { token });
    reply(res, status, { error: status === 429 ? "too many sessions" : "invalid launch code" });
  }
  // POST /requests (ADR 0011 decision 6): validate, then append one Gate request. Nothing executes.
  async function postRequest(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { kind, ref, note } = body;
    if (!REQUEST_KINDS.includes(kind)) return reply(res, 400, { error: "unknown kind" });
    if (typeof ref !== "string" || !ref) return reply(res, 400, { error: "ref must be a string" });
    if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
      return reply(res, 400, { error: "note must be a string of at most 500 characters" });
    }
    const snap = await hub.snapshot();
    const ticket = snap.tickets.find((t) => t.ref === ref);
    if (!ticket) return reply(res, 404, { error: "no such ticket" });
    if (!ticket.gate || !kind.startsWith(`${ticket.gate}-`)) return reply(res, 409, { error: "kind does not match the ticket's gate" });
    if (ticket.request) return reply(res, 409, { error: "a request is already pending for this ticket" });
    const request = { id: randomUUID(), ts: new Date().toISOString(), kind, ref, ...(note !== undefined ? { note } : {}) };
    await appendRequestLine(root, request);
    reply(res, 201, { request });
  }
  // POST /router-stops { key, kind, ref?, text }: one router-stop request; the same key while one is pending is that one, not a second.
  // A dismissed one no longer counts, so a stop that is still true comes back as a new row.
  const ROUTER_STOP_CAP = 50;
  async function postRouterStop(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { key, kind, ref, text } = body;
    const short = (v, n) => typeof v === "string" && v.length > 0 && v.length <= n;
    if (!short(key, 300) || !short(kind, 40) || !/^[a-z-]+$/.test(kind) || !short(text, 500) || (ref !== undefined && !short(ref, 200))) {
      return reply(res, 400, { error: "a router stop needs key, kind (a-z and -) and text, and an optional ref, all short strings" });
    }
    if ([key, text, ref].some((v) => typeof v === "string" && hasSecret(v))) return reply(res, 400, { error: "a router stop looks like it holds a secret; nothing was written" });
    const pendingStops = foldRequests(await readRequestRows(root)).filter((r) => r.kind === ROUTER_STOP && r.state === "pending");
    const existing = pendingStops.find((r) => r.key === key);
    if (existing) return reply(res, 200, { request: existing });
    // The service token is outside the session cap, so pending stops have their own: a holder cannot grow the file without bound.
    if (pendingStops.length >= ROUTER_STOP_CAP) return reply(res, 429, { error: "too many router stops are waiting; dismiss some" });
    const request = { id: randomUUID(), ts: new Date().toISOString(), kind: ROUTER_STOP, ref: ref ?? null, note: cleanText(text), key, stopKind: kind };
    await appendRequestLine(root, request);
    reply(res, 201, { request });
  }
  async function dismissRouterStop(req, res) {
    if (!(await readJsonObject(req, res))) return; // the body is unused, but the size cap and JSON check apply as on every POST
    let id = null;
    try {
      id = decodeURIComponent(new URL(req.url, "http://x").pathname.split("/")[2]);
    } catch {} // a malformed % matches no stop
    const pending = foldRequests(await readRequestRows(root)).find((r) => r.id === id && r.kind === ROUTER_STOP && r.state === "pending");
    if (!pending) return reply(res, 404, { error: "no such router stop waiting" });
    await appendRequestLine(root, { handled: id, ts: new Date().toISOString(), outcome: "dismissed" });
    reply(res, 200, { ok: true });
  }
  // POST /agents (ADR 0016 decision 3): with POST /tasks, the only HTTP ways an agent starts. Only ref, role and mode are read from
  // the body; the host validates them, applies the policy and answers with a status from its table.
  // den-mvp/23, 89 (with den-v1/15): what a Run or a den task leaves on the board. The agent's board is read-only behind the
  // wall, so the bridge makes the calls. A Run's claim is made when it starts (the host's claimRun) and released when it ends:
  // the last message is published as the ticket's handoff and the ticket returns to ready-for-agent, so it can be Run again or
  // Delivered; a failed or stopped run releases it with a comment. A den task's ticket, written for that task alone, is claimed
  // at its end instead and goes to in-review. A role the board keeps no handoffs for leaves nothing.
  const held = new Map(); // agent id -> { ref, role, mode, task, project }
  const boardMode = (agent) => (agent.mode && modeAllowed(agent.role, agent.mode) ? agent.mode : null);
  function hold(agent, { task }) {
    if (isBoardRole(agent.role)) held.set(agent.id, { ref: agent.ref, role: agent.role, mode: boardMode(agent), task, project: agent.project ?? "den" });
  }
  const settling = new Set();
  function settle(run) {
    const done = runEnded(run);
    settling.add(done);
    return done.finally(() => settling.delete(done));
  }
  async function runEnded(run) {
    const entry = held.get(run?.agentId);
    if (!entry) return;
    held.delete(run.agentId);
    const { ref, role, mode, task, project } = entry;
    let runBoard = null;
    try {
      runBoard = await boards.get(project);
      if (!runBoard) throw new Error("the run's project is no longer onboarded");
      if (run.state !== "done") {
        if (!task) await giveBack(runBoard, run.agentId, ref, `${role} run ${run.state === "terminated" ? "stopped" : "failed"}${run.reason ? ` (${run.reason})` : ""}`);
        return;
      }
      const committed = !!run.sha && run.sha !== run.startSha;
      // A den task's ticket goes to in-review: the board wants the claim before the handoff that releases it.
      if (task) await runBoard.claimForHandoff(ref, { role });
      await runBoard.handoff(ref, { role, mode: task ? (role === "qa" ? "verify" : null) : mode, runId: run.agentId, sha: run.sha ?? run.startSha ?? "", branch: committed ? run.branch : null, report: run.report, committed, source: task ? "den task" : "den run", status: task ? "in-review" : "ready-for-agent" });
      if (!task) await runClaims.remove(run.agentId);
    } catch (err) {
      console.error(`bridge: could not hand off ${ref} after its run: ${err?.message ?? err}`);
      // A claim must not outlive its run: when the handoff or release failed, give it back without one. With no board to reach, the journal keeps it for the next boot.
      if (!task && runBoard) await giveBack(runBoard, run.agentId, ref, `${role} run ended, but the bridge could not hand it off: ${err?.message ?? err}`).catch((e) => console.error(`bridge: could not release ${ref} either: ${e?.message ?? e}`));
    }
  }
  // A claim comes off the ticket with a comment, and off the journal.
  async function giveBack(board, agentId, ref, reason) {
    await board.drop(ref, { status: "ready-for-agent", reason });
    await runClaims.remove(agentId);
  }
  // After a hard crash a Run's claim is still on the board and no run is live: give back each journalled claim whose bridge is
  // dead, with a comment. A claim a different role holds now is not the entry's any more; a live bridge's entry is left alone.
  async function recoverRunClaims() {
    for (const entry of (await runClaims.list()).filter(ownerGone)) {
      const { id, ref, project, role } = entry;
      try {
        const board = await boards.get(project);
        if (!board) continue;
        const holder = (await snapshotOf(project)).tickets.find((t) => t.ref === ref)?.holder;
        if (holder?.role === role) await giveBack(board, id, ref, `${role} run: the bridge stopped while it ran; the claim was given back at boot`);
        else await runClaims.remove(id);
      } catch (err) {
        console.error(`bridge: could not give back the claim on ${ref}: ${err?.message ?? err}`);
      }
    }
  }
  async function postAgent(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const result = await host.dispatch({ ref: body.ref, role: body.role, mode: body.mode, runtime: body.runtime, project: body.project, execution: body.execution, orchestration: body.orchestration });
    if (!result.ok) return reply(res, result.status, { error: result.error });
    hold(result.agent, { task: false });
    reply(res, result.status, { agent: result.agent, ...(result.usageUnknown ? { usageUnknown: true } : {}) });
  }
  // POST /tasks (ADR 0016 decision 3, amendment 9): a task typed in the den. Only role, text and grants are read (grants: agent-os/02, data in a fixed shape the host checks). The text
  // goes into a ticket the board service writes under the den feature, and nowhere else: the host starts the role
  // for that ticket in direct mode, with a prompt that names the ticket file. This is the bridge's one Board write.
  async function postTask(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return reply(res, 400, { error: "text must be a non-empty string" });
    if (Buffer.byteLength(text) > TASK_MAX_BYTES) return reply(res, 400, { error: `text must be at most ${TASK_MAX_BYTES} bytes` });
    if (hasSecret(text)) return reply(res, 400, { error: "text looks like it holds a secret; nothing was written" });
    const result = await host.direct({
      role: body.role ?? "developer",
      runtime: body.runtime,
      project: body.project,
      grants: body.grants,
      execution: body.execution,
      orchestration: body.orchestration,
      createTicket: async (role, { project }) => (await boards.get(project)).create({ feature: DEN_FEATURE, slug: role, title: `Den task for ${role}`, text, source: "den", status: "ready-for-agent" }),
    });
    const ticket = result.ticket ? { ticket: result.ticket } : {};
    if (!result.ok) return reply(res, result.status, { error: result.error, ...ticket });
    hold(result.agent, { task: true });
    reply(res, result.status, { agent: result.agent, ...ticket, ...(result.usageUnknown ? { usageUnknown: true } : {}) });
  }
  // POST /agents/:id/stop: takes no body, but the 4 KB cap still applies before anything is looked up.
  async function stopAgent(req, res) {
    if (!(await readBody(req, res))) return;
    const id = new URL(req.url, "http://x").pathname.split("/")[2];
    const result = await host.stop(id);
    if (!result.ok) return reply(res, result.status, { error: result.error });
    reply(res, result.status, { ok: true });
  }
  // POST /agents/:id/message (ADR 0016 amendment 12): one message to a running agent. Only `text` is read; the host
  // checks it and writes it to that agent's stdin, and nowhere else.
  async function messageAgent(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const id = new URL(req.url, "http://x").pathname.split("/")[2];
    const result = await host.message(id, { text: body.text });
    if (!result.ok) return reply(res, result.status, { error: result.error });
    reply(res, result.status, { ok: true, messageId: result.messageId });
  }
  // POST /agents/:id/message/cancel (organism-infra/107): drop a message that is still queued. Only `messageId` is read.
  async function cancelMessage(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const id = new URL(req.url, "http://x").pathname.split("/")[2];
    const result = await host.cancel(id, { messageId: body.messageId });
    if (!result.ok) return reply(res, result.status, { error: result.error });
    reply(res, result.status, { ok: true });
  }
  // POST /agents/:id/handover (organism-infra/107): stop the agent so the user can resume it by hand. No body is read.
  async function handoverAgent(req, res) {
    if (!(await readBody(req, res))) return;
    const id = new URL(req.url, "http://x").pathname.split("/")[2];
    const result = await host.handover(id);
    if (!result.ok) return reply(res, result.status, { error: result.error });
    reply(res, result.status, { ok: true });
  }
  // POST /conversations/:role/message (den-mvp outcome 2): one message into a role's conversation. Only `text` and `runId`
  // are read. The host sends it to the live run, or starts a follow-up run that continues an ended run's session.
  async function converse(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const role = new URL(req.url, "http://x").pathname.split("/")[2];
    const result = await host.converse(role, { text: body.text, runtime: body.runtime, project: body.project, ...(body.runId === undefined ? {} : { runId: body.runId }) });
    if (!result.ok) return reply(res, result.status, { error: result.error });
    reply(res, result.status, { ok: true, runId: result.runId, messageId: result.messageId, resumed: result.resumed, ...(result.agent ? { agent: result.agent } : {}), ...(result.usageUnknown ? { usageUnknown: true } : {}) });
  }
  // den-mvp/55: every ticket of a board_file batch is checked, its blockers included, before any is written. F34: the
  // host runs the same check when the call asks, so a batch the bridge would refuse never reaches the user.
  const boardRefExists = (ref) => {
    if (typeof ref !== "string" || !FULL_REF_RE.test(ref)) return false;
    try {
      const [feature, ticket] = resolveShortRef(root, ref).split("/");
      return existsSync(path.join(root, ".scratch", feature, "issues", `${ticket}.md`));
    } catch {
      return false;
    }
  };
  function checkFileBatch(body) {
    const fail = (error) => ({ error });
    if (!isPlainObj(body)) return fail("the call must be an object { feature?, tickets }");
    const { feature = DEN_FEATURE, tickets } = body;
    if (typeof feature !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(feature) || !existsSync(path.join(root, ".scratch", feature, "issues"))) return fail("feature must be a board feature that has an issues folder");
    if (!Array.isArray(tickets) || tickets.length < 1 || tickets.length > FILE_BATCH_MAX) return fail(`tickets must be a list of 1 to ${FILE_BATCH_MAX} tickets, each { title, text, goal, priority?, type?, blockedBy?, slug? }`);
    const drafts = [];
    for (const [i, t] of tickets.entries()) {
      const at = `ticket ${i + 1}`;
      if (!isPlainObj(t) || typeof t.title !== "string" || !t.title.trim() || typeof t.text !== "string" || !t.text.trim()) return fail(`${at}: title and text must be given`);
      const { title, text, priority = "P2", type = "task", blockedBy = [], slug = slugOf(title) } = t;
      if (!["P0", "P1", "P2", "P3"].includes(priority)) return fail(`${at}: priority must be P0 to P3`);
      if (typeof type !== "string" || !/^[a-z][a-z -]{0,39}$/.test(type)) return fail(`${at}: type must be a few lowercase words`);
      if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) return fail(`${at}: slug must be lowercase words joined by -`);
      if (Buffer.byteLength(text) > FILE_TEXT_MAX_BYTES) return fail(`${at}: text must be at most ${FILE_TEXT_MAX_BYTES} bytes`);
      if (hasSecret(text) || hasSecret(title)) return fail(`${at}: text looks like it holds a secret; nothing was written`);
      // The card shows a control or direction character as an escape, so the bytes written must be the bytes approved.
      if (cleanText(text) !== text || cleanText(title) !== title) return fail(`${at}: text holds control or direction characters; nothing was written`);
      if (!/^## Acceptance criteria[ \t]*$/m.test(text)) return fail(`${at}: text needs its own ## Acceptance criteria section`);
      // den-mvp/61: every ticket names the goal it serves, from the user's .scratch/goals.md.
      const goalWrong = goalProblem(root, t.goal);
      if (goalWrong) return fail(`${at}: ${goalWrong}`);
      if (!Array.isArray(blockedBy)) return fail(`${at}: blockedBy must be a list`);
      for (const b of blockedBy) {
        if (Number.isInteger(b)) {
          if (b < 1 || b > i) return fail(`${at}: a blocker in the batch must name an earlier ticket by its position (1 to ${i})`);
        } else if (!boardRefExists(b)) {
          return fail(`${at}: blocker ${cleanText(String(b).slice(0, 80))} is not a ticket on the board`);
        }
      }
      drafts.push({ title: title.trim(), text, priority, type: type.replace(/\s+/g, " ").trim(), blockedBy, slug, goal: t.goal });
    }
    return { feature, drafts };
  }
  // POST /den-tools/:tool (den-mvp/38): the den script, for the run whose token it holds. The bridge does the work with its
  // own board and git-host rights; the run's role must be one the catalog gives the den connection. board_resolve checks
  // the pull request merged; board_file and start_delivery go ahead only on the user's own allow of that exact call.
  async function denTool(req, res) {
    const agent = host.runAgent(bearerOf(req));
    if (!agent) return reply(res, 401, { error: "unauthorized" });
    const tool = new URL(req.url, "http://x").pathname.split("/")[2];
    if (tool === 'delegate') {
      const body = await readJsonObject(req, res, DEN_TOOL_MAX_BODY);
      if (!body) return;
      const result = await host.delegate(agent.id, body);
      return reply(res, result.status ?? 200, { text: JSON.stringify(result), ...(!result.ok ? { error: result.error } : {}) });
    }
    const verdict = library.decide(agent.role, `mcp__den__${tool}`, {});
    if (!verdict || verdict.kind === "refuse") return reply(res, 403, { error: "the den's catalog does not give this run that tool" });
    const body = await readJsonObject(req, res, DEN_TOOL_MAX_BODY);
    if (!body) return;
    const done = (text) => reply(res, 200, { text });
    const refused = (status, error) => reply(res, status, { error });
    const fullRef = (ref) => {
      if (typeof ref !== "string" || !ref) throw new BoardError("ref must be a ticket ref such as den-mvp/02");
      return resolveShortRef(root, ref);
    };
    const allowed = (match) => host.takeAllowed(agent.id, `mcp__den__${tool}`, match);
    try {
      if (tool === "board_resolve") {
        const ref = fullRef(body.ref);
        if (!Number.isInteger(body.pr) || body.pr < 1 || body.pr > 9_999_999) return refused(400, "pr must be the number of the merged pull request");
        try {
          await git.mergeCommit({ number: body.pr });
        } catch {
          return refused(409, `pull request #${body.pr} is not merged, so ${ref} was not resolved`);
        }
        await resolve(root, [ref], { pr: String(body.pr), note: "resolved by Bao from the desk" });
        return done(`resolved ${ref} (PR #${body.pr})`);
      }
      if (tool === "board_comment") {
        const ref = fullRef(body.ref);
        if (typeof body.text !== "string" || !body.text.trim()) return refused(400, "text must be the comment");
        if (hasSecret(body.text)) return refused(400, "text looks like it holds a secret; nothing was written");
        await comment(root, ref, body.text.trim(), { as: agent.role });
        return done(`commented on ${ref}`);
      }
      if (tool === "board_file") {
        // den-mvp/55: one ask files a batch.
        const { error, feature, drafts } = checkFileBatch(body);
        if (error) return refused(400, error);
        if (!allowed((input) => sameJson(input, cleanDeep(body)))) return refused(403, "the user has not allowed filing this batch");
        const refs = [];
        for (const d of drafts) {
          const blockers = d.blockedBy.map((b) => (Number.isInteger(b) ? refs[b - 1] : fullRef(b)));
          const { ref } = await (await boards.get("den")).create({ feature, slug: d.slug, title: d.title, text: d.text, priority: d.priority, form: "ticket", type: d.type, blockedBy: blockers, goal: d.goal, source: "den desk", status: "ready-for-human" }).catch((err) => {
            // Checked above, so this is the board changing underneath: say what was already filed.
            throw new BoardError(`${err.message}${refs.length ? ` (already filed: ${refs.join(", ")})` : ""}`);
          });
          refs.push(ref);
        }
        return done(`filed ${refs.length} ticket${refs.length === 1 ? "" : "s"} at ready-for-human: ${refs.join(", ")}`);
      }
      if (tool === "release_propose") {
        try {
          const d = await releases.propose();
          return done(`drafted ${d.version} at ${d.sha.slice(0, 12)} from ${d.prs.length} pull request${d.prs.length === 1 ? "" : "s"} (${d.bump} bump); it waits in the den for the user to approve or decline`);
        } catch (err) {
          return refused(409, String(err?.message ?? err).slice(0, 200));
        }
      }
      if (tool === "start_delivery") {
        const ref = fullRef(body.ref);
        if (!allowed((input) => input.ref === cleanText(body.ref))) return refused(403, "the user has not allowed starting this delivery");
        const holding = meetings.snapshot().find(m => m.held && m.ref === ref && m.project === 'den');
        if (holding) return refused(409, `Meeting ${holding.id} holds this task while its response is running`);
        const result = await delivery.start({ ref, ...(body.roles === undefined ? {} : { roles: body.roles }) });
        if (!result.ok) return refused(result.status, result.error);
        return done(`started the delivery of ${ref} (${result.delivery.id})`);
      }
      return refused(404, "no such den tool");
    } catch (err) {
      if (err instanceof BoardError) return refused(400, err.message);
      console.error(`bridge: den tool ${tool} failed: ${err?.stack ?? err}`);
      return refused(500, "the bridge could not do that");
    }
  }
  // POST /deliveries (den-mvp outcome 3): the user's approval of a ticket's delivery. Only `ref`, or `title` and `text`, are
  // read. With a ref, that ticket is delivered. With text, the board service writes a ticket for it first (the same one
  // Board write as POST /tasks), and that ticket is delivered. Nothing in the body reaches a prompt, argv or a branch name.
  async function postDelivery(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    let ref = body.ref;
    let ticket = {};
    // The router delivers a ref it read off the board; it never writes a ticket (ADR 0027 decision 3).
    if (routerRequests.has(req) && (typeof ref !== "string" || Object.keys(body).some((k) => k !== "ref" && k !== "from"))) {
      return reply(res, 403, { error: "the router may deliver a ticket by its ref only" });
    }
    if (ref === undefined) {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : text.split("\n")[0].slice(0, 80);
      if (!text) return reply(res, 400, { error: "ref, or text, must be given" });
      if (Buffer.byteLength(text) > TASK_MAX_BYTES) return reply(res, 400, { error: `text must be at most ${TASK_MAX_BYTES} bytes` });
      if (hasSecret(text) || hasSecret(title)) return reply(res, 400, { error: "text looks like it holds a secret; nothing was written" });
      try {
        ({ ref } = await (await boards.get("den")).create({ feature: DEN_FEATURE, slug: "delivery", title, text, source: "den" }));
      } catch (err) {
        console.error(`bridge: could not write a ticket for a delivery: ${err?.message ?? err}`);
        return reply(res, 400, { error: "could not write the ticket: the title must be one short line" });
      }
      ticket = { ticket: { ref } };
    }
    const holding = meetings.snapshot().find(m => m.held && m.ref === ref && m.project === 'den');
    if (holding) return reply(res, 409, { error: `Meeting ${holding.id} holds this task while its response is running` });
    const result = await delivery.start({ ref, ...(body.from === undefined ? {} : { from: body.from }), ...(body.roles === undefined ? {} : { roles: body.roles }) });
    if (!result.ok) return reply(res, result.status, { error: result.error, ...ticket });
    reply(res, result.status, { delivery: result.delivery, ...ticket });
  }
  // POST /deliveries/:id/resume | stop | close. Resume reads `verdict` ("approve" or "decline": the user's visual verdict) and,
  // with a decline, `note`; without a verdict, an optional `note` for the next run; nothing else.
  async function steerDelivery(req, res, action) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const id = new URL(req.url, "http://x").pathname.split("/")[2];
    const router = routerRequests.has(req);
    // The router gives no verdict and no note: those are the user's (ADR 0027 decision 8).
    if (router && Object.keys(body).length) return reply(res, 403, { error: "the router resumes with no verdict and no note" });
    const result = action === "resume" ? await delivery.resume(id, body.verdict === undefined ? (body.note === undefined ? {} : { note: body.note }) : { verdict: body.verdict, note: body.note }, { router }) : await delivery[action](id);
    if (!result.ok) return reply(res, result.status, { error: result.error });
    reply(res, result.status, { delivery: result.delivery });
  }
  // POST /meetings (den-mvp outcome 4): a meeting about `ref`, or about a topic alone. Only `ref`, `topic` and `roles` are
  // read. With no ref, the board service writes a discussion ticket for the topic first: it starts at ready-for-human and
  // its type is not one a delivery takes, so it is work for nobody. The topic reaches no prompt, argv or path: it is quoted
  // in that ticket and in the note each run is given.
  async function postMeeting(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (!topic || Buffer.byteLength(topic) > TOPIC_MAX_BYTES) return reply(res, 400, { error: `topic must be text of at most ${TOPIC_MAX_BYTES} bytes` });
    if (hasSecret(topic)) return reply(res, 400, { error: "topic looks like it holds a secret; nothing was written" });
    const title = `Meeting: ${topic.split(/[\n\r\u0085\u2028\u2029]/)[0].replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 90)}`;
    const result = await meetings.start({
      ...(body.ref === undefined ? {} : { ref: body.ref }), topic, roles: body.roles,
      project: body.project, moderator: body.moderator, depth: body.depth, budget: body.budget, continuedFrom: body.continuedFrom,
      suggestOnly: body.suggestOnly,
    });
    if (!result.ok) return reply(res, result.status, { error: result.error });
    reply(res, result.status, { meeting: result.meeting, ticket: result.ticket });
  }
  // POST /meetings/:id/resume | stop | close | decide | ask. decide reads `option`; ask reads `text` and `reask`; the rest read nothing.
  async function steerMeeting(req, res, action) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const id = new URL(req.url, "http://x").pathname.split("/")[2];
    if (action === "ask" && typeof body.text === "string" && hasSecret(body.text)) return reply(res, 400, { error: "text looks like it holds a secret; nothing was written" });
    const result = await meetings[action](id, body);
    if (!result.ok) return reply(res, result.status, { error: result.error });
    const { ok, status, ...data } = result;
    reply(res, status, data);
  }
  const sendOwn = (res, type, body) => {
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" });
    res.end(body);
  };
  // POST /checks (den-mvp/34): the user's "run the checks here" for an open pull request. Only `pr` is read; the commit is
  // the one the git host names as the pull request's head now. The run goes on after the answer; the den hears of its end.
  async function postChecks(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (!checks) return reply(res, 503, { error: "this bridge has no box to run the checks in" });
    if (!Number.isInteger(body.pr) || body.pr < 1) return reply(res, 400, { error: "pr must be a pull request number" });
    let st;
    try {
      st = await git.prState({ number: body.pr });
    } catch (err) {
      return reply(res, 502, { error: `could not read pull request #${body.pr}: ${String(err?.message ?? err).slice(0, 200)}` });
    }
    if (st.state !== "OPEN" || !/^[0-9a-f]{40}$/.test(st.sha ?? "")) return reply(res, 409, { error: `pull request #${body.pr} is not open` });
    if (checks.running().includes(st.sha)) return reply(res, 409, { error: "the checks of this commit are already running" });
    checks.run({ sha: st.sha, why: `pull request #${body.pr}` }).catch((err) => console.error(`bridge: checks of #${body.pr} failed: ${err?.message ?? err}`));
    reply(res, 202, { sha: st.sha });
  }
  // POST /release/approve | decline (den-mvp/45): the user's answer to Bao's release draft. Both read `id`, the draft's id.
  async function steerRelease(req, res, action) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (typeof body.id !== "string" || !body.id) return reply(res, 400, { error: "id must be the draft's id" });
    const result = await releases[action](body.id);
    if (!result.ok) return reply(res, result.status, { error: result.error });
    reply(res, 200, result.release ?? { declined: true });
  }
  // POST /tickets/approve | decline (den-mvp/13): the user's answer to a ticket waiting at ready-for-human. Approve reads `ref`;
  // decline reads `ref` and `note` (required: it is the reason the ticket is closed, and goes under its Comments).
  // A ticket at any other status, or none, is a 409; the board service does the write.
  async function steerTicket(req, res, action) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (typeof body.ref !== "string" || !body.ref) return reply(res, 400, { error: "ref must be a string" });
    let note = "approved from the den";
    if (action === "decline") {
      note = typeof body.note === "string" ? body.note.trim() : "";
      if (!note) return reply(res, 400, { error: "note must be a non-empty string: the reason for the decline" });
      if (note.length > 500) return reply(res, 400, { error: "note must be at most 500 characters" });
      if (hasSecret(note)) return reply(res, 400, { error: "note looks like it holds a secret; nothing was written" });
    }
    const board = await boards.get(typeof body.project === "string" ? body.project : await projects.active());
    if (!board) return reply(res, 404, { error: "no such project" });
    const ticket = await board.read(body.ref).catch(() => null);
    if (ticket?.status !== "ready-for-human") return reply(res, 409, { error: "the ticket is not waiting for you" });
    // codex-residents/05: the user picks the coordinator at approval; no choice is Bao, as every earlier ticket was.
    const owner = body.owner === undefined ? "bao" : body.owner;
    if (action === "approve" && !COORDINATORS.includes(owner)) return reply(res, 400, { error: `owner must be one of: ${COORDINATORS.join(", ")}` });
    try {
      await board.setStatus(body.ref, action === "approve" ? "ready-for-agent" : "closed", note);
    } catch (err) {
      if (!(err instanceof BoardError)) throw err;
      return reply(res, 409, { error: `not changed: ${err.message}` });
    }
    // ADR 0027: the router starts only tickets in the work order, so an approval lists the ticket last there. A `user acts`
    // ticket (the snapshot keeps the type's first word: "user") needs the user, not an agent, and is not listed. A failed
    // write leaves the ticket approved and unlisted.
    if (action === "approve") {
      const owned = await host.admission.approve(body.ref, { owner });
      if (!owned.ok) console.error(`bridge: could not record the owner of ${body.ref}: ${owned.error}`);
    }
    let ordered = false;
    if (action === "approve" && ticket.type !== "user" && board.root === root) {
      try {
        const next = appendToOrder(await readFile(orderFile, "utf8").catch((err) => (err.code === "ENOENT" ? "" : Promise.reject(err))), body.ref);
        if (next !== null) await writeFile(orderFile, next);
        ordered = true;
      } catch (err) {
        console.error(`bridge: could not add ${body.ref} to the work order: ${err?.message ?? err}`);
      }
    }
    reply(res, 200, { ref: body.ref, status: action === "approve" ? "ready-for-agent" : "closed", ...(action === "approve" ? { ordered } : {}) });
  }
  // POST /tickets/transfer: { ref, owner }. Ownership moves only once no attempt on the ticket is live or unconfirmed.
  async function steerTransfer(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (typeof body.ref !== "string" || !body.ref) return reply(res, 400, { error: "ref must be a string" });
    const result = await host.admission.transfer(body.ref, body.owner);
    reply(res, result.ok ? 200 : result.status, result.ok ? { ref: body.ref, owner: result.owner, epoch: result.epoch } : { error: result.error });
  }
  // POST /admission/runtime: { allow: "both" | "codex" | "claude" }. Governs new admissions only.
  async function steerAllowlist(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const result = await host.admission.setAllowlist(body.allow);
    reply(res, result.ok ? 200 : result.status, result.ok ? { allow: result.allow } : { error: result.error });
  }
  // POST /profile: { name: "lean" | "full" }. The user's hand flip (trust-ladder/01); nothing else calls it, and it needs no restart.
  async function steerProfile(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (typeof body.name !== "string" || !body.name) return reply(res, 400, { error: "name must be lean or full" });
    let view;
    try {
      view = await profile.set(body.name);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    hub.publish({ type: "profile", profile: view });
    reply(res, 200, { profile: view });
  }
  // POST /accounts/active: { name }. The user's manual switch of the den's Claude account; nothing else calls it (hardening/16).
  async function steerAccount(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (typeof body.name !== "string" || !body.name) return reply(res, 400, { error: "name must be an account name" });
    if (!proxy) return reply(res, 409, { error: "the den has no proxy: there are no accounts" });
    try {
      await proxy.switchAccount(body.name);
    } catch (err) {
      return reply(res, 409, { error: err.message });
    }
    const accounts = await proxy.status();
    hub.publish({ type: "accounts", accounts });
    reply(res, 200, { accounts });
  }
  // POST /admission/reconcile: { id, outcome: "ended" | "never-started" }. Clears an attempt a crash left unconfirmed.
  async function steerReconcile(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const result = await host.admission.reconcile(body.id, body.outcome);
    reply(res, result.ok ? 200 : result.status, result.ok ? { id: body.id } : { error: result.error });
  }
  // POST /build/rollback (ADR 0026 decision 7): the user's roll back. Only `to` is read: the release the button showed as
  // previous. Anything else, and a den that runs from the checkout, is a 409 and nothing changes.
  async function rollBack(req, res) {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (typeof body.to !== "string") return reply(res, 400, { error: "to must be the commit id of the previous build" });
    if (!denBuild || !(await readBuild_())) return reply(res, 409, { error: "the den runs from the checkout: there are no release folders to roll back" });
    try {
      await denBuild.rollback(body.to); // queued behind any go-live; the build frame goes out from there
    } catch (err) {
      if (!(err instanceof ReleaseError)) throw err;
      return reply(res, 409, { error: err.code === "bad-sha" ? "to must be the commit id of the previous build" : `not rolled back: ${err.message}` });
    }
    reply(res, 200, { build: await readBuild_() });
  }
  // Static UI build (ADR 0011 decision 2): unknown paths serve index.html; traversal is a 403.
  async function serveStatic(pathname, req, res) {
    let rel;
    try {
      // URL parsing already collapses "/../"; check the raw target so traversal is a 403, not a quiet remap.
      const rawPath = decodeURIComponent(req.url.split(/[?#]/)[0]);
      if (rawPath.split(/[\\/]/).includes("..")) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("forbidden");
        return;
      }
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad request target");
      return;
    }
    // The links are resolved on every request, so a switch is seen by the next one.
    const roots = denState ? await resolveUi(denState) : null;
    const base = path.resolve(roots?.current ?? uiDir);
    const inside = (dir) => path.resolve(dir, "." + (rel.startsWith("/") ? rel : "/" + rel));
    const target = inside(base);
    if (rel.includes("\0") || (target !== base && !target.startsWith(base + path.sep))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }
    let file = target;
    let body;
    try {
      body = await readFile(file);
    } catch {
      // An open tab of the previous build still asks for its own hashed parts; index.html only ever comes from the current one.
      if (roots?.previous && rel.startsWith("/assets/")) {
        const older = inside(roots.previous);
        if (older.startsWith(roots.previous + path.sep)) {
          try {
            file = older;
            body = await readFile(file);
          } catch {}
        }
      }
    }
    if (body === undefined) {
      file = target;
      if (path.extname(rel)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      file = path.join(base, "index.html");
      try {
        body = await readFile(file);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("ui not built: run npm run ui:build");
        return;
      }
    }
    res.writeHead(200, { "Content-Type": contentTypeFor(file), "Cache-Control": "no-store", "Content-Security-Policy": CSP });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  // hardening/16: the proxy and its refreshers come up with the den, before it answers.
  await proxy?.start();
  // A half-made release folder is never served, and is removed at start; a delivery's waiting preview is served again.
  await delivery.ready;
  if (denBuild) await denBuild.releases.sweep();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  actualPort = server.address().port;
  async function stopWork() {
    await host.shutdown();
    await new Promise((resolve) => setImmediate(resolve)); // the runs' end hooks are queued behind the shutdown
    await Promise.allSettled([...settling]); // den-mvp/89: a Run's claim is given back before the board goes away
    await delivery.shutdown();
    await meetings.shutdown();
  }
  const uninstallProcessHandlers = runtime || runtimes ? installProcessHandlers(host) : () => {};
  return {
    url: `http://${HOST}:${actualPort}`,
    port: actualPort,
    newLaunchCode: auth.newLaunchCode,
    previewReads,
    host: { start: host.start, message: host.message, retire: host.retire, shutdown: host.shutdown, admission: host.admission },
    releases: { propose: releases.propose }, // den-mvp/45: a test seam; the tool route is the agents' only way in
    pollRelease: () => autoRelease.poll().then(() => readyRelease?.poll()), // den-mvp/85: one look of each release timer, for a test
    pollCi: () => ciWatch.poll(), // one look of the CI watch now, for a test (its timer is off there)
    close: async () => {
      await stopWork();
      updater?.stop();
      ciWatch.stop();
      autoRelease.stop();
      readyRelease?.stop();
      await proxy?.stop();
      uninstallProcessHandlers();
      await new Promise((resolve) => {
        hub.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/** den-revival/03: DEN_CODEX=1 adds the Codex runtime (host launch, its own resource group) beside Claude's; off, the one Claude runtime stays as it was. */
export async function runtimeOptions({ env, claude, root }) {
  if (env.DEN_CODEX !== "1") return { runtime: claude };
  const { createCodexRuntime } = await import("./agents/codex-runtime.mjs");
  return { runtimes: { claude, codex: createCodexRuntime({ env, controlRoot: root }) } };
}

// Started through the service's bridge/current link, argv[1] is the link and import.meta.url the release it points to: compare real paths.
const startedDirectly = () => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};
if (startedDirectly()) {
  const { resolveRoot } = await import("../board/board-service.mjs");
  const root = resolveRoot(process.cwd(), process.env);
  // The default runtime (organism-infra/143): the binary is DEN_CLAUDE_BIN, else `claude` on PATH.
  const { createClaudeRuntime } = await import("./agents/claude-runtime.mjs");
  // The delivery log is kept outside the repository, so it is in no agent's worktree and under no path a task can be granted.
  const { createHash } = await import("node:crypto");
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  // The service's unit names the den's state folder (DEN_STATE_DIR): the one `den:install` made the releases in, whatever
  // XDG_STATE_HOME was in the installing shell. Without it, the default place.
  const denState = path.isAbsolute(process.env.DEN_STATE_DIR ?? "") ? process.env.DEN_STATE_DIR : path.join(stateHome, "den");
  const stateDir = path.join(denState, "projects", createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16));
  // One launcher for the agents and the build box: its units are named per instance.
  const { createResourceLauncher } = await import("./agents/resource-group.mjs");
  const { createBuildBox } = await import("./build/box.mjs");
  const launcher = createResourceLauncher({ env: process.env });
  // den-mvp/34: the records go to the board's run folder, next to the conversations, where the user and Bao read them.
  const { createChecks } = await import("./delivery/checks.mjs");
  // A launcher of their own: the checks group, in its own slice, outside the agents' aggregate.
  const { checksLimits, CHECKS_SLICE } = await import("./agents/resource-group.mjs");
  const checksLauncher = createResourceLauncher({ env: process.env, limits: checksLimits(), slice: CHECKS_SLICE });
  // The box mounts the den's packages folder for each commit's own lockfile (deps/<lock-hash>, made by den:update).
  const checks = createChecks({ repo: root, launcher: checksLauncher, recordDir: path.join(root, ".scratch", "_run", "checks"), depsDir: path.join(denState, "deps") });
  // den-mvp/88: the router's service token, written by den:install; none (or a bad file) means no service access.
  const { readServiceToken } = await import("../router/service-token.mjs");
  const serviceToken = await readServiceToken(denState);
  // hardening/16: the credential proxy and one refresher per den account. It needs the agent image den:update recorded in this release;
  // run from the checkout, or on a host with no image, there is none. A proxy that fails to start is reported and the den still comes up.
  const { createProxyService } = await import("./proxy/proxy-service.mjs");
  const { createDocker } = await import("./service/agent-image.mjs");
  const releaseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const image = await readFile(path.join(releaseDir, "agent-image.json"), "utf8").then((t) => JSON.parse(t).imageId, () => null);
  const proxyService = image && createProxyService({ stateDir: denState, releaseDir, ceilings: JSON.parse(await readFile(path.join(releaseDir, "apps", "bridge", "agents", "ceilings.json"), "utf8")), docker: createDocker({ env: process.env }), image });
  const proxy = proxyService ? { ...proxyService, start: () => proxyService.start().catch((e) => console.error(`proxy not started: ${e.message}`)) } : undefined;
  // hardening/10 (ADR 0031): DEN_AGENT_CONTAINERS=1 starts each agent in its own container. Off (the default), agents start as before.
  // On with no image or no proxy, the den does not start: an agent must never silently run on the host the owner asked to keep it off.
  let agentLauncher = launcher;
  if (process.env.DEN_AGENT_CONTAINERS === "1") {
    if (!image || !proxyService) throw new Error("DEN_AGENT_CONTAINERS=1 needs the agent image and the credential proxy: run npm run den:update");
    const { createContainerLauncher } = await import("./agents/container.mjs");
    agentLauncher = createContainerLauncher({ env: process.env, image, docker: createDocker({ env: process.env }), proxy: proxyService, sessionsDir: path.join(denState, "agent-sessions") });
  }
  const bridge = await startBridge({ root, port: Number(process.env.PORT) || 4317, auth: serviceToken ? { serviceToken } : undefined, proxy, ...(await runtimeOptions({ env: process.env, claude: createClaudeRuntime({ env: process.env, launcher: agentLauncher, controlRoot: root }), root })), box: createBuildBox({ launcher }), stateDir, denState, library: createLibrary({ stateDir }), watchCi: true, usage: createUsageReading(), checks, exit: (code) => process.exit(code) });
  console.log(`bridge listening on ${bridge.url} (root ${root})`);
  // The only place the launch code is shown (ADR 0016 decision 6.2): once, in a URL fragment the browser never sends.
  console.log(`to steer, open (one use, 5 minutes): ${bridge.url}/#code=${bridge.newLaunchCode()}`);
  // F39 (npm run den:link): SIGUSR2 prints one more launch URL to the same console, so a second browser or a recording
  // needs no restart. Only the user's own account can signal this process; a run's agent is in a pid namespace of its own.
  process.on("SIGUSR2", () => console.log(`to steer, open (one use, 5 minutes): ${bridge.url}/#code=${bridge.newLaunchCode()}`));
}
