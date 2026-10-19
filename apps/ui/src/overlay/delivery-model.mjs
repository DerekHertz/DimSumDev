// den-mvp outcome 3: the pure pieces behind a delivery in the den. No DOM, no fetch; Cards.jsx renders what these return.
// A delivery is the bridge's job that takes one ticket from a developer to a merged pull request. The words here say what
// the bridge recorded (a verdict, a check, a merge); none claims more than that.
import { DELIVERABLE_TYPES } from "../../../bridge/delivery/types.mjs";
import { rolledBackNote, shortSha } from "./build-model.mjs";

const LIVE = new Set(["running", "paused"]);
const shortRef = (ref) => (typeof ref === "string" ? ref.slice(ref.indexOf("/") + 1) : "");
const list = (snapshot) => (Array.isArray(snapshot?.deliveries) ? snapshot.deliveries.filter((d) => d && typeof d.id === "string") : []);

/** The delivery of a ticket that is under way or waiting, or null. */
export const deliveryOf = (snapshot, ref) => list(snapshot).find((d) => d.ref === ref && LIVE.has(d.state)) ?? null;

/** Whether Deliver is offered for a ticket, and the line under it. First match wins. */
export function deliverState({ ticket, snapshot, steer, inflight } = {}) {
  if (!DELIVERABLE_TYPES.includes(ticket?.type)) return { show: false, enabled: false, reason: null };
  if (steer?.demo) return { show: true, enabled: false, reason: "Demo mode: actions are off" };
  if (steer?.state === "none") return { show: true, enabled: false, reason: "Couldn't send: not signed in to steer" };
  if (inflight) return { show: true, enabled: false, reason: "Starting…" };
  if (deliveryOf(snapshot, ticket.ref)) return { show: true, enabled: false, reason: "Being delivered" };
  return { show: true, enabled: true, reason: null };
}

const STEP_WORDS = { developer: "the developer is working", "code-reviewer": "the code reviewer is reading the commit", qa: "qa is verifying the commit", security: "security is reviewing the commit", check: "running the scripted checks", tests: "running the checks on this machine", preview: "building the preview", "go-live": "putting the change live", publish: "opening the pull request", ci: "waiting for the checks", merge: "merging", resolve: "closing the ticket" };

/** One line saying where a delivery stands. */
export function deliveryLine(d) {
  const pr = d?.pr?.number ? `#${d.pr.number}` : null;
  if (d?.state === "merged") return `Merged${pr ? ` as ${pr}` : ""}${d.release ? `, live as ${shortSha(d.release)}` : ""}`;
  if (d?.state === "closed") return "Closed, not merged";
  if (d?.state === "paused") return `Waiting: ${d.pause?.reason || "paused"}`;
  const words = STEP_WORDS[d?.step] ?? "starting";
  return `${words[0].toUpperCase()}${words.slice(1)}${pr && d.step !== "publish" ? ` (${pr})` : ""}`;
}

/** What the bridge has recorded for the commit under delivery, as short facts in the order they happen. */
export function deliveryFacts(d) {
  const e = d?.evidence ?? {};
  const out = [];
  if (d?.candidate?.sha) out.push(`commit ${d.candidate.sha.slice(0, 7)}`);
  if (e.review) out.push(`code review ${e.review}`);
  if (e.qa) out.push(`qa ${e.qa}`);
  if (e.risk) out.push(e.risk.clean ? "risk check clean" : `risk check: ${e.risk.hits} hit${e.risk.hits === 1 ? "" : "s"}`);
  if (e.tests) out.push(`checks here ${e.tests.state}`);
  if (e.security) out.push(`security ${e.security}`);
  if (e.ci) out.push(`GitHub checks ${e.ci}`);
  if (d?.bounces > 0) out.push(`sent back ${d.bounces} time${d.bounces === 1 ? "" : "s"}`);
  if (d?.declines > 0) out.push(`declined by you ${d.declines} time${d.declines === 1 ? "" : "s"}`);
  if (d?.verdict === "approved") out.push("approved by you");
  if (d?.release) out.push(`live as ${shortSha(d.release)}`);
  return out;
}

// den-mvp/34: what a result counts as when the two are compared. "skipped" and "error" say nothing about the code.
const SIDE = { green: "pass", flaky: "pass", red: "fail", timeout: "fail" };

/**
 * The local run of the checks beside GitHub's, for a delivery or a pull request card, or null when neither has a result.
 * here: a local result ({ state, reason, commands, differences, failed, flaky, record }) as the bridge recorded it;
 * github: GitHub's state for the same commit. A mismatch (one passes, the other fails) is called out with the facts of this
 * machine that differ from GitHub's runner, since that is where the cause usually is.
 */
