// den-mvp outcome 4 (spec section 6, ADR 0017): the meeting runner. A meeting is a bounded consultation about one
// ticket: up to six specialists give one take each, one after another, then Bao chairs and writes a decision brief of
// two or three options with a recommendation. The user decides. The plan (plan.mjs) says what is next; this module
// does it, records it, and stops at the first thing that is the user's. Every run is started through the host's
// internal entry, so usage, enforcement, room and the wall apply to it as to any run: a take holds a worker slot, the
// chair holds Bao's. It holds no timer and polls nothing: it moves when a run ends or on the user's click.
//
// A brief authorizes nothing. Choosing an option writes a ticket at ready-for-human: proposed work, which is built
// only after the user approves it on the board. A take or a brief is an agent's text and is only ever shown and saved.
//
//   createMeetings({ host, store, log, readTicket, readUsage, proposeTicket, onChange, now }) -> {
//     ready, start({ ref | createTicket, title?, topic, roles }), resume(id), stop(id), close(id),
//     decide(id, { option }), ask(id, { text, reask? }), read(id), onEnd(run), shutdown(), snapshot()
//   }
// The route answers are { ok: true, status, meeting, ... } or { ok: false, status, error }.
import { randomBytes } from "node:crypto";
import { hasSecret } from "../../../scripts/exposure.mjs";
import { REF_RE, USAGE_REFUSE_AT } from "../agents/policy.mjs";
import { MEETING_ID_RE } from "./log.mjs";
import { nextStep, optionText, parseBrief, readDecline } from "./plan.mjs";
import { meetingNote } from "./prompts.mjs";
import { CHAIR, REJOIN_MS, SEATS_MAX, SPECIALISTS, TOPIC_MAX_BYTES } from "./types.mjs";

const KEPT = 30; // meetings kept in the snapshot
const NOTE_THREAD = 6; // follow-up entries the chair is given; older ones stay on the board
const refuse = (status, error) => ({ ok: false, status, error });
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g;
const errorText = (err) => {
  const text = String(err?.message || err).replace(CONTROL_RE, " ").trim().slice(0, 300);
  return hasSecret(text) ? "[masked: possible secret]" : text;
};
// An agent's text as the den shows it: a possible secret is not sent to the page.
const shown = (text) => (typeof text !== "string" ? null : hasSecret(text) ? "[masked: possible secret]" : text);

