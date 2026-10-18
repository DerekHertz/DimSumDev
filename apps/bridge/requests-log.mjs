// Gate requests log (ADR 0011 decision 6). One append-only JSONL file; a request is pending
// until a later {handled, ts, outcome} line names its id. Shared by the bridge (snapshot, POST)
// and scripts/requests.mjs, so both agree on what "pending" means.
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const REQUEST_KINDS = ["merge-approve", "merge-reject", "dispatch-approve", "dispatch-reject"];
// den-mvp/88: a stop the router met (POST /router-stops, its service token); not a gate request, so not in REQUEST_KINDS.
export const ROUTER_STOP = "router-stop";
const HANDLED_KEPT = 10;

export const requestsFile = (root) => path.join(root, ".scratch", "_requests", "requests.jsonl");

export async function readRequestRows(root) {
  let text;
  try {
    text = await readFile(requestsFile(root), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // malformed line: skip
    }
  }
  return rows;
}

// All requests, oldest first, each with state "pending" | "handled".
export function foldRequests(rows) {
  const byId = new Map();
  const order = [];
  for (const r of rows) {
    if (typeof r.handled === "string") {
      const req = byId.get(r.handled);
      if (req && req.state === "pending") {
        req.state = "handled";
        req.outcome = r.outcome;
        req.handledAt = r.ts;
      }
    } else if (typeof r.id === "string" && !byId.has(r.id)) {
      const { id, ts, kind, ref, note, key, stopKind } = r;
      const req = { id, ts, kind, ref, ...(note !== undefined ? { note } : {}), ...(kind === ROUTER_STOP ? { key, stopKind } : {}), state: "pending" };
      byId.set(id, req);
      order.push(req);
    }
  }
  return order;
}

// Snapshot shape: every pending request and the newest handled ones.
export function buildRequests(rows) {
  const order = foldRequests(rows);
  const keep = new Set(order.filter((r) => r.state === "handled").slice(-HANDLED_KEPT));
  return order.filter((r) => r.state === "pending" || keep.has(r));
}

export async function appendRequestLine(root, obj) {
  const file = requestsFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(obj) + "\n");
}
