#!/usr/bin/env node
// den-mvp/38: the den's own connection, for Bao's desk. It speaks the Model Context Protocol over stdio (one JSON-RPC
// message per line) and does nothing itself: each tool call goes to the bridge (POST /den-tools/<tool>) with the token
// the bridge minted for this run, and the bridge does the work with its own board and git-host rights. The address
// and token come from this process's environment, which the bridge wrote into the run's 0600 MCP config.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const BRIDGE = process.env.DEN_BRIDGE_URL ?? "";
const TOKEN = process.env.DEN_RUN_TOKEN ?? "";
const REF = { type: "string", description: "A ticket ref, such as den-mvp/02 or den-mvp/02-job-storage-quota." };
export const DEN_TOOLS = [
  { name: "board_resolve", description: "Resolve a ticket whose pull request has merged. The bridge checks the merge first.",
    inputSchema: { type: "object", properties: { ref: REF, pr: { type: "integer", description: "The merged pull request's number." } }, required: ["ref", "pr"] } },
  { name: "board_comment", description: "Add a comment to a ticket, as Bao.",
    inputSchema: { type: "object", properties: { ref: REF, text: { type: "string" } }, required: ["ref", "text"] } },
  { name: "board_file", description: "File new tickets at ready-for-human, for the user to approve. One ticket is one outcome the user would notice: findings from a review, or several small fixes in one area, go in one ticket as a - [ ] checklist, or as a board_comment on that area's open follow-up ticket, never one ticket per finding. Send every ticket of one request in a single call: the user answers one ask for the whole batch. Each text is the ticket body in markdown (## What to build, ## Acceptance criteria with - [ ] items); the board writes the title, Type, Priority, Status and Blocked by lines itself. A batch that breaks a rule is refused with the reason before the user is asked.",
    inputSchema: { type: "object", properties: {
      feature: { type: "string", description: "The board feature, such as den-mvp. Default: den. It must already have a .scratch/<feature>/issues/ folder." },
      tickets: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", properties: {
        title: { type: "string", description: "One short line." },
        goal: { type: "string", description: "The key of the goal this ticket serves, from the table in .scratch/goals.md (read it first)." },
        text: { type: "string", description: "The body in markdown, at most 8192 bytes. Must have a ## Acceptance criteria section; no **Status:**-style header lines." },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        type: { type: "string", description: "A few lowercase words: feature, bug, task, design question. Default: task." },
        blockedBy: { type: "array", items: { anyOf: [{ type: "string" }, { type: "integer", minimum: 1 }] },
          description: "Tickets this one waits on: a ref such as den-mvp/47, or the 1-based position of an earlier ticket in this batch." },
        slug: { type: "string", description: "Optional file name, lowercase words joined by -. Default: from the title." },
      }, required: ["title", "text", "goal"] } },
    }, required: ["tickets"] } },
  { name: "start_delivery", description: "Start the den's delivery of a ready-for-agent ticket the user asked to start. Asks the user first.",
    inputSchema: { type: "object", properties: { ref: REF, roles: { type: "array", items: { type: "string", enum: ["technical-writer", "code-reviewer", "qa", "security", "user-verdict"] }, maxItems: 5, description: "Roles to add to the ticket's required ones. Nothing here removes a role." } }, required: ["ref"] } },
  { name: "release_propose", description: "Draft the next release from the pull requests merged since the last tag: the version, the commit and the notes. The user approves or declines the draft in the den; only their Approve tags and publishes.",
    inputSchema: { type: "object", properties: {} } },
];
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function call(name, args) {
  if (!BRIDGE || !TOKEN) return text("The den connection has no bridge address or token, so it cannot act.", true);
  try {
    const res = await fetch(`${BRIDGE}/den-tools/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BRIDGE, Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(args ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok ? text(String(body.text ?? "done")) : text(`Refused (${res.status}): ${body.error ?? "no reason given"}`, true);
  } catch {
    return text("Could not reach the bridge.", true);
  }
}

function serve() { createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg === null || typeof msg !== "object" || msg.id === undefined) return; // a notification needs no answer
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "den", version: "1" } } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (method === "tools/list") {
    send({ id, result: { tools: DEN_TOOLS } });
  } else if (method === "tools/call") {
    if (!DEN_TOOLS.some((t) => t.name === params?.name)) return send({ id, error: { code: -32602, message: "unknown tool" } });
    send({ id, result: await call(params.name, params.arguments) });
  } else {
    send({ id, error: { code: -32601, message: "unknown method" } });
  }
}); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
