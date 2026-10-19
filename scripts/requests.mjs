// Orchestrator-facing Gate requests (ADR 0011 decision 6).
//   node scripts/requests.mjs --list
//   node scripts/requests.mjs --handle <id> --outcome <text>
// Root comes from DEN_ROOT (fallback cwd). Nothing executes; --handle appends one line.
import { readRequestRows, foldRequests, appendRequestLine } from "../apps/bridge/requests-log.mjs";

const args = process.argv.slice(2);
const root = process.env.DEN_ROOT || process.env.ORGANISM_ROOT || process.cwd();
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`requests: ${msg}`);
  process.exit(1);
};

if (args.includes("--list")) {
  const pending = foldRequests(await readRequestRows(root)).filter((r) => r.state === "pending");
  for (const r of pending) console.log(`${r.id}  ${r.kind}  ${r.ref}${r.note ? `  # ${r.note}` : ""}`);
} else if (args.includes("--handle")) {
  const id = value("--handle");
  const outcome = value("--outcome");
  if (!id || id.startsWith("--")) fail("--handle needs a request id");
  if (!outcome || outcome.startsWith("--")) fail("--handle needs --outcome <text>");
  const req = foldRequests(await readRequestRows(root)).find((r) => r.id === id);
  if (!req) fail(`no request with id ${id}`);
  if (req.state !== "pending") fail(`request ${id} is already handled`);
  await appendRequestLine(root, { handled: id, ts: new Date().toISOString(), outcome });
  console.log(`handled ${id}: ${outcome}`);
} else {
  fail("usage: requests.mjs --list | --handle <id> --outcome <text>");
}
