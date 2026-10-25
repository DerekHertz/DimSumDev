// trust-ladder/02: `npm run verify:ui -- --flow <flow.json>` drives the app in a real browser like a person would and returns the
// evidence: screenshots, console and page errors, failed requests and a perf trace, plus findings with steps to reproduce.
//   --flow <file>     the flow to run (required); see verifier.mjs for the step kinds
//   --den             serve the built den on a fixture board (builds the UI first; --skip-build reuses the last build)
//   --url <base>      drive an already-running server instead of starting one (e.g. one a container can reach)
//   --root <dir>      the directory the dev server serves (default: the repo)
//   --out <dir>       where the report and evidence go (default: .verify/<flow>-<run id>)
//   --timeout <ms>    cap for the whole run (default 120000); past it the run is a `timeout` finding and everything is closed
//   --json            print the report as JSON on stdout
// Exit 0: no findings. Exit 1: findings. Exit 2: bad arguments, a bad flow or no browser.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BrowserMissingError, FlowError, runVerifier } from "./verifier.mjs";

const FLAGS = { "--flow": "flow", "--out": "out", "--timeout": "timeout", "--url": "url", "--root": "root" };
const SWITCHES = { "--den": "den", "--skip-build": "skipBuild", "--json": "json" };

function usageError(message) {
  console.error(`verify-ui: ${message}\nusage: npm run verify:ui -- --flow <flow.json> [--den | --url <base> | --root <dir>] [--out <dir>] [--timeout <ms>] [--json]`);
  return 2;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (SWITCHES[argv[i]]) opts[SWITCHES[argv[i]]] = true;
    else if (FLAGS[argv[i]] && argv[i + 1] !== undefined) opts[FLAGS[argv[i]]] = argv[++i];
    else throw new FlowError(`unknown or incomplete argument ${argv[i]}`);
  }
  if (!opts.flow) throw new FlowError("--flow is required");
  if (opts.timeout !== undefined && !(Number(opts.timeout) > 0)) throw new FlowError("--timeout must be a number of milliseconds");
  return opts;
}

function summary(report) {
  const lines = [`verify-ui: ${report.flow} ${report.ok ? "PASS" : "FAIL"}, ${report.findings.length} finding(s) in ${(report.durationMs / 1000).toFixed(1)} s (${report.url})`];
  for (const f of report.findings) lines.push(`  ${f.kind}: ${f.message}`, ...f.reproduce.map((r) => `    ${r}`));
  for (const s of report.screenshots) lines.push(`screenshot ${s.name}: ${s.path}`);
  lines.push(`perf: load ${report.perf.loadMs ?? "n/a"} ms, trace ${report.perf.tracePath ?? "n/a"}`, `report: ${report.outDir}/report.json`);
  return lines.join("\n");
}

async function main() {
  let opts;
  let flow;
  try {
    opts = parseArgs(process.argv.slice(2));
    flow = JSON.parse(await readFile(opts.flow, "utf8"));
  } catch (err) {
    return usageError(err instanceof SyntaxError ? `${opts?.flow} is not JSON: ${err.message}` : err.code === "ENOENT" ? `cannot read the flow ${opts?.flow}` : err.message);
  }
  try {
    const report = await runVerifier({
      flow, root: opts.root, url: opts.url, den: opts.den, skipBuild: opts.skipBuild, outDir: opts.out, timeoutMs: opts.timeout && Number(opts.timeout),
    });
    console.log(opts.json ? JSON.stringify(report, null, 2) : summary(report));
    return report.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof FlowError || err instanceof BrowserMissingError) return usageError(err.message);
    throw err;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err.stack ?? String(err));
    process.exit(2);
  });
}
