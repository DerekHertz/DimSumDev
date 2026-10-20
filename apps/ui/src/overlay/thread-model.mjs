// den-mvp outcome 2 (and the signed-off organism-infra/230 spec): pure models for the conversation thread. The thread
// is one role's conversation as the user reads it: what the agent said, what it asked (the reason first, the command
// under it), the user's answers, notes, messages and stops, and a receipt under each of the user's entries.
// Nothing here mutates its input, touches the network or throws on a bad entry.
//
// A receipt says what was sent and what the agent did next. It never says the agent read or saw anything: the bridge
// knows that a message was taken and an answer delivered, not what the agent made of it.
import { transcriptView } from "./transcript-view.mjs";
import { sourceKey, sameSource } from "../../../shared/transcript-source.mjs";

const SAYS_MAX = 500;
const INTENT_MAX = 200;
const NEXT_SAID_MAX = 60;
export const NO_REPLY_MS = 30_000; // after an answer was sent with nothing from the agent since
export const STILL_STOPPING_MS = 10_000; // after a stop was sent with the agent not yet ended
export const NO_REASON = "The agent didn't say why.";
const ENDED = ["done", "failed", "terminated"];

const str = (v) => (typeof v === "string" ? v : "");
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const shortRef = (ref) => (typeof ref === "string" ? ref.slice(ref.indexOf("/") + 1) : "");
const titled = (word) => (word ? word[0].toUpperCase() + word.slice(1) : "Agent");

const VERBS = {
  Bash: ["run a command", "Command"], Write: ["change a file", "File"], Edit: ["change a file", "File"], Read: ["read a file", "File"],
  Glob: ["search files", "Query"], Grep: ["search files", "Query"], WebFetch: ["open a web page", "Query"], WebSearch: ["search the web", "Query"],
  AskUserQuestion: ["ask you", "Question"],
};
/** What a tool's request asks to do, in plain words: "run a command", or "use <tool>" for a tool not listed. */
export function toolVerb(tool) {
  const name = str(tool).trim();
  return Object.hasOwn(VERBS, name) ? VERBS[name][0] : `use ${name || "a tool"}`;
}
/** The label of the request's detail row: Command, File or Query. */
export const detailLabel = (tool) => (Object.hasOwn(VERBS, str(tool).trim()) ? VERBS[str(tool).trim()][1] : "Request");

/**
 * Why the agent is asking. Its own words win; the tool's description stands in when it said nothing; with neither,
 * the fallback line. -> { text, fallback }
 */
export function reasonText({ says, intent } = {}) {
  const said = str(says).trim();
  if (said) return { text: clip(said, SAYS_MAX), fallback: false };
  const meant = str(intent).trim();
  if (meant) return { text: clip(meant, INTENT_MAX), fallback: false };
  return { text: NO_REASON, fallback: true };
}

function expiresIn(expiresAt, nowMs) {
  const left = Date.parse(expiresAt ?? "") - nowMs;
  if (!Number.isFinite(left) || left <= 0) return null;
  const minutes = Math.ceil(left / 60_000);
  return minutes <= 1 ? "expires in under a minute" : `expires in ${minutes} min`;
}

/**
 * One list for the thread: the role's earlier runs from the history pages (other runs only, or this run too when the
 * page holds no live buffer for it, as after a bridge restart), then this run's live entries. Each entry gets a
 * stable number `n`: a live entry its own id, a history entry its distance from the end as a negative number, so
 * loading an earlier page renumbers nothing.
 */
