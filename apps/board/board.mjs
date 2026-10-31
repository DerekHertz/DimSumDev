#!/usr/bin/env node
// organism-infra/02: `board` — thin CLI adapter over ./board-service.mjs.
// See docs/adr/0008-board-service.md for the command set and locking design.
import {
  resolveRoot,
  resolveShortRef,
  claim,
  release,
  resolve,
  setOffRelay,
  reclaim,
  getStatus,
  comment,
  publishHandoff,
  handoffTemplate,
  list,
  createTicket,
  appendUsageLine,
  checkArgLength,
  BoardError,
} from "./board-service.mjs";
import { readFile } from "node:fs/promises";
import { audit } from "./board-audit.mjs";
import { normalizeLegacyFlags } from "./legacy-terms.mjs";
import { loadSnapshot, buildQueue, formatQueue, gateRefusals, gateReason } from "./frontier-queue.mjs";

// organism-infra/18: `allowed` declares a subcommand's flag set; any other
// `--flag` is a hard error naming the bad flag, never silently absorbed as
// positional/text content. `boolean` flags (e.g. `--force`) take no value.
function parseFlags(args, { allowed = null, boolean = [] } = {}) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (allowed && !allowed.includes(name)) {
        throw new BoardError(`unrecognized flag: --${name}`);
      }
      if (boolean.includes(name)) {
        flags[name] = true;
      } else {
        // organism-infra/18 fix-1 (security low finding): a flag value can
        // never start with "--" -- otherwise `--reason --force` silently
        // swallows `--force` as the literal reason text instead of erroring.
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new BoardError(`--${name} requires a value`);
        }
        flags[name] = value;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function main() {
  // ADR 0028: the old `--cell` spelling still works, with a deprecation line.
  const [command, ...rest] = normalizeLegacyFlags(process.argv.slice(2), "board");
  const root = resolveRoot(process.cwd(), process.env);
  // organism-infra/126: <feature>/<NN> resolves to the full slug ref (undefined passes through).
  const full = (r) => (r === undefined ? r : resolveShortRef(root, r));

  switch (command) {
    case "claim": {
      // organism-infra/217: `--role <role>` (formerly `--cell`) is the flag form of the
      // positional role; any other flag is refused with the usage line.
      const claimUsage = "usage: board claim <ref> <role> [--mode <mode>]  (or: board claim <ref> --role <role> [--mode <mode>])";
      let parsed;
      try {
        parsed = parseFlags(rest, { allowed: ["mode", "role"] });
      } catch (err) {
        if (err instanceof BoardError) throw new BoardError(`${err.message}\n${claimUsage}`);
        throw err;
      }
      const { positional, flags } = parsed;
      const [rawRef, positionalRole] = positional;
      if (positionalRole !== undefined && flags.role !== undefined && positionalRole !== flags.role) {
        throw new BoardError(
          `conflicting roles: positional "${positionalRole}" vs --role "${flags.role}"\n${claimUsage}`
        );
      }
      const role = positionalRole ?? flags.role;
      const ref = full(rawRef);
      const result = await claim(root, ref, role, { mode: flags.mode });
      console.log(`claimed ${ref}: ${result.status}`);
      return;
    }
    case "reclaim": {
      const { positional, flags } = parseFlags(rest, { allowed: ["mode", "reason"] });
      const [rawRef, role] = positional;
      const ref = full(rawRef);
      const result = await reclaim(root, ref, role, { mode: flags.mode, reason: flags.reason });
      console.log(`reclaimed ${ref} for ${role}: ${result.status}`);
      return;
    }
    case "release": {
      if (rest.some((a) => a === "--verdict" || a.startsWith("--verdict="))) {
        throw new BoardError(
          'release takes no --verdict; record the verdict first with `board comment <ref> --verdict pass|bounce "<text>"`, then release'
        );
      }
      const { positional, flags } = parseFlags(rest, {
        allowed: ["status", "reason", "force", "keep-status", "pr"],
        boolean: ["force", "keep-status"],
      });
      const ref = full(positional[0]);
      const result = await release(root, ref, flags.status, flags.reason, {
        force: !!flags.force,
        keepStatus: !!flags["keep-status"],
        pr: flags.pr,
        pushFrom: process.cwd(), // organism-infra/158: release pushes the agent's branch
      });
      console.log(`released ${ref}: ${result.status}`);
      return;
    }
    case "resolve": {
      // organism-infra/98: claim, orchestrator handoff and resolved release in one step.
      const { positional, flags } = parseFlags(rest, { allowed: ["pr", "note"] });
      const result = await resolve(root, positional.map(full), { pr: flags.pr, note: flags.note });
      for (const ref of result.resolved) console.log(`resolved ${ref}`);
      return;
    }
    case "file": {
      // portable-den/11: file a ticket found while working on another one, with its `Discovered from` link set.
      const { positional, flags } = parseFlags(rest, {
        allowed: ["discovered-from", "title", "text", "ticket-file", "priority", "source", "class", "serves", "goal", "status", "type"],
      });
      const [feature, slug] = positional;
      if (positional.length !== 2 || flags["discovered-from"] === undefined || flags.title === undefined || (flags.text === undefined) === (flags["ticket-file"] === undefined)) {
        throw new BoardError('usage: board file <feature> <slug> --discovered-from <ref> --title "<t>" (--text "<request>" | --ticket-file <file with ## Acceptance criteria>) [--priority P2] [--source <s>] [--class product|pipeline] [--serves "<form>"] [--goal <g>] [--status ready-for-agent|ready-for-human] [--type <t>]');
      }
      const drafted = flags["ticket-file"] !== undefined;
      const made = await createTicket(root, {
        feature, slug, title: flags.title,
        text: drafted ? await readFile(flags["ticket-file"], "utf8") : flags.text,
        form: drafted ? "ticket" : "request",
        discoveredFrom: full(flags["discovered-from"]),
        priority: flags.priority, source: flags.source, class: flags.class, serves: flags.serves, goal: flags.goal,
        status: flags.status, type: flags.type,
      });
      console.log(`filed ${made.ref}`);
      return;
    }
    case "park":
    case "close":
    case "unpark":
    case "reopen": {
      // Refocus 2026-10-02: take tickets off the relay (or bring one back) in one step.
      const { positional, flags } = parseFlags(rest, { allowed: ["reason"] });
      const result = await setOffRelay(root, positional.map(full), command, { reason: flags.reason });
      for (const ref of result.done) console.log(`${result.status} ${ref}`);
      return;
    }
    case "handoff": {
      const { positional, flags } = parseFlags(rest, {
        allowed: ["from", "name", "template", "role", "mode"],
        boolean: ["template"],
      });
      const ref = full(positional[0]);
      if (flags.template) {
        if (flags.from !== undefined || flags.name !== undefined) {
          throw new BoardError("--template prints a State block; it takes no --from or --name");
        }
        console.log(`State block for ${ref} (fill in the placeholders, then draft the handoff under /tmp):`);
        console.log(await handoffTemplate(root, ref, { role: flags.role, mode: flags.mode }));
        return;
      }
      if (flags.role !== undefined || flags.mode !== undefined) {
        throw new BoardError("--role and --mode only apply with --template");
      }
      const result = await publishHandoff(root, ref, flags.from, { name: flags.name });
      console.log(`published ${result.path}`);
      return;
    }
    case "status": {
      const { positional } = parseFlags(rest, { allowed: [] });
      const ref = full(positional[0]);
      const status = await getStatus(root, ref);
      console.log(status);
      return;
    }
    case "comment": {
      // Only `--as` is a flag on comment; any other "--x" is rejected.
      const { positional, flags } = parseFlags(rest, { allowed: ["as", "verdict"] });
      const [rawRef, text] = positional;
      const ref = full(rawRef);
      await comment(root, ref, text, { as: flags.as, verdict: flags.verdict });
      console.log(`commented on ${ref}`);
      return;
    }
    case "list": {
      const { flags } = parseFlags(rest, { allowed: ["feature", "status"] });
      const results = await list(root, { feature: flags.feature, status: flags.status });
      for (const r of results) {
        console.log(`${r.feature}/${r.ticket}\t${r.status ?? ""}`);
      }
      return;
    }
    case "audit": {
      // organism-infra/81: exit 0 clean, 1 findings, 2 bad arguments.
      const usage = (msg) => Object.assign(new BoardError(msg), { exitCode: 2 });
      let parsed;
      try {
        parsed = parseFlags(rest, { allowed: ["json", "stale-days", "feature"], boolean: ["json"] });
      } catch (err) {
        throw usage(err.message);
      }
      const { positional, flags } = parsed;
      if (positional.length) throw usage(`audit takes no arguments: ${positional.join(" ")}`);
      const staleDays = flags["stale-days"] ?? "7";
      if (!/^\d+$/.test(staleDays)) throw usage(`--stale-days must be a whole number of days: ${staleDays}`);
      if (flags.feature !== undefined && !/^[a-z0-9-]+$/.test(flags.feature)) {
        throw usage(`invalid feature: ${flags.feature}`);
      }
      const findings = await audit(root, { staleDays: Number(staleDays), feature: flags.feature });
      if (flags.json) console.log(JSON.stringify(findings, null, 2));
      else for (const f of findings) console.log(`${f.ref} ${f.kind} ${f.detail}`);
      process.exitCode = findings.length ? 1 : 0;
      return;
    }
    case "queue": {
      // queue/02: the frontier in its computed order, read only (ADR 0015 Amendment 3).
      const { positional } = parseFlags(rest, { allowed: [] });
      if (positional.length) throw new BoardError(`queue takes no arguments: ${positional.join(" ")}`);
      const snapshot = await loadSnapshot(root);
      console.log(formatQueue(buildQueue(snapshot), snapshot));
      return;
    }
    case "pick": {
      // queue/05: record that the user chose this ticket. Resets its decay count (ADR 0015 Amendment 3 decisions 9, 14).
      const { positional, flags } = parseFlags(rest, { allowed: ["deviation"] });
      if (positional.length !== 1) throw new BoardError('usage: board pick <ref> [--deviation "<why>"]');
      const ref = full(positional[0]);
      checkArgLength(flags.deviation, "deviation");
      await getStatus(root, ref); // throws "ticket not found" for an unknown ref
      const top = buildQueue(await loadSnapshot(root)).ordered[0]?.ref ?? null;
      const row = { kind: "queue-pick", ts: new Date().toISOString(), top, picked: ref };
      if (flags.deviation !== undefined) row.deviation = flags.deviation;
      await appendUsageLine(root, JSON.stringify(row) + "\n");
      console.log(`picked ${ref}`);
      return;
    }
    case "gate": {
      // queue/03: the admission gate (ADR 0015 Amendment 3). A dry run lists the ready tickets it would park (refused by the gate, or decayed) and writes
      // nothing; `--apply` parks each one with its reason through the park path.
      const { positional, flags } = parseFlags(rest, { allowed: ["apply"], boolean: ["apply"] });
      if (positional.length) throw new BoardError(`gate takes no arguments: ${positional.join(" ")}`);
      const refused = gateRefusals(await loadSnapshot(root));
      if (!refused.length) {
        console.log("Nothing to park: every ready ticket passes the admission gate and none has decayed.");
        return;
      }
      if (!flags.apply) {
        console.log(`Would park ${refused.length} ticket${refused.length === 1 ? "" : "s"} (dry run; pass --apply to park):`);
        for (const r of refused) console.log(`  ${r.ref}: ${r.reasons.join("; ")}`);
        return;
      }
      let failed = 0;
      for (const r of refused) {
        try {
          await setOffRelay(root, [r.ref], "park", { reason: gateReason(r.reasons) });
          console.log(`parked ${r.ref}: ${r.reasons.join("; ")}`);
        } catch (err) {
          if (!(err instanceof BoardError)) throw err;
          // A ticket claimed since the listing stays as it is; the rest are still parked.
          failed += 1;
          console.error(`board: not parked ${r.ref}: ${err.message}`);
        }
      }
      if (failed) process.exitCode = 1;
      return;
    }
    default:
      throw new BoardError(`unknown command: ${command}`);
  }
}

main().catch((err) => {
  if (err instanceof BoardError) {
    console.error(`board: ${err.message}`);
  } else {
    console.error(`board: unexpected error: ${err.stack || err}`);
  }
  // 75 (EX_TEMPFAIL) when the write lock stayed held for the whole bounded
  // wait, so callers can tell "retry later" from a real error (1).
  process.exitCode = err instanceof BoardError && err.exitCode ? err.exitCode : 1;
});