export function createMeetings({ host, store, log, readTicket, readUsage = async () => null, proposeTicket, onChange = () => {}, now = () => Date.now() }) {
  const meetings = new Map(); // id -> meeting; insertion order is snapshot order
  let closing = false;

  const resting = (m) => m.state === "briefed" || m.state === "decided" || m.state === "closed";
  const live = (m) => m.state === "running" || m.state === "paused";
  const rejoinUntil = (m) => (!m.retired && (m.state === "decided" || m.state === "closed") && m.restedAt ? new Date(Date.parse(m.restedAt) + REJOIN_MS).toISOString() : null);
  const view = (m) => ({
    id: m.id, ref: m.ref, dir: m.dir, title: m.title, state: m.state, pause: m.pause, chair: m.chair,
    seats: m.seats.map((s) => ({ role: s.role, status: s.status, takes: s.takes, reason: s.reason ?? null })),
    round: m.round, brief: m.brief ? { version: m.brief.version, options: m.brief.options.map((o) => ({ ...o })), recommended: m.brief.recommended } : null,
    decisions: m.decisions.map((d) => ({ ...d })), thread: m.thread, live: m.live ? { ...m.live } : null, runs: m.runs.length,
    retired: m.retired, rejoinUntil: rejoinUntil(m), startedAt: m.startedAt, updatedAt: m.updatedAt,
  });
  async function save(m) {
    m.updatedAt = new Date(now()).toISOString();
    onChange({ type: "meeting", meeting: view(m) });
    await log.save(m).catch((err) => console.error(`bridge: could not write the meetings log: ${err?.message ?? err}`));
    if (!m.retired) await store.writeMeeting(m).catch((err) => console.error(`bridge: could not write meeting.md for ${m.id}: ${err?.message ?? err}`));
  }
  function trim() {
    for (const [id, m] of meetings) {
      if (meetings.size <= KEPT) return;
      if (m.retired || m.state === "closed") meetings.delete(id);
    }
  }
  // One thing at a time per meeting: an end, a resume and the plan never interleave.
  const enqueue = (m, fn) => {
    const run = (m.chain ?? Promise.resolve()).then(fn).catch((err) => {
      console.error(`bridge: meeting ${m.id} failed: ${err?.stack ?? err}`);
      return pause(m, "environment", `the bridge hit an error: ${errorText(err)}`, "Resume to try again.");
    });
    m.chain = run.catch(() => {});
    return run;
  };
  async function pause(m, kind, reason, next) {
    if (m.state !== "running") return;
    m.state = "paused";
    m.pause = { kind, reason, next };
    await save(m);
  }

  // 24 hours past a decision or a close, only the decision and a summary are kept (ADR 0017 decision 11).
  const summaryOf = (m) =>
    [
      `# Summary: ${m.title.replace(/^Meeting:\s*/, "")}`, "",
      `Meeting ${m.dir} about ${m.ref}, started ${m.startedAt}. Written by the den's bridge when the meeting was 24 hours past its end; the takes and the follow-ups were deleted then.`, "",
      "## The topic (the user's words)", "", ...m.topic.replace(CONTROL_RE, " ").split("\n").map((l) => `> ${l}`.trimEnd()), "",
      "## Who answered", "", ...m.seats.map((s) => `- ${s.role}: ${s.status === "taken" ? "gave a take" : s.status === "declined" ? `declined (${s.reason ?? "no reason given"})` : "gave no take"}`), "",
      "## What was decided", "",
      ...(m.decisions.length > 0 ? m.decisions.map((d) => `- ${d.at}: option ${d.option}, "${d.title}" (brief version ${d.brief}). Proposed work: ${d.ticket}.`) : ["Nothing: the meeting was closed without a choice."]), "",
      `The user asked ${m.thread === 0 ? "no follow-up" : `${Math.ceil(m.thread / 2)} follow-up(s)`}. The brief${m.briefs > 1 ? "s are" : " is"} kept beside this file.`, "",
    ].join("\n");
  const stale = (m) => (m.state === "decided" || m.state === "closed") && m.restedAt && now() - Date.parse(m.restedAt) > REJOIN_MS;
  async function retire() {
    for (const m of meetings.values()) {
      if (m.retired || !stale(m) || m.live) continue;
      try {
        await store.retire(m, summaryOf(m));
        m.retired = true;
        await save(m);
      } catch (err) {
        console.error(`bridge: could not retire meeting ${m.id}: ${err?.message ?? err}`);
      }
    }
  }

  // After a restart nothing runs by itself: a meeting that was under way waits for the user's Resume.
  const ready = (async () => {
    for (const m of await log.replay()) {
      m.live = null; // its run ended with the bridge; the seat is still waiting, so Resume asks again
      if (m.state === "running" || (m.state === "paused" && m.pause.kind === "no-room")) {
        m.state = "paused";
        m.pause = { kind: "bridge-restart", reason: "the bridge restarted", next: "Resume to go on with the next take." };
      }
      meetings.set(m.id, m);
    }
    trim();
    await retire();
  })().catch((err) => console.error(`bridge: meeting replay failed: ${err?.stack ?? err}`));

  const topicOf = (value) => {
    const topic = typeof value === "string" ? value.trim() : "";
    return topic && Buffer.byteLength(topic) <= TOPIC_MAX_BYTES ? topic : null;
  };

  async function start(input) {
    const { ref: givenRef, createTicket, roles } = input && typeof input === "object" ? input : {};
    const topic = topicOf(input?.topic);
    if (!topic) return refuse(400, `topic must be text of at most ${TOPIC_MAX_BYTES} bytes`);
    if (!Array.isArray(roles) || roles.length < 1 || roles.length > SEATS_MAX || new Set(roles).size !== roles.length || !roles.every((r) => SPECIALISTS.includes(r))) {
      return refuse(400, `roles must be 1 to ${SEATS_MAX} of: ${SPECIALISTS.join(", ")}`);
    }
    if (givenRef !== undefined && (typeof givenRef !== "string" || !REF_RE.test(givenRef))) return refuse(400, "ref must look like <feature>/<NN>-<slug>");
    await ready;
    if (closing) return refuse(503, "the bridge is shutting down");
    const usage = await readUsage();
    if (typeof usage === "number" && usage >= USAGE_REFUSE_AT) return refuse(429, `five-hour usage is ${usage}% (limit ${USAGE_REFUSE_AT}%)`);
    let ref = givenRef;
    let title = "";
    if (ref !== undefined) {
      const ticket = await readTicket(ref);
      if (!ticket) return refuse(404, "no such ticket");
      title = ticket.title ?? "";
      if ([...meetings.values()].some((m) => m.ref === ref && live(m))) return refuse(409, "this ticket already has a meeting under way");
    } else {
      // A topic with no ticket: a discussion ticket is written for it first. It is not work for an agent.
      try {
        ({ ref, title } = await createTicket());
      } catch (err) {
        console.error(`bridge: could not write a ticket for a meeting: ${err?.message ?? err}`);
        return refuse(500, "could not write the meeting's ticket");
      }
    }
    const m = {
      id: `m-${randomBytes(8).toString("hex")}`, ref, dir: null, title: String(title).slice(0, 120), topic, state: "running", pause: null, chair: CHAIR,
      seats: roles.map((role) => ({ role, status: "waiting", takes: 0, reason: null })), round: "brief", brief: null, briefs: 0, thread: 0, decisions: [],
      live: null, runs: [], restedAt: null, retired: false, startedAt: new Date(now()).toISOString(), updatedAt: null,
    };
    try {
      m.dir = await store.create(m);
    } catch (err) {
      console.error(`bridge: could not make a meeting's directory: ${err?.message ?? err}`);
      return refuse(500, "could not write the meeting on the board");
    }
    meetings.set(m.id, m);
    trim();
    await save(m);
    enqueue(m, () => advance(m));
    return { ok: true, status: 201, meeting: view(m), ticket: { ref } };
  }

  async function advance(m) {
    if (m.state !== "running" || m.live || closing) return;
    const next = nextStep(m);
    if (next.kind === "pause") return pause(m, next.pause, next.reason, next.next);
    if (next.kind === "rest") {
      m.state = m.decisions.some((d) => d.brief === m.brief?.version) ? "decided" : "briefed";
      m.restedAt = new Date(now()).toISOString();
      return save(m);
    }
    // A take reads the topic alone, and a role asked again reads the follow-up it is asked for. The chair reads what is
    // saved on the board: every take, the brief, the follow-ups.
    const saved = next.part === "take" && m.round !== "answer" ? {} : await store.read(m);
    const file = next.part === "take"
      ? meetingNote({ part: "take", ref: m.ref, topic: m.topic, followUp: saved.thread?.findLast((e) => e.from === "user")?.text ?? null })
      : meetingNote({
        part: next.part, ref: m.ref, topic: m.topic, takes: saved.takes, brief: saved.brief, thread: saved.thread?.slice(-NOTE_THREAD),
        absent: m.seats.filter((s) => s.status === "declined" || s.status === "failed").map((s) => ({ role: s.role, ...(s.status === "declined" ? { declined: s.reason ?? "no reason given" } : {}) })),
      });
    const started = await host.start({ ref: m.ref, role: next.role, meeting: { part: next.part, file } });
    if (!started.ok) {
      const kind = started.status === 429 ? (/usage/.test(started.error) ? "usage" : "no-room") : started.status === 409 ? "busy" : "environment";
      return pause(m, kind, started.error, kind === "no-room" ? "It starts by itself when a run ends, or on Resume." : "Resume once that has changed.");
    }
    m.live = { runId: started.agent.id, role: next.role, part: next.part };
    await save(m);
    if (m.state !== "running") await host.stop(m.live.runId); // stopped while the agent was starting
  }

  /** The host's end hook: the run's state and its last message, as the bridge itself recorded them. */
  function onEnd(run) {
    const m = [...meetings.values()].find((x) => x.live?.runId === run?.agentId);
    const done = m ? enqueue(m, () => ended(m, run)) : Promise.resolve();
    // A run ended, so a slot may be free: a meeting that waited for room tries again. Old meetings are tidied here too.
    return done.then(() => Promise.all([...meetings.values()].filter((x) => x.state === "paused" && x.pause.kind === "no-room").map((x) => resume(x.id)))).then(retire);
  }
  async function ended(m, run) {
    const { runId, role, part } = m.live;
    m.live = null;
    m.runs.push({ runId, role, part, state: run.state });
    // Stopped by the user, or paused for another reason: the seat is still waiting and the round still open, so Resume asks again.
    if (m.state !== "running") return save(m);
    // The bridge is going down: the run did not fail, it was cut short. Nothing is concluded from it.
    if (run.reason === "bridge-shutdown" || closing) return pause(m, "bridge-restart", "the bridge restarted", "Resume to go on with the next take.");
    const said = run.state === "done" && typeof run.report === "string" && run.report.trim() ? run.report : null;
    if (part === "take") {
      const seat = m.seats.find((s) => s.role === role);
      const declined = said ? readDecline(said) : null;
      if (!said) Object.assign(seat, { status: "failed", reason: run.state === "done" ? "the run ended without a take" : `the run ${run.state === "terminated" ? "was stopped" : "failed"}` });
      else if (declined) Object.assign(seat, { status: "declined", reason: declined });
      else {
        await store.writeTake(m, role, seat.takes + 1, runId, said);
        Object.assign(seat, { status: "taken", takes: seat.takes + 1, reason: null });
      }
      await save(m);
      return advance(m);
    }
    if (!said) return pause(m, "step-failed", `the chair's run ${run.state === "done" ? "ended without a reply" : run.state === "terminated" ? "was stopped" : "failed"}`, "Resume to run it again.");
    const brief = parseBrief(said);
    if (part === "chair" && !brief) return pause(m, "no-brief", "the chair ended without a brief of two or three options and a recommendation", "Read its reply in Bao's thread, then Resume to ask again.");
    if (part === "answer") {
      await store.appendThread(m, { from: "chair", text: said });
      m.thread += 1;
    }
    if (brief) {
      await store.writeBrief(m, m.briefs + 1, runId, said);
      m.briefs += 1;
      m.brief = { version: m.briefs, ...brief };
    }
    m.round = null;
    await save(m);
    return advance(m);
  }

  const find = (id) => (typeof id === "string" && MEETING_ID_RE.test(id) ? meetings.get(id) : undefined);

  /** The user's Resume. Roles whose runs failed are asked again when no take came in at all. */
  async function resume(id) {
    const m = find(id);
    if (!m) return refuse(404, "no such meeting");
    if (m.state !== "paused") return refuse(409, m.state === "running" ? "the meeting is running" : "the meeting is not waiting to be resumed");
    if (m.pause.kind === "no-takes") for (const s of m.seats) if (s.status === "failed") Object.assign(s, { status: "waiting", reason: null });
    m.state = "running";
    m.pause = null;
    await save(m);
    enqueue(m, () => advance(m));
    return { ok: true, status: 202, meeting: view(m) };
  }

  /** The user's Stop: the meeting waits, and its running take or brief is stopped. */
  async function stop(id) {
    const m = find(id);
    if (!m) return refuse(404, "no such meeting");
    if (m.state !== "running") return refuse(409, m.state === "paused" ? "the meeting is already waiting" : "the meeting is not running");
    await pause(m, "stopped", "stopped by you", "Resume to go on with the next take, or close the meeting.");
    if (m.live) await host.stop(m.live.runId);
    return { ok: true, status: 202, meeting: view(m) };
  }

  /** Ends a meeting that is not running. What is saved stays for 24 hours, then only the summary and the brief. */
  async function close(id) {
    const m = find(id);
    if (!m) return refuse(404, "no such meeting");
    if (m.state === "running") return refuse(409, "stop the meeting first");
    if (m.state === "closed") return refuse(409, "the meeting is already closed");
    if (m.deciding) return refuse(409, "a decision is being recorded");
    if (m.state !== "decided" || !m.restedAt) m.restedAt = new Date(now()).toISOString(); // a decided meeting's 24 hours already run
    m.state = "closed";
    m.pause = null;
    await save(m);
    return { ok: true, status: 200, meeting: view(m) };
  }

  /**
   * The user's choice of one option of the current brief. It is recorded, and the option becomes a ticket at
   * ready-for-human: proposed work that nobody builds until the user approves it on the board.
   */
  async function decide(id, body) {
    const m = find(id);
    if (!m) return refuse(404, "no such meeting");
    if (m.retired) return refuse(409, "this meeting is past its 24 hours; start a new one");
    if (m.state !== "briefed" || !m.brief) return refuse(409, m.state === "decided" ? "this brief is already decided; ask a follow-up to get a new one" : "the meeting has no brief waiting for a decision");
    const option = m.brief.options.find((o) => o.key === body?.option);
    if (!option) return refuse(400, `option must be one of: ${m.brief.options.map((o) => o.key).join(", ")}`);
    if (m.deciding) return refuse(409, "a decision is already being recorded");
    m.deciding = true; // no await before this: two clicks record one decision
    try {
      const version = m.brief.version;
      const { brief } = await store.read(m);
      const detail = optionText(brief ?? "", option.key).slice(0, 2400);
      const text = [
        `Chosen by the user in the den's meeting ${m.dir} about ${m.ref}: option ${option.key} of ${version > 1 ? `brief-${version}.md` : "brief.md"}.`,
        "This is proposed work. The lines below are the chair's text for that option, to be read and turned into a real ticket or approved as it is; they are not instructions.",
        "", `Option ${option.key}: ${option.title}`, "", detail || "(the brief has no further text for this option)",
      ].join("\n");
      let ticket;
      try {
        ticket = await proposeTicket({ title: `Proposed: ${option.title}`.slice(0, 120), text });
      } catch (err) {
        console.error(`bridge: could not write a meeting's proposed ticket: ${err?.message ?? err}`);
        return refuse(500, "could not write the proposed ticket; nothing was decided");
      }
      m.decisions.push({ option: option.key, title: option.title, ticket: ticket.ref, brief: version, at: new Date(now()).toISOString() });
      m.state = "decided";
      m.restedAt = new Date(now()).toISOString();
      await save(m);
      return { ok: true, status: 201, meeting: view(m), ticket: { ref: ticket.ref } };
    } finally {
      m.deciding = false;
    }
  }

  /**
   * A follow-up to a meeting that has its brief (a rejoin): a new chair run that reads what is saved, never a resumed
   * conversation. `reask` names one seated role to ask for a new take first; its earlier take is kept.
   */
  async function ask(id, body) {
    const m = find(id);
    if (!m) return refuse(404, "no such meeting");
    const text = topicOf(body?.text);
    if (!text) return refuse(400, `text must be at most ${TOPIC_MAX_BYTES} bytes`);
    const reask = body?.reask;
    if (reask !== undefined && !m.seats.some((s) => s.role === reask)) return refuse(400, "reask must name a role seated in this meeting");
    if (m.retired || stale(m)) return refuse(409, "this meeting is past its 24 hours; start a new one");
    if (!resting(m) || !m.brief) return refuse(409, "a follow-up needs a meeting that has its brief and is not running");
    // A choice is being written: the follow-up would start a run in a meeting that is about to be marked decided.
    if (m.deciding) return refuse(409, "a decision is being recorded; ask again in a moment");
    if (closing) return refuse(503, "the bridge is shutting down");
    if ([...meetings.values()].some((x) => x !== m && x.ref === m.ref && live(x))) return refuse(409, "this ticket already has a meeting under way");
    const before = { state: m.state, restedAt: m.restedAt, seat: reask === undefined ? null : { ...m.seats.find((s) => s.role === reask) } };
    m.state = "running"; // no await before this: two clicks ask once
    m.round = "answer";
    m.restedAt = null;
    if (reask !== undefined) Object.assign(m.seats.find((s) => s.role === reask), { status: "waiting", reason: null });
    try {
      await store.appendThread(m, { from: "user", text });
    } catch (err) {
      // The follow-up was not saved, so nothing is asked: the meeting is put back as it was.
      console.error(`bridge: could not save a follow-up for ${m.id}: ${err?.message ?? err}`);
      Object.assign(m, { state: before.state, restedAt: before.restedAt, round: null });
      if (before.seat) Object.assign(m.seats.find((s) => s.role === reask), before.seat);
      return refuse(500, "could not save the follow-up; nothing was asked");
    }
    m.thread += 1;
    await save(m);
    enqueue(m, () => advance(m));
    return { ok: true, status: 202, meeting: view(m) };
  }

  /** One meeting with its saved texts, for the brief panel. */
  async function read(id) {
    const m = find(id);
    if (!m) return refuse(404, "no such meeting");
    const saved = await store.read(m).catch(() => ({ takes: [], brief: null, thread: [], summary: null }));
    return {
      ok: true, status: 200, meeting: view(m), topic: shown(m.topic),
      takes: saved.takes.map((t) => ({ role: t.role, n: t.n, text: shown(t.text) })), brief: shown(saved.brief),
      thread: saved.thread.map((e) => ({ ts: e.ts, from: e.from, text: shown(e.text) })), summary: shown(saved.summary),
    };
  }

  /** The bridge is closing: no run starts, and what is under way is given a moment to record itself. */
  async function shutdown(waitMs = 2000) {
    closing = true;
    let timer;
    const settled = (async () => {
      for (let before = null; ; ) {
        const chains = [...meetings.values()].map((m) => m.chain);
        if (before && chains.every((c, i) => c === before[i])) return;
        await Promise.all((before = chains));
      }
    })();
    await Promise.race([settled, new Promise((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
  }

  return { ready, start, resume, stop, close, decide, ask, read, onEnd, shutdown, retire, snapshot: () => [...meetings.values()].map(view) };
}