export function threadEntries({ history, buffer, agentId } = {}) {
  const live = Array.isArray(buffer?.entries) ? buffer.entries : null;
  const past = [];
  const sources = new Map();
  for (const e of Array.isArray(history) ? history : []) {
    if (!e || typeof e !== "object") continue;
    const key = sourceKey(e.source);
    if (live?.some(row => key ? sameSource(e.source, row.source) : e.runId === agentId && row.id === e.id)) continue;
    const at = key ? sources.get(key) : undefined;
    if (at !== undefined && past[at].kind === e.kind) {
      const previous = past[at];
      if (e.kind !== "tool" || previous.status === "running" || e.status !== "running") past[at] = { ...previous, ...e };
    } else {
      if (key) sources.set(key, past.length);
      past.push(e);
    }
  }
  const entries = [
    ...past.map((e, i) => ({ ...e, n: i - past.length })),
    ...(live ?? []).map((e, i) => ({ ...e, runId: agentId, n: Number.isFinite(e?.n) ? e.n : Number.isInteger(e?.id) ? e.id : i + 1 })),
  ];
  return { entries, dropped: live && past.length === 0 && buffer.dropped > 0 ? buffer.dropped : 0 };
}

const chip = (state, text) => ({ state, text }); // state: done | pending | muted | failed

// What the agent did after entry `i`, read from the same run's later entries: the first tool, words or end.
function nextStep(entries, i) {
  for (let j = i + 1; j < entries.length; j += 1) {
    const e = entries[j];
    if (!e || e.runId !== entries[i].runId) break;
    if (e.kind === "tool") return chip("done", `Agent next: ran ${str(e.name) || "a tool"}`);
    if (e.kind === "message" && e.role !== "user") return chip("done", `Agent next: said ${clip(str(e.text).replace(/\s+/g, " ").trim(), NEXT_SAID_MAX)}`);
    if (e.kind === "ended") return chip("done", `Agent ended: ${str(e.state)}`);
  }
  return null;
}
const endedAfter = (entries, i) => entries.slice(i + 1).find((e) => e?.runId === entries[i].runId && e.kind === "ended") ?? null;

const MESSAGE_CHIPS = { queued: chip("pending", "Queued"), applied: chip("done", "Received"), undelivered: chip("failed", "Not delivered") };

function askRow(entry, n, approval, { nowMs, live }) {
  const verb = toolVerb(entry.name);
  const pending = entry.status === "pending" && approval?.id && (approval.status ?? approval.state ?? "pending") === "pending";
  // den-mvp/37: an agent's question shows its options and is answered in the thread, not through Allow/Deny.
  if (pending && Array.isArray(approval.questions) && approval.questions.length) {
    return {
      kind: "question", n, at: entry.at, approvalId: approval.id, questions: approval.questions, answerable: live,
      head: ["Asking you", "waiting on you", expiresIn(approval.expiresAt, nowMs)].filter(Boolean).join(" · "),
    };
  }
  if (pending) {
    const reason = reasonText(approval);
    const intent = str(approval.intent).trim();
    return {
      kind: "ask", n, at: entry.at, verb, approvalId: approval.id,
      head: ["Asking to " + verb, "waiting on you", expiresIn(approval.expiresAt, nowMs)].filter(Boolean).join(" · "),
      reason: reason.text, reasonFallback: reason.fallback,
      intent: intent && clip(intent, INTENT_MAX) !== reason.text ? clip(intent, INTENT_MAX) : null,
      detailLabel: detailLabel(entry.name), command: str(approval.summary), answerable: live,
    };
  }
  if (entry.status === "allowed" || entry.status === "denied") {
    const denied = entry.status === "denied";
    const note = str(entry.note).trim();
    if (entry.name === "AskUserQuestion") return { kind: "answer", n, at: entry.answeredAt ?? entry.at, asked: "Asked you · answered", text: denied ? "Dismissed." : note || "Answered.", note: denied ? note || null : null, denied };
    return { kind: "answer", n, at: entry.answeredAt ?? entry.at, asked: `Asked to ${verb} · answered`, text: denied ? "Denied." : "Allowed.", note: note || null, denied };
  }
  // Expired, or still pending with no approval to show (a reloaded page, an approval the bridge no longer holds).
  return { kind: "asked", n, at: entry.at, label: entry.status === "expired" ? `Asked to ${verb} · expired: denied` : `Asked to ${verb} · waiting on you`, waiting: entry.status !== "expired" };
}

