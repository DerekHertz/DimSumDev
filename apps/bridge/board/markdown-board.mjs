// The markdown adapter of the Board interface (ADR 0021 Amendment 5 decision 24, Amendment 7 decision 25): a project's
// `.scratch/` tree. Writes are the delivery board's (the board service underneath); reads are the file reads the snapshot
// made before the seam existed, moved here unchanged. The GitHub adapter (github-issues.mjs) answers the same interface.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createTicket, setOffRelay } from "../../board/board-service.mjs";
import { orderFrontier, parsePriority } from "../../board/priority.mjs";
import { createDeliveryBoard } from "../delivery/board.mjs";

const OFF_RELAY = new Set(["resolved", "closed", "parked"]);

const readText = (file) => readFile(file, "utf8").catch(() => null);
const listDir = (dir) => readdir(dir).catch(() => []);

const headerValue = (md, label) => {
  const m = new RegExp(`^\\*\\*${label}:\\*\\*[ \\t]*(.*?)[ \\t]*$`, "m").exec(md);
  return m ? m[1] : null;
};

function parseTicket(md, feature) {
  const title = /^#[ \t]+(.+?)[ \t]*$/m.exec(md)?.[1] ?? "";
  const typeRaw = headerValue(md, "Type");
  const type = typeRaw ? (typeRaw.split(/\s+/)[0] || "").toLowerCase() || null : null;
  const blockedBy = [];
  for (const tok of (headerValue(md, "Blocked by") ?? "").split(",")) {
    const m = /^\s*(?:([a-z0-9-]+)\/)?(\d+)/.exec(tok);
    if (m) blockedBy.push(`${m[1] ?? feature}/${m[2]}`);
  }
  let blockedReason = null;
  const ci = md.search(/^## Comments\s*$/m);
  if (ci >= 0) {
    const bullets = md.slice(ci).split("\n").filter((l) => /^- /.test(l));
    if (bullets.length) blockedReason = bullets[bullets.length - 1].slice(2).trim();
  }
  return { title, type, status: headerValue(md, "Status") ?? "unknown", goal: headerValue(md, "Goal") || null, priority: parsePriority(md), blockedBy, blockedReason };
}

export function createMarkdownBoard(root) {
  const scratch = path.join(root, ".scratch");
  const delivery = createDeliveryBoard(root);
  // Every ticket file, resolved ones included. A ticket is the normalized shape plus what the snapshot overlays need:
  // feature, nn, goal, blockedReason, mtimeMs, and the file's own text while it waits on the user.
  async function list() {
    const tickets = [];
    for (const feature of await listDir(scratch)) {
      const issues = path.join(scratch, feature, "issues");
      for (const name of await listDir(issues)) {
        const m = /^(\d+)-.*\.md$/.exec(name);
        if (!m) continue;
        const file = path.join(issues, name);
        const md = await readText(file);
        if (md === null) continue;
        const st = await stat(file);
        const t = parseTicket(md, feature);
        const locked = await readText(path.join(issues, `${name.slice(0, -3)}.lock`));
        let holder = null;
        if (locked !== null) {
          const [role, since] = locked.trim().split(/\s+/);
          holder = { role: role ?? null, since: since ?? null };
        }
        tickets.push({ ref: `${feature}/${name.slice(0, -3)}`, feature, nn: m[1], ...t, holder, mtimeMs: st.mtimeMs, ...(t.status === "ready-for-human" ? { text: md } : {}) });
      }
    }
    return tickets;
  }
  return {
    ...delivery,
    kind: "markdown",
    root,
    list,
    async read(ref) {
      const t = (await list()).find((x) => x.ref === ref);
      if (!t) throw new Error("markdown board: no such ticket");
      return { ...t, text: await readText(path.join(scratch, t.feature, "issues", `${t.ref.slice(t.feature.length + 1)}.md`)) ?? "" };
    },
    /** Ready, unclaimed, unblocked tickets in the den's queue order. */
    async frontier() {
      const all = await list();
      const done = new Set(all.filter((t) => OFF_RELAY.has(t.status)).map((t) => `${t.feature}/${Number(t.nn)}`));
      const ready = all.filter((t) => t.status === "ready-for-agent" && !t.holder && t.blockedBy.every((b) => done.has(b.replace(/\/0*(\d+)$/, "/$1"))));
      return orderFrontier(ready.map((t) => ({ ref: t.ref, priority: t.priority, readySince: new Date(t.mtimeMs).toISOString() }))).map((o) => o.ref);
    },
    /** A new ticket: the board service's createTicket, its options passed on. -> { ref, ... } */
    create: (opts) => createTicket(root, opts),
    /** The user's answer to a ticket at ready-for-human: 'ready-for-agent' approves, 'closed' declines. */
    setStatus: (ref, status, note) => {
      if (status !== "ready-for-agent" && status !== "closed") throw new TypeError("markdown board: status must be ready-for-agent or closed");
      return setOffRelay(root, [ref], status === "ready-for-agent" ? "approve" : "close", { reason: note });
    },
  };
}
