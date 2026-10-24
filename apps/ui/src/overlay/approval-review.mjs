// den-v1/06: the permission review controller. Pure and DOM-free: the client, the clock and the open hook are
// injected, so every state in the design spec is testable without a browser. React renders getState() and forwards
// keys, clicks and each new snapshot (ApprovalPanel.jsx).
export const NOTE_MAX = 200;
export const KEY_GUARD_MS = 400;
const WARN_MS = 60000;
const FINAL_STATUSES = new Set([401, 404, 409]);
const ENDED = new Set(["done", "failed", "terminated"]);
// Control, format and bidirectional-override characters are shown as escapes so a command cannot hide behind them.
const UNSAFE_RANGES = [[0x0,0x1f],[0x7f,0x9f],[0xad,0xad],[0x61c,0x61c],[0x115f,0x1160],[0x180e,0x180e],[0x200b,0x200f],[0x2028,0x202e],[0x2060,0x206f],[0x3164,0x3164],[0xfeff,0xfeff],[0xffa0,0xffa0],[0xfff9,0xfffb],[0xe0000,0xe0fff]];
const isUnsafe = (cp) => UNSAFE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
const DEMO_REASON = "Demo mode: actions are off";

// `keepNewlines` is for pretty-printed JSON only: JSON.stringify has already escaped every line break inside a
// value, so a raw one is layout and the input reads on its own lines.
const escapeUnsafe = (text, keepNewlines = false) => Array.from(text, (ch) => {
  const cp = ch.codePointAt(0);
  if (!isUnsafe(cp) || (keepNewlines && cp === 0x0a)) return ch;
  const hex = cp.toString(16).padStart(4, "0");
  return hex.length > 4 ? "\\u{" + hex + "}" : "\\u" + hex;
}).join("");

// den-mvp/55: Bao's board_file batch is shown as the tickets it files (title, priority, type, blockers, the text as
// markdown), not as escaped JSON. Anything that is not a well-formed batch keeps the plain JSON view.
const BATCH_TOOL = "mcp__den__board_file";
const str = (v, fallback) => (typeof v === "string" && v.trim() ? v : fallback);
export function inputViewOf(tool, input) {
  if (tool !== BATCH_TOOL || !Array.isArray(input?.tickets) || input.tickets.length === 0) return null;
  const tickets = input.tickets.map((t, i) => {
    if (t === null || typeof t !== "object" || typeof t.title !== "string" || typeof t.text !== "string") return null;
    const blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy.map((b) => (Number.isInteger(b) ? `ticket ${b} above` : escapeUnsafe(String(b)))) : [];
    return {
      n: i + 1, title: escapeUnsafe(t.title), text: escapeUnsafe(t.text, true),
      priority: escapeUnsafe(str(t.priority, "P2")), type: escapeUnsafe(str(t.type, "task")), blockedBy,
    };
  });
  if (tickets.some((t) => t === null)) return null;
  return { kind: "tickets", feature: escapeUnsafe(str(input.feature, "den")), tickets };
}

const reasonOf = (err) => (typeof err?.reason === "string" && err.reason.trim() ? err.reason : "The bridge did not answer.");
const statusOf = (err) => (Number.isInteger(err?.status) ? err.status : 0);

const settledBanner = (state) => (state === "expired"
  ? "Expired. This request timed out before you answered; nothing was sent."
  : "Already answered. Nothing was sent.");

