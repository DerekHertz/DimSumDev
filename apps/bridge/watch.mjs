// Change hub (ADR 0011 decisions 2 and 5): watches .scratch, rebuilds the
// snapshot, diffs it against the previous one and fans typed change events out
// to SSE clients. Internal to the bridge; tested only through GET /events.
import fs from "node:fs";
import path from "node:path";
import { buildSnapshot } from "./snapshot.mjs";

const DEBOUNCE_MS = 100;
const NET_MS = 2000;
const PING_MS = 15000;
const DRAIN_MS = 5000;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fileSig(file) {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

// Pure diff of two snapshots into change payloads (without seq).
function diff(prev, next) {
  const out = [];
  const before = new Map(prev.tickets.map((t) => [t.ref, t]));
  const after = new Map(next.tickets.map((t) => [t.ref, t]));
  for (const [ref, t] of after) {
    if (!same(before.get(ref), t)) out.push({ type: "ticket", ref, ticket: t });
  }
  for (const ref of before.keys()) {
    if (!after.has(ref)) out.push({ type: "ticket", ref, ticket: null });
  }
  if (!same(prev.frontier, next.frontier)) out.push({ type: "frontier", refs: next.frontier });
  if (!same(prev.usage, next.usage)) out.push({ type: "usage", usage: next.usage });
  if (prev.sessions !== next.sessions) out.push({ type: "sessions", sessions: next.sessions });
  if (!same(prev.requests, next.requests)) out.push({ type: "requests", requests: next.requests });
  return out;
}

// agents: () => the live and replayed agents for the snapshot (organism-infra/140); they come from the steering host,
// not from .scratch, and reach clients through publish() as soon as they change.
// transcripts: () => the host's kept transcript buffers (den-v1 loop S2); their frames also reach clients through publish().
// build: async () => the den's own build (den-mvp/11, ADR 0026 decision 7), or null when it runs from the checkout; a
// switch reaches clients through publish() as { type: "build", build }.
// capacity: (lockedRefs) => the snapshot's `capacity` key (organism-infra/227, ADR 0011 decision 3). The host owns the live
// agents and the limits; the hub passes the refs of the tickets that hold a claim lock in the snapshot it is serving.
export function createHub(root, { agents = () => [], approvals = () => [], transcripts = () => ({}), capacity = () => null, deliveries = () => [], meetings = () => [], ci = () => null, checks = async () => null, build = async () => null, release = () => null, readyRelease = () => null, update = () => null, readUsage = () => null, wall = () => null, boardRoot = async () => root } = {}) {
  const scratch = path.join(root, ".scratch");
  const clients = new Set();
  let seq = 0;
  let current = null;
  let metricsSig = null;
  let chain = Promise.resolve();
  let closed = false;

  const metricsSigNow = () => `${fileSig(path.join(scratch, "usage.jsonl"))}|${fileSig(path.join(scratch, "events.jsonl"))}`;

  function send(res, chunk) {
    if (res.destroyed || res.writableEnded) return;
    if (res.write(chunk) === false && !res.drainTimer) {
      res.drainTimer = setTimeout(() => res.destroy(), DRAIN_MS);
      res.once("drain", () => {
        clearTimeout(res.drainTimer);
        res.drainTimer = null;
      });
    }
  }
  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  async function doRefresh() {
    if (closed) return;
    const sig = metricsSigNow();
    const next = await buildSnapshot(root, seq, { readUsage, boardRoot: await boardRoot() });
    if (!current) {
      current = next;
      metricsSig = sig;
      return;
    }
    const events = diff(current, next);
    if (sig !== metricsSig) events.push({ type: "metrics-changed" });
    metricsSig = sig;
    // Ticket-level fields are compared; seq and generatedAt are envelope-only.
    current = next;
    for (const ev of events) {
      seq += 1;
      const payload = { seq, ...ev };
      for (const res of clients) send(res, frame("change", res.denView ? res.denView.change(payload) : payload));
    }
    current.seq = seq;
  }

  // Serialised so concurrent triggers never interleave diffs.
  function refresh() {
    chain = chain.then(doRefresh).catch((err) => console.error(`bridge: refresh failed: ${err.stack ?? err}`));
    return chain;
  }

  let debounce = null;
  const trigger = () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, DEBOUNCE_MS);
  };

  let watcher = null;
  try {
    watcher = fs.watch(scratch, { recursive: true }, trigger);
    watcher.on("error", () => {});
  } catch {
    // The 2 s safety net still runs.
  }
  const net = setInterval(refresh, NET_MS);
  const ping = setInterval(() => {
    for (const res of clients) send(res, ": ping\n\n");
  }, PING_MS);
  net.unref();
  ping.unref();

  return {
    ready: refresh(),
    async snapshot() {
      await refresh();
      const lockedRefs = current.tickets.filter((t) => t.holder).map((t) => t.ref);
      return { ...current, agents: agents(), approvals: approvals(), transcripts: transcripts(), capacity: await capacity(lockedRefs), deliveries: deliveries(), meetings: meetings(), ci: ci(), checks: await checks(), build: await build(), release: release(), readyRelease: readyRelease(), update: update(), wall: wall(), seq };
    },
    // An agent change goes out at once (no debounce, no 2 s net): { type: "agent", agent: object | null }; so do
    // { type: "approval", approval } and { type: "transcript", agentId, entry }.
    publish(change) {
      if (closed) return;
      seq += 1;
      if (current) current.seq = seq;
      const payload = { seq, ...change };
      for (const res of clients) send(res, frame("change", res.denView ? res.denView.change(payload) : payload));
    },
    // view (den-mvp/09): { snapshot(s), change(c) } applied to everything this one client is sent (a preview's stream).
    // A change it hides must keep its seq, so the client's sequence has no gap.
    async connect(req, res, view = null) {
      const snap = view ? view.snapshot(await this.snapshot()) : await this.snapshot();
      res.denView = view;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      clients.add(res);
      const drop = () => {
        clients.delete(res);
        clearTimeout(res.drainTimer);
      };
      req.on("close", drop);
      res.on("close", drop);
      send(res, frame("snapshot", snap));
    },
    close() {
      closed = true;
      clearTimeout(debounce);
      clearInterval(net);
      clearInterval(ping);
      watcher?.close();
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
