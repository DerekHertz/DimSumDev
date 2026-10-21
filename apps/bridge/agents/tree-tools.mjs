#!/usr/bin/env node
// A tree node's only delegation channel. The bridge derives its parent from a
// per-run credential; no tool accepts parent, owner, runtime, model or grants.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const TREE_TOOLS = [
  { name: "delegate", description: "Delegate one bounded subtask within this task's approved scopes. Spawning is optional. A busy runtime refuses the request; sequence work instead of retrying or increasing limits. Managers verify returned evidence. Runners cannot delegate.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      nodeId: { type: "string", description: "The direct child ID in the complete tree revision the user approved. Its role, task and scopes are fixed by that revision." },
    }, required: ["nodeId"] } },
  { name: "result", description: "Read this parent's own child's status and final evidence. Check the candidate commit before relying on a result. It grants no review or publication approval.",
    inputSchema: { type: "object", additionalProperties: false, properties: { childId: { type: "string" } }, required: ["childId"] } },
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