export function createApprovalReview({ client, now = Date.now, hooks = {} }) {
  const listeners = new Set();
  const answered = new Set();
  let seqCounter = 0;
  let focusSeq = 0;
  let s = closedState(null, null);
  let view = null;

  function closedState(focusReturn, announcement) {
    return { open: false, focusReturn, announcement };
  }

  const current = (seq) => s.open && s.seq === seq && !s.final;
  const remaining = () => (s.open && s.card.expiresAt != null ? s.card.expiresAt - now() : null);
  const inputOk = () => s.loadStatus === "loaded" && s.inputCount === s.card.inputLength;

  function expiresLabel() {
    const left = remaining();
    if (left == null) return null;
    if (s.final?.expired || left <= 0) return "Expired";
    const total = Math.ceil(left / 1000);
    return `Expires in ${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function build() {
    if (!s.open) {
      return {
        open: false, phase: "closed", heading: "", meta: "", ariaLabel: "", expiresLabel: null, countLabel: null,
        inputText: null, inputView: null, allowEnabled: false, denyEnabled: false, sending: null, noteReadOnly: false, note: "",
        noteCounter: `0 / ${NOTE_MAX}`, banner: null, focus: null, focusSeq, focusReturn: s.focusReturn, announcement: s.announcement,
      };
    }
    const loaded = s.loadStatus === "loaded";
    const ok = inputOk();
    const phase = s.final ? "final" : s.sending ? "sending" : s.refusal ? "refused"
      : s.loadStatus === "failed" ? "load-failed" : s.loadStatus === "loading" ? "loading" : "ready";
    let countLabel = null;
    if (!s.final) {
      if (s.loadStatus === "loading") countLabel = "Loading...";
      else if (s.loadStatus === "failed") countLabel = "Not loaded";
      else if (ok) countLabel = `All ${s.inputCount.toLocaleString("en-US")} characters shown`;
      else countLabel = `Showing ${s.inputCount.toLocaleString("en-US")} characters, not the ${s.card.inputLength ?? "expected"} requested`;
    }
    const banner = s.final?.banner ?? s.refusal
      ?? (s.loadStatus === "failed" ? `Could not load the tool input: ${s.loadError}. Allow stays off until it loads.` : null)
      ?? (loaded && !ok ? "The input shown does not match the request, so Allow stays off." : null);
    return {
      open: true, phase,
      heading: `Run ${s.card.tool}`,
      meta: [s.card.name, s.card.role, s.card.ref].filter(Boolean).join(" · "),
      ariaLabel: `Permission request for ${s.card.name}`,
      expiresLabel: expiresLabel(),
      countLabel,
      inputText: !s.final && loaded ? s.inputText : null,
      inputView: !s.final && loaded ? s.inputView : null,
      allowEnabled: !s.final && !s.sending && ok,
      denyEnabled: !s.final && !s.sending,
      sending: s.sending,
      noteReadOnly: !!s.sending || !!s.final,
      note: s.note,
      noteCounter: `${s.note.length} / ${NOTE_MAX}`,
      banner,
      focus: s.focus, focusSeq, focusReturn: null,
      announcement: s.announcement,
    };
  }

  const getState = () => (view ??= build());
  function emit() {
    view = null;
    const state = getState();
    for (const fn of [...listeners]) fn(state);
  }
  const setFocus = (target) => { s.focus = target; focusSeq += 1; };

  function setFinal(banner, { expired = false } = {}) {
    s.final = { banner, expired };
    s.sending = null;
    s.refusal = null;
    s.input = null;
    s.inputText = null;
    s.inputView = null;
    setFocus("close");
    emit();
  }

  function expireIfDue() {
    const left = remaining();
    if (left == null || left > 0) return false;
    s.announcement = `Permission request for ${s.card.name} expired.`;
    setFinal(settledBanner("expired"), { expired: true });
    return true;
  }

  function load() {
    const seq = s.seq;
    s.loadStatus = "loading";
    s.loadError = null;
    let request;
    try {
      request = Promise.resolve(client.getApproval(s.card.approvalId));
    } catch (err) {
      request = Promise.reject(err);
    }
    return request.then((res) => {
      if (!current(seq)) return;
      const input = res?.input;
      if (input === null || input === undefined) {
        const state = res?.state ?? res?.status;
        if (state && state !== "pending") setFinal(settledBanner(state), { expired: state === "expired" });
        else { s.loadStatus = "failed"; s.loadError = "The bridge sent no tool input"; emit(); }
        return;
      }
      s.input = input;
      if (res.privateContext === true) s.card.tool = res.tool;
      s.inputCount = JSON.stringify(input).length;
      s.inputText = escapeUnsafe(JSON.stringify(input, null, 2), true);
      s.inputView = inputViewOf(res?.tool ?? s.card.approval?.tool, input);
      s.loadStatus = "loaded";
      emit();
    }, (err) => {
      if (!current(seq)) return;
      const status = statusOf(err);
      if (status === 401) setFinal("Session ended. Restart the bridge and open the launch link it prints.");
      else if (FINAL_STATUSES.has(status)) setFinal(`Too late. ${reasonOf(err)}`);
      else { s.loadStatus = "failed"; s.loadError = reasonOf(err); emit(); }
    });
  }

  function open(card, { mode = "walk", demo = false } = {}) {
    if (s.open) return { opened: true, reason: null };
    if (demo) return { opened: false, reason: DEMO_REASON };
    const a = card?.actions?.E, d = card?.actions?.Q;
    if (!card || !a?.enabled || !d?.enabled || !card.approval?.id) {
      return { opened: false, reason: a?.reason ?? d?.reason ?? "no pending permission request" };
    }
    if (answered.has(card.approval.id)) return { opened: false, reason: "Already answered" };
    const expires = Date.parse(card.approval.expiresAt);
    s = {
      open: true, seq: ++seqCounter, mode, openedAt: now(),
      card: {
        approvalId: card.approval.id, tool: card.approval.tool ?? card.tool?.name ?? "tool",
        name: card.name || card.role || "agent", role: card.role ?? "", ref: card.ref ?? null,
        agentId: card.agentId ?? card.approval.agentId ?? null, inputLength: card.approval.inputLength,
        expiresAt: Number.isFinite(expires) ? expires : null,
      },
      loadStatus: "loading", loadError: null, input: null, inputText: null, inputView: null, inputCount: 0,
      sending: null, refusal: null, final: null, note: "", focus: "deny", focusReturn: null, announcement: null, warned: false,
    };
    focusSeq += 1;
    hooks.onOpen?.();
    if (expireIfDue()) return { opened: true, reason: null };
    emit();
    load();
    return { opened: true, reason: null };
  }

  function close() {
    if (!s.open) return;
    s = closedState(s.mode === "walk" ? "scene" : "card-button", s.announcement);
    focusSeq += 1;
    emit();
  }

  async function press(decision) {
    if (decision !== "allow" && decision !== "deny") return;
    if (!s.open || s.final || s.sending) return;
    if (expireIfDue()) return;
    if (decision === "allow" ? !getState().allowEnabled : !getState().denyEnabled) return;
    const seq = s.seq;
    const { approvalId, tool, name } = s.card;
    const body = { decision };
    const note = s.note.trim().slice(0, NOTE_MAX);
    if (note) body.note = note;
    s.sending = decision;
    s.refusal = null;
    emit();
    try {
      await client.decide(approvalId, body);
    } catch (err) {
      if (!current(seq)) return;
      s.sending = null;
      const status = statusOf(err);
      if (status === 401) setFinal("Session ended. Restart the bridge and open the launch link it prints.");
      else if (FINAL_STATUSES.has(status)) setFinal(`Too late. ${reasonOf(err)}`);
      else {
        s.refusal = `Not sent. ${reasonOf(err)} Nothing changed. Try again.`;
        setFocus(decision);
        emit();
      }
      return;
    }
    answered.add(approvalId);
    const announcement = `${decision === "allow" ? "Allowed" : "Denied"} ${tool} for ${name}.`;
    if (s.open && s.seq === seq) {
      s = closedState(s.mode === "walk" ? "scene" : "card-button", announcement);
      focusSeq += 1;
    } else {
      s.announcement = announcement;
    }
    emit();
  }

  function setNote(text) {
    if (!s.open || s.sending || s.final) return;
    s.note = String(text ?? "").slice(0, NOTE_MAX);
    emit();
  }

  function retryLoad() {
    if (!s.open || s.final || s.loadStatus !== "failed") return Promise.resolve();
    s.refusal = null;
    emit();
    const pending = load();
    emit();
    return pending;
  }

  function sync({ approvals = [], agents = [] } = {}) {
    if (!s.open || s.final || s.sending) return;
    const approval = approvals.find((a) => a.id === s.card.approvalId);
    const state = approval ? approval.state ?? approval.status ?? "pending" : null;
    if (!approval || state !== "pending") {
      setFinal(settledBanner(state), { expired: state === "expired" });
      return;
    }
    const agent = agents.find((a) => a.id === s.card.agentId);
    if (agent && ENDED.has(agent.state)) setFinal(`Agent ended: ${agent.state}.`);
  }

  function tick() {
    if (!s.open || s.final) return;
    if (!s.sending && expireIfDue()) return;
    let changed = false;
    const left = remaining();
    if (left != null && left <= WARN_MS && !s.warned) {
      s.warned = true;
      s.announcement = "Expires in 1 minute";
      changed = true;
    }
    if (changed || expiresLabel() !== getState().expiresLabel) emit();
  }

  function key(event, { card = null, mode = "walk", demo = false } = {}) {
    const { key: k, repeat = false, inNote = false } = event ?? {};
    const lower = typeof k === "string" ? k.toLowerCase() : "";
    const decision = lower === "e" ? "allow" : lower === "q" ? "deny" : null; // E and Q: A and D walk
    if (s.open) {
      if (k === "Escape") { close(); return { handled: true, walk: false }; }
      if (inNote) return { handled: false, walk: false };
      if (decision) {
        if (!repeat && now() - s.openedAt >= KEY_GUARD_MS) press(decision);
        return { handled: true, walk: false };
      }
      return { handled: false, walk: false };
    }
    // Walk mode or the overview ("diorama"); with the cursor free in walk mode the card's buttons are clicked instead.
    if (decision && !inNote && !repeat && mode !== "free" && card) {
      const { opened } = open(card, { mode, demo });
      return { handled: opened, walk: !opened };
    }
    return { handled: false, walk: true };
  }

  return {
    getState,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    open, key, press, setNote, retryLoad, close, sync, tick,
  };
}
