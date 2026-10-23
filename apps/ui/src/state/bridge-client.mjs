// den-v1/06: the UI's client for permission requests. The injected `fetch` has the shape of the session's fetch, which
// attaches the credential and ends the session on a 401; this module never builds or reads the credential itself.
// Failures reject with { status, reason }: `reason` is the bridge's `error` string (plain text) when it sent one.
const MESSAGE_MAX_BYTES = 2048;
const FALLBACK =(status) => (status === 0 ? "Could not reach the bridge." : `The bridge refused the request (${status}).`);

function failure(status, reason) {
  return Object.assign(new Error(reason), { status, reason });
}

export function createBridgeClient({ fetch }) {
  const route = (id) => `/approvals/${encodeURIComponent(id)}`;

  async function call(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      throw failure(0, FALLBACK(0));
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // an empty or non-JSON body: the status still decides
    }
    if (!res?.ok) {
      const sent = typeof body?.error === "string" && body.error.trim() ? body.error : null;
      throw failure(Number.isInteger(res?.status) ? res.status : 0, sent ?? FALLBACK(res?.status ?? 0));
    }
    return body;
  }

  return {
    async getApproval(id) {
      const body = await call(route(id), { method: "GET" });
      if (body == null) throw failure(200, "The bridge sent an unreadable answer.");
      return body;
    },
    async decide(id, { decision, note, answers } = {}) {
      if (decision !== "allow" && decision !== "deny") throw failure(0, "Decision must be allow or deny.");
      const payload = { decision };
      if (note !== undefined && note !== null && note !== "") payload.note = note;
      if (Array.isArray(answers)) payload.answers = answers; // den-mvp/37: one per question, for an agent's question
      const body = await call(route(id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return body ?? { ok: true };
    },
    // den-v1/07: one message to one agent. The text is trimmed and checked here too, so a caller that skipped the
    // composer's own guard still cannot send an empty or oversized body.
    async sendMessage(agentId, { text } = {}) {
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) throw failure(0, "Write a message first.");
      if (new TextEncoder().encode(trimmed).length > MESSAGE_MAX_BYTES) throw failure(0, `Messages are limited to ${MESSAGE_MAX_BYTES} bytes.`);
      const body = await call(`/agents/${encodeURIComponent(agentId)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      return body ?? { ok: true };
    },
    // organism-infra/230: stop one agent. No body and no retry: pressing Stop again is the retry. A 409 (already
    // ended) and a 404 reject { status, reason } with the bridge's text, like every other call here.
    async stopAgent(agentId) {
      await call(`/agents/${encodeURIComponent(agentId)}/stop`, { method: "POST", headers: { "Content-Type": "application/json" } });
      return { ok: true };
    },
    // den-mvp outcome 2: one message into a role's conversation. The bridge sends it to the run named (or the role's
    // live run), or starts a follow-up run that continues an ended run's session: the answer says which
    // ({ runId, messageId, resumed, agent? }).
    async converse(role, { text, runId, runtime, project } = {}) {
      if (typeof role !== "string" || !role) throw failure(0, "Pick a panda first.");
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) throw failure(0, "Write a message first.");
      if (new TextEncoder().encode(trimmed).length > MESSAGE_MAX_BYTES) throw failure(0, `Messages are limited to ${MESSAGE_MAX_BYTES} bytes.`);
      const body = await call(`/conversations/${encodeURIComponent(role)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, ...(typeof runId === "string" && runId ? { runId } : {}), ...(runtime === undefined ? {} : { runtime }), ...(project === undefined ? {} : { project }) }),
      });
      if (body == null) throw failure(200, "The bridge sent an unreadable answer.");
      return body;
    },
    // A page of a role's durable conversation, oldest first: { entries, more, before }. `before` asks for the page above.
    async getConversation(role, { before, limit, runtime, project } = {}) {
      const query = new URLSearchParams();
      if (Number.isInteger(before) && before >= 0) query.set("before", String(before));
      if (Number.isInteger(limit) && limit > 0) query.set("limit", String(limit));
      if (runtime !== undefined) query.set("runtime", runtime);
      if (project !== undefined) query.set("project", project);
      const body = await call(`/conversations/${encodeURIComponent(role)}${query.size ? `?${query}` : ""}`, { method: "GET" });
      if (!body || !Array.isArray(body.entries)) throw failure(200, "The bridge sent an unreadable answer.");
      return body;
    },
    // den-mvp outcome 4: the library: each connection with its status, roles and tools, and each skill. A read; no credential needed.
    async getLibrary() {
      const body = await call("/library", { method: "GET" });
      if (!body || !Array.isArray(body.connections) || !Array.isArray(body.skills)) throw failure(200, "The bridge sent an unreadable answer.");
      return body;
    },
    // den-mvp outcome 4: a meeting. `roles` are the specialists asked for a take; with no `ref` the bridge writes a
    // discussion ticket for the topic first. -> { meeting, ticket }
    async startMeeting({ topic, roles, ref } = {}) {
      const trimmed = typeof topic === "string" ? topic.trim() : "";
      if (!trimmed) throw failure(0, "Write the question first.");
      if (new TextEncoder().encode(trimmed).length > MESSAGE_MAX_BYTES) throw failure(0, `The question is limited to ${MESSAGE_MAX_BYTES} bytes.`);
      if (!Array.isArray(roles) || roles.length === 0) throw failure(0, "Pick at least one role.");
      const about = typeof ref === "string" && ref.trim() ? { ref: ref.trim() } : {};
      const body = await call("/meetings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: trimmed, roles, ...about }) });
      if (body == null) throw failure(200, "The bridge sent an unreadable answer.");
      return body;
    },
    // One meeting with its saved texts: { meeting, topic, takes, brief, thread, summary }.
    async getMeeting(id) {
      const body = await call(`/meetings/${encodeURIComponent(id)}`, { method: "GET" });
      if (!body || !Array.isArray(body.takes) || !Array.isArray(body.thread)) throw failure(200, "The bridge sent an unreadable answer.");
      return body;
    },
    // Resume, stop or close a meeting; decide ({ option }) records the user's choice; ask ({ text, reask? }) is a follow-up.
    async steerMeeting(id, action, { option, text, reask } = {}) {
      if (!["resume", "stop", "close", "decide", "ask"].includes(action)) throw failure(0, "Unknown action.");
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (action === "ask" && !trimmed) throw failure(0, "Write the follow-up first.");
      const payload = action === "decide" ? { option } : action === "ask" ? { text: trimmed, ...(reask ? { reask } : {}) } : {};
      const body = await call(`/meetings/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      return body ?? { ok: true };
    },
    // den-v1 loop S1: start a task for one role. The bridge writes the ticket and answers { agent, ticket }.
    async startTask(role, { text, grants, runtime, project } = {}) {
      if (typeof role !== "string" || !role) throw failure(0, "Pick a panda first.");
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) throw failure(0, "Write a task first.");
      if (new TextEncoder().encode(trimmed).length > MESSAGE_MAX_BYTES) throw failure(0, `Tasks are limited to ${MESSAGE_MAX_BYTES} bytes.`);
      const body = await call("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, text: trimmed, ...(Array.isArray(grants) && grants.length ? { grants } : {}), ...(runtime === undefined ? {} : { runtime }), ...(project === undefined ? {} : { project }) }),
      });
      if (body == null) throw failure(200, "The bridge sent an unreadable answer.");
      return body;
    },
    // organism-infra/228: run one frontier ticket as one role. One request per call: a refusal (409, 429, 503) rejects
    // { status, reason } with the bridge's text and is never retried here; pressing Run again is the retry.
    // den-mvp/89: the bridge claims the ticket for the role, and the board refuses a qa claim with no mode, so a qa Run is a verify.
    async dispatch(ref, { role, runtime, project } = {}) {
      const body = await call("/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref, role, ...(role === "qa" ? { mode: "verify" } : {}), ...(runtime === undefined ? {} : { runtime }), ...(project === undefined ? {} : { project }) }),
      });
      if (body == null) throw failure(200, "The bridge sent an unreadable answer.");
      return body;
    },
    // den-mvp outcome 3: deliver a ticket as software (developer, qa, the checks, a pull request, the merge). Pressing
    // Deliver is the approval. With `text` and no ref, the bridge writes the ticket first. -> { delivery, ticket? }
    async deliver({ ref, text } = {}) {
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!ref && !trimmed) throw failure(0, "Write what to build first.");
      if (!ref && new TextEncoder().encode(trimmed).length > MESSAGE_MAX_BYTES) throw failure(0, `Tasks are limited to ${MESSAGE_MAX_BYTES} bytes.`);
      const body = await call("/deliveries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ref ? { ref } : { text: trimmed }) });
      if (body == null) throw failure(200, "The bridge sent an unreadable answer.");
      return body;
    },
    // den-mvp/13: the user's answer to a ticket at ready-for-human. Decline needs a note: it is the reason it closes.
    async answerTicket(ref, action, { note } = {}) {
      if (!["approve", "decline"].includes(action)) throw failure(0, "Unknown action.");
      const trimmed = typeof note === "string" ? note.trim() : "";
      if (action === "decline" && !trimmed) throw failure(0, "Write why first.");
      const body = await call(`/tickets/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "decline" ? { ref, note: trimmed } : { ref }),
      });
      return body ?? { ok: true };
    },
    // den-mvp/88: the user has seen a stop the router met; it leaves Needs you (and returns if the stop is still true).
    async dismissRouterStop(id) {
      const body = await call(`/router-stops/${encodeURIComponent(id)}/dismiss`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return body ?? { ok: true };
    },
    // den-mvp/34: run ci.yml's checks on this machine for an open pull request's head commit. -> { sha }
    async runChecks({ pr } = {}) {
      if (!Number.isInteger(pr) || pr < 1) throw failure(0, "No pull request to check.");
      const body = await call("/checks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pr }) });
      return body ?? { ok: true };
    },
    // Resume, stop or close one delivery. On a resume, `verdict` is the user's visual verdict on a UI change: "approve", or
    // "decline" with a `note` that goes to the developer. A Resume without a verdict may carry a `note` for the next run.
    async steerDelivery(id, action, { verdict, note } = {}) {
      if (!["resume", "stop", "close"].includes(action)) throw failure(0, "Unknown action.");
      const trimmed = typeof note === "string" ? note.trim() : "";
      if (action === "resume" && verdict === "decline" && !trimmed) throw failure(0, "Write what should change first.");
      const body = await call(`/deliveries/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action !== "resume" ? {} : verdict ? { verdict, ...(verdict === "decline" ? { note: trimmed } : {}) } : trimmed ? { note: trimmed } : {}),
      });
      return body ?? { ok: true };
    },
    // den-mvp/12 (ADR 0026 decision 7): go back to the previous build. `to` is the commit the button showed as previous;
    // the bridge refuses (409) when that is no longer the previous one. -> { build }
    async rollback(to) {
      if (typeof to !== "string" || !to) throw failure(0, "There is no previous build.");
      const body = await call("/build/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to }) });
      return body ?? { ok: true };
    },
  };
}