/**
 * den-mvp/37: the form under an agent's question. `picks` holds, per question, { labels, other } where `other` is null
 * until "Other" is chosen. Choosing in a single-select question replaces the pick; in a multiSelect it toggles.
 *   pickOption(questions, picks, qi, label | null)   null picks "Other"
 *   questionAnswers(questions, picks) -> the answers to send (a string, or labels for a multiSelect), or null while any
 *     question is still unanswered
 */
export const emptyPicks = (questions) => questions.map(() => ({ labels: [], other: null }));
export function pickOption(questions, picks, qi, label) {
  const multi = questions[qi]?.multiSelect === true;
  return picks.map((p, i) => {
    if (i !== qi) return p;
    if (label === null) return multi ? { ...p, other: p.other === null ? "" : null } : { labels: [], other: p.other ?? "" };
    if (!multi) return { labels: [label], other: null };
    return { ...p, labels: p.labels.includes(label) ? p.labels.filter((l) => l !== label) : [...p.labels, label] };
  });
}
export const setOther = (picks, qi, text) => picks.map((p, i) => (i === qi ? { ...p, other: text } : p));
export function questionAnswers(questions, picks) {
  const out = [];
  for (const [i, q] of questions.entries()) {
    const p = picks[i] ?? { labels: [], other: null };
    const other = p.other?.trim() ?? "";
    const parts = [...p.labels, ...(other ? [other] : [])];
    if (!parts.length || (p.other !== null && !other)) return null;
    out.push(q.multiSelect ? parts : parts[0]);
  }
  return out;
}

/**
 * The thread's view model. `list` is threadEntries(); `ui` adds approvals, agents, now and the transcript panel's own
 * scroll and expand state. Rows keep arrival order, newest last.
 *   message  { speaker, text, at }                         the agent's words
 *   you      { text, at, chips }                           a typed message, or a stop
 *   answer   { asked, text, note, at, chips }              an ask the user answered
 *   ask      { head, reason, intent, command, ... }        an ask still waiting
 *   question { head, questions, approvalId, answerable }   an agent's question still waiting (den-mvp/37)
 *   asked    { label }                                     an ask that expired or cannot be answered from here
 *   tool, ended, run, unreadable
 */
export function threadView(list, ui = {}) {
  const entries = Array.isArray(list?.entries) ? list.entries : [];
  const base = transcriptView({ entries, dropped: list?.dropped ?? 0 }, ui);
  const nowMs = Number.isFinite(ui.now) ? ui.now : Date.now();
  const approvals = Array.isArray(ui.approvals) ? ui.approvals : [];
  const agents = Array.isArray(ui.agents) ? ui.agents : [];
  const liveRun = (runId) => { const a = agents.find((row) => row?.id === runId); return !!a && !ENDED.includes(a.state); };
  const rows = base.rows.map((row, i) => {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") return row;
    const n = row.n;
    if (entry.kind === "run") {
      const ref = shortRef(entry.ref);
      return { kind: "run", n, at: entry.at, label: [entry.resumeOf ? "Follow-up" : "Run started", ref].filter(Boolean).join(" · ") };
    }
    if (entry.kind === "stop") {
      const ended = endedAfter(entries, i);
      const chips = [chip("done", "Stop sent")];
      if (ended) chips.push(chip("done", "Agent ended"));
      else if (nowMs - Date.parse(entry.at ?? "") > STILL_STOPPING_MS) chips.push(chip("muted", "Still stopping…"));
      return { kind: "you", n, at: entry.at, text: "Stop", chips };
    }
    if (entry.kind === "message" && entry.role === "user") {
      const sent = Object.hasOwn(MESSAGE_CHIPS, str(entry.status)) ? [MESSAGE_CHIPS[entry.status]] : [];
      return { kind: "you", n, at: entry.at, text: str(entry.text), chips: sent };
    }
    if (entry.kind === "permission") {
      // The entry names its approval. One written before entries did is matched as it was then: the run's pending
      // request for the same tool.
      const isPending = (a) => (a.status ?? a.state ?? "pending") === "pending";
      const approval = approvals.find((a) => a?.id && a.id === entry.approvalId)
        ?? (entry.approvalId ? null : approvals.find((a) => a?.id && a.agentId === entry.runId && isPending(a) && a.tool === entry.name))
        ?? null;
      const ask = askRow(entry, n, approval, { nowMs, live: liveRun(entry.runId) });
      if (ask.kind !== "answer") return ask;
      const sent = chip("done", `Sent with your ${ask.denied ? (ask.note ? "denial and note" : "denial") : "answer"}`);
      const next = nextStep(entries, i) ?? (nowMs - Date.parse(ask.at ?? "") > NO_REPLY_MS ? chip("muted", "No reply yet") : null);
      return { ...ask, chips: next ? [sent, next] : [sent] };
    }
    if (entry.kind === "ended") {
      const stopped = entry.state === "terminated" && entries.slice(0, i).some((e) => e?.runId === entry.runId && e.kind === "stop");
      return { ...row, at: entry.at, label: stopped ? "Agent stopped by you" : row.label };
    }
    return row;
  });
  return { ...base, rows: rows.map((row, i) => {
    const source = entries[i]?.source;
    return { ...row, ...(sourceKey(source) ? { source: { project: source.project, runtime: source.runtime, role: source.role, runId: source.runId, entryId: source.entryId } } : {}) };
  }), empty: rows.length === 0 };
}

