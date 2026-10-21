#!/usr/bin/env node
// A tree node's only delegation channel. The bridge derives its parent from a
// per-run credential; no tool accepts parent, owner, runtime, model or grants.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const criteria = { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false,
  properties: { criterion: { type: "string", maxLength: 8192 }, evidence: { type: "string", maxLength: 2000 } }, required: ["criterion", "evidence"] } };
const checks = { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false,
  properties: { command: { type: "string", maxLength: 8192 }, passed: { type: "boolean" }, evidence: { type: "string", maxLength: 2000 } }, required: ["command", "passed", "evidence"] } };
const nodeIds = { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string" } };

export const TREE_TOOLS = [
  { name: "delegate", description: "Queue one approved direct child within this task's scopes. Spawning is optional and capacity-controlled. Yield to release your session while required children work; do not retry an uncertain request or increase limits. Runners cannot delegate.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      nodeId: { type: "string", description: "The direct child ID in the complete tree revision the user approved. Its role, task and scopes are fixed by that revision." },
    }, required: ["nodeId"] } },
  { name: "result", description: "Read this parent's own child's status and final evidence. Check the candidate commit before relying on a result. It grants no review or publication approval.",
    inputSchema: { type: "object", additionalProperties: false, properties: { childId: { type: "string" } }, required: ["childId"] } },
  { name: "status", description: "Read the fixed approved plan, node IDs and workflow states for this live tree. It exposes no private role conversation.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "yield", description: "Wait for these approved direct children and release this execution session. The bridge wakes the same logical parent only after their required verification and integration succeed. This does not cancel children.",
    inputSchema: { type: "object", additionalProperties: false, properties: { children: { ...nodeIds, minItems: 1, maxItems: 4 } }, required: ["children"] } },
  { name: "complete", description: "Submit this author's completion evidence against the exact approved criteria and check commands. Completion is not acceptance: candidate-bound independent reviews and required child barriers still apply. The owner may omit never-started subtrees; a manager may omit only its own never-started direct runners. Approved criteria remain required.",
    inputSchema: { type: "object", additionalProperties: false, properties: { unused: nodeIds, criteria, checks }, required: ["criteria", "checks"] } },
  { name: "review", description: "Submit the fresh review phase's verdict and evidence for its exact candidate. Only the bridge-selected independent reviewer phase can use this; authors cannot approve their own work or change the candidate.",
    inputSchema: { type: "object", additionalProperties: false, properties: { candidate: { type: "string", pattern: "^[0-9a-f]{40,64}$" }, verdict: { enum: ["pass", "bounce"] }, criteria, checks,
      findings: { type: "array", maxItems: 30, items: { type: "string", maxLength: 2000 } },
      guardVerdicts: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
        properties: { hit: { type: "string", maxLength: 8192 }, verdict: { enum: ["accept", "bounce"] }, reason: { type: "string", maxLength: 2000 } }, required: ["hit", "verdict", "reason"] } } }, required: ["candidate", "verdict", "criteria", "checks", "findings"] } },
  { name: "skip", description: "The owner may omit complete never-started subtrees; a manager may omit only its own never-started direct runners. This cannot skip required criteria or reviews, started or queued work, or dependencies needed by retained nodes.",
    inputSchema: { type: "object", additionalProperties: false, properties: { nodes: nodeIds }, required: ["nodes"] } },
];

export async function callTreeTool(name, args, { url, token, fetcher = fetch } = {}) {
  const error = (text) => ({ content: [{ type: "text", text }], isError: true });
  if (!TREE_TOOLS.some((tool) => tool.name === name)) return error("Unknown tree tool.");
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(token ?? "")) return error("This run has no tree credential.");
  try {
    const response = await fetcher(`${url}/tree-tools/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: url, Authorization: `Bearer ${token}` },
      body: JSON.stringify(args ?? {}), signal: AbortSignal.timeout(30000),
    });
    const body = await response.json();
    if (!response.ok) return error(`Refused (${response.status}): ${body.error ?? "no reason given"}`);
    return { content: [{ type: "text", text: body.text ?? JSON.stringify(body) }] };
  } catch {
    // A timed-out spawn may have been admitted. Do not retry it automatically.
    return error("Tree request outcome is uncertain. Check the task tree before attempting more work; do not retry the request.");
  }
}

function serve() {
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  createInterface({ input: process.stdin }).on("line", async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== "object" || message.id === undefined) return;
    const { id, method, params } = message;
    if (method === "initialize") return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "tree", version: "1" } } });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: TREE_TOOLS } });
    if (method === "tools/call") return send({ id, result: await callTreeTool(params?.name, params?.arguments, { url: process.env.DEN_BRIDGE_URL, token: process.env.DEN_RUN_TOKEN }) });
    send({ id, error: { code: -32601, message: "unknown method" } });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