export function checksView({ here = null, github = null } = {}) {
  if (!here && !github) return null;
  const a = SIDE[here?.state], b = SIDE[github];
  const mismatch = Boolean(a && b && a !== b);
  const textOf = (d) => (typeof d === "string" ? d : d && typeof d.fact === "string" ? `${d.fact}: ${d.here} here, ${d.github} on GitHub` : null);
  const names = (list) => (Array.isArray(list) ? list.map((f) => (typeof f === "string" ? f : f?.name ? `${f.job ? `${f.job}: ` : ""}${f.name}${f.location ? ` (${f.location})` : ""}` : null)).filter(Boolean) : []);
  return {
    here: here?.state ?? null, github: github ?? null, mismatch,
    summary: `Here: ${here?.state ?? "not run"} · GitHub: ${github ?? "no result"}${mismatch ? " · they disagree" : ""}`,
    reason: typeof here?.reason === "string" ? here.reason : null,
    commands: Array.isArray(here?.commands) ? here.commands.map((c) => (typeof c === "string" ? c : c?.command)).filter(Boolean) : [],
    differences: Array.isArray(here?.differences) ? here.differences.map(textOf).filter(Boolean) : [],
    failed: names(here?.failed), flaky: names(here?.flaky),
    record: typeof here?.record === "string" ? `.scratch/_run/checks/${here.record}` : here?.sha && here?.id ? `.scratch/_run/checks/${here.sha}/${here.id}` : null,
  };
}

/** A pull request link the page may render: an https URL the bridge recorded, or null. */
export const prLink = (d) => (typeof d?.pr?.url === "string" && /^https:\/\/[A-Za-z0-9.-]+\//.test(d.pr.url) ? d.pr.url : null);

/** A preview link the page may render: the bridge's own listener on this machine, or null. */
export const previewLink = (d) => (typeof d?.preview?.url === "string" && /^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(d.preview.url) ? d.preview.url : null);

// A pause after the merge says in its title that the merge is done.
const AFTER_MERGE = { "needs-update": "is merged; the den must be updated before it goes live", "go-live-failed": "is merged but did not go live" };

/** The rows of the Deliveries list: the ones under way first, then the newest ended. */
export function deliveryRows(snapshot, max = 6) {
  const all = list(snapshot);
  const rows = [...all.filter((d) => LIVE.has(d.state)), ...all.filter((d) => !LIVE.has(d.state)).reverse()].slice(0, max);
  return rows.map((d) => ({ id: d.id, ref: d.ref, short: shortRef(d.ref), title: d.title || shortRef(d.ref), state: d.state, line: deliveryLine(d), facts: deliveryFacts(d), pr: prLink(d), prNumber: d.pr?.number ?? null, canStop: d.state === "running", liveRunId: d.live?.runId ?? null, checks: checksView({ here: d.evidence?.tests ?? null, github: d.evidence?.ci ?? null }) }));
}

// A wait that ends by itself is not the user's to answer.
const SELF_ENDING = new Set(["no-room"]);

/** A waiting delivery as a Needs you request (the shape overlay-model.mjs lists). Bao coordinates, so it is Bao's card. */
export function deliveryRequests(snapshot) {
  return list(snapshot)
    .filter((d) => d.state === "paused" && !SELF_ENDING.has(d.pause?.kind))
    .map((d) => {
      const short = shortRef(d.ref);
      const visual = d.pause?.kind === "visual-verdict";
      const preview = visual && d.ui === true; // the verdict comes before the push, on a preview (ADR 0026 decision 5)
      return {
        key: `delivery:${d.id}`, kind: "delivery", id: d.id, ref: d.ref, short, role: "orchestrator", station: "pass",
        eyebrow: `Pass · Bao · ${short}`,
        title: preview ? `${short} waits for your verdict on its preview` : visual ? `${short} waits for your visual verdict` : AFTER_MERGE[d.pause?.kind] ? `${short} ${AFTER_MERGE[d.pause.kind]}` : `${short} delivery is waiting`,
        reason: d.pause?.reason || "The delivery is paused.", reasonFallback: false, plain: true, // the bridge's own words, not a quote
        next: d.pause?.next || "",
        rowText: `${short} · delivery`, preview: deliveryFacts(d), detailLabel: "What the bridge recorded",
        age: null, pr: prLink(d), prNumber: d.pr?.number ?? null,
        checks: checksView({ here: d.evidence?.tests ?? null, github: d.evidence?.ci ?? null }),
        primary: preview ? { action: "resume", verdict: "approve", label: "Approve: merge and go live" } : visual ? { action: "resume", verdict: "approve", label: "Approve and merge" } : { action: "resume", label: "Resume" },
        // den-mvp/12: what the card of a preview adds. A decline needs a note; it goes to the developer.
        decline: visual, previewUrl: preview ? previewLink(d) : null,
        // What the developer said to look at on the preview: plain lines, shown as text.
        lookAt: visual && Array.isArray(d.lookAt) ? d.lookAt.filter((s) => typeof s === "string" && s.trim()).slice(0, 6) : [],
        covers: preview ? "Approve covers the push, the pull request, the merge once the checks are green, and going live." : null,
        rolledBackNote: preview ? rolledBackNote(snapshot?.build) : null,
      };
    });
}