/**
 * The foot of the thread: what the box and the two buttons do for this run right now.
 *   mode: "message" (a live run takes it), "follow-up" (an ended run whose session can be continued), "ended", "off"
 * `reason` is the visible text for a disabled foot. Stop is shown for a live run only, and works when `canStop`.
 */
export function footModel({ agent, connection, signedIn = true, demo = false, desk = false } = {}) {
  const live = !!agent && !ENDED.includes(agent.state);
  // A live run always shows Stop; where it cannot be used it is disabled, with the reason beside it.
  const base = { mode: "off", canSend: false, canStop: false, stopShown: live, placeholder: "", sendLabel: "Send", reason: null, readOnly: true };
  if (demo) return { ...base, reason: "Demo mode: actions are off" };
  if (connection?.phase === "offline") return { ...base, reason: "Bridge offline: run npm run ui" };
  if (!signedIn) return { ...base, reason: "Couldn't send: not signed in to steer" };
  // den-mvp/30: Bao's desk with no run yet: the first message starts one.
  if (!agent && desk) return { ...base, mode: "desk", canSend: true, readOnly: false, placeholder: "Message Bao" };
  if (!agent) return { ...base, reason: "The agent ended." };
  const name = titled(str(agent.role));
  if (live) {
    const send = agent.capabilities?.send === true;
    return {
      ...base, mode: "message", canSend: send, canStop: agent.capabilities?.stop === true, readOnly: !send,
      placeholder: send ? `Message ${name}` : "", reason: send ? null : "This agent's runtime cannot take a message.",
    };
  }
  if (agent.followUp === true) return { ...base, mode: "follow-up", canSend: true, readOnly: false, placeholder: `Follow up with ${name}`, sendLabel: "Follow up", reason: "The run ended. A follow-up continues its session." };
  return { ...base, mode: "ended", reason: "The agent ended." };
}

/**
 * The stop control's own steps, before and beside the thread's stop entry.
 *   phase: idle | confirm | sending | sent | failed     error: { status, reason } from the client
 * -> { confirm, busy, chip, alert, announce }
 */
export function stopModel({ phase = "idle", error = null, agent = null } = {}) {
  const out = { confirm: phase === "confirm", busy: phase === "sending", chip: null, alert: null, announce: "" };
  if (phase === "sending") return { ...out, chip: chip("pending", "Stopping…") };
  if (phase === "sent") return { ...out, announce: agent && agent.state === "terminated" ? "Agent ended" : "Stop sent" };
  if (phase === "failed" && error) {
    if (error.status === 409) return { ...out, chip: chip("muted", `Already ended: ${str(agent?.state) || "ended"}`) };
    return { ...out, alert: `Couldn't stop: ${error.status || ""} ${str(error.reason)}`.replace(/\s+/g, " ").trim() };
  }
  return out;
}
