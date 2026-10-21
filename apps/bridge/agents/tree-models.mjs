// A tree uses the control checkout's role configuration, never a caller's model or a target project's recipe.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { MODEL_MAP, EFFORT_MAP } from "../../../scripts/codex-sync.mjs";
import { ROLES } from "./policy.mjs";

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
};

function trustedFile(root, relative) {
  const file = realpathSync(path.join(root, relative));
  if (!inside(root, file)) throw new Error("the tree role recipe leaves the control checkout");
  return readFileSync(file, "utf8");
}

function field(text, key, pattern) {
  const matches = [...text.matchAll(new RegExp(`^${key}${pattern}$`, "gm"))];
  if (matches.length !== 1) throw new Error(`the tree role must configure exactly one ${key}`);
  return matches[0][1];
}

/** Read both authoritative Claude front matter and its generated Codex mapping; drift refuses either runtime. */
export function resolveTreeRole({ controlRoot, role, runtime }) {
  if (!(ROLES.includes(role) || role === "runner")) throw new Error("unknown tree role");
  if (runtime !== "claude" && runtime !== "codex") throw new Error("unknown tree runtime");
  const root = realpathSync(controlRoot);
  const source = trustedFile(root, `.claude/agents/${role}.md`);
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
  if (!front) throw new Error("the tree role has no Claude front matter");
  const name = field(front, "name", ":\\s*([a-z-]+)\\s*");
  const tier = field(front, "model", ":\\s*([a-z]+)\\s*");
  const effort = field(front, "effort", ":\\s*([a-z]+)\\s*");
  const tools = field(front, "tools", ":([^\\r\\n]+)");
  const delegateRoles = /(?:^|,\s*)Agent\(([^)]*)\)/.exec(tools)?.[1].split(",").map((s) => s.trim()) ?? [];
  if (delegateRoles.some((child) => !ROLES.includes(child) && child !== "runner")) throw new Error("the tree role names an unknown delegated role");
  if (name !== role || !Object.hasOwn(MODEL_MAP, tier) || !Object.hasOwn(EFFORT_MAP, effort)) throw new Error("the tree role has an unsupported model or effort");
  const mirror = trustedFile(root, `.codex/agents/${role}.toml`).split(/^developer_instructions\s*=/m)[0];
  const codexName = field(mirror, "name", '\\s*=\\s*"([^"\\r\\n]+)"\\s*');
  const codexModel = field(mirror, "model", '\\s*=\\s*"([^"\\r\\n]+)"\\s*');
  const codexEffort = field(mirror, "model_reasoning_effort", '\\s*=\\s*"([^"\\r\\n]+)"\\s*');
  if (codexName !== role || codexModel !== MODEL_MAP[tier] || codexEffort !== EFFORT_MAP[effort]) throw new Error("the tree role's Codex model mapping has drifted; regenerate the mirrors");
  return { ...(runtime === "claude" ? { model: tier, effort } : { model: codexModel, effort: codexEffort }), canDelegate: delegateRoles.length > 0, delegateRoles };
}

/** The adapter must opt into host-controlled delegation and explicitly accept this configured selection. */
export async function assertTreeRuntimeModel(adapter, selection) {
  if (adapter?.capabilities?.treeDelegation !== true || typeof adapter.validateModel !== "function") throw new Error("this runtime cannot enforce host-controlled tree delegation and model selection");
  if (await adapter.validateModel(selection) !== true) throw new Error("the configured tree model or effort is unavailable in this runtime");
}
