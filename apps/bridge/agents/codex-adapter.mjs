// Codex app-server protocol translation (den-revival/03 slice 1a), ported from codex/standalone-codex.
// It speaks line-delimited JSON-RPC to an app-server and turns its notifications into host events. It
// launches no process, loads no login or config and registers no runtime: `openCodexAppServer` wraps a
// child the caller already started. The protected execution seam (`authorizeExecution`) must supply the
// compiled profile and working directory; a fixture returning values proves protocol behavior, never
// confinement.
import { TextDecoder, isDeepStrictEqual } from "node:util";
import { hasSecret } from "../../../scripts/exposure.mjs";
import { cleanText } from "../../shared/safe-text.mjs";

export const MAX_FRAME_BYTES = 1_000_000;
const MAX_TURN_INPUT_BYTES = 256_000;
const DEFAULTS = Object.freeze({ frameBytes: MAX_FRAME_BYTES, pending: 32, events: 256, serverRequests: 1000,
  turns: 1000, pages: 32, models: 1000, requestTimeoutMs: 10000, questionTimeoutMs: 600000 });
const BODY_MAX = 16000;
const TURN_METHODS = ["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta"];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value) => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)) || (Number.isSafeInteger(value) && value >= 0);
const nativeId = (value) => typeof value === "string" && id(value);
const text = (value, max = BODY_MAX) => typeof value === "string" && value.length <= max;
const nonSecretText = (value, max) => text(value, max) && !hasSecret(value);
const owns = (value, prop) => Object.hasOwn(value, prop);
// Mask secrets in the whole text before clipping, as the Claude adapter does; the host cleans again before it stores or shows an event.
const clipped = (raw) => {
  if (typeof raw !== "string") return { text: "" };
  const value = cleanText(raw);
  return { text: value.slice(0, BODY_MAX), ...(value.length > BODY_MAX ? { more: value.length - BODY_MAX } : {}) };
};
// The seam's `config` may only carry these display settings; sandbox, approval and permission keys come from the compiled profile alone.
const CONFIG_KEYS = Object.freeze(["model_verbosity", "model_reasoning_summary"]);
const safeConfig = (config) => Object.entries(config).every(([key, value]) => CONFIG_KEYS.includes(key) && text(value, 64));

export class CodexProtocolError extends Error {
  constructor(reason) { super(`Codex protocol: ${reason}`); this.name = "CodexProtocolError"; }
}

export function createCodexProtocol({ write, close: closeTransport = () => {}, authorizeExecution, limits: requested = {} } = {}) {
  if (typeof write !== "function" || typeof closeTransport !== "function") throw new TypeError("Codex protocol needs a transport writer and closer");
  const limits = { ...DEFAULTS };
  for (const [name, value] of Object.entries(requested)) {
    if (!owns(DEFAULTS, name) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULTS[name]) throw new TypeError("invalid Codex protocol limit");
    limits[name] = value;
  }
  let closed = null;
  let buffer = Buffer.alloc(0);
  let sequence = 0;
  let questionSequence = 0;
  let initialized = false;
  let initializing;
  let preparing = false;
  let startingTurn = false;
  let interrupting = false;
  let thread = null;
  let turnId = null;
  let endedTurn = null;
  let catalog;
  let loadingCatalog;
  const pending = new Map();
  const serverIds = new Set();
  const seenTurns = new Set(); // Never evict: an old native identity must never become current again.
  const questions = new Map();
  const earlyEvents = [];
  const events = [];
  const readers = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function fail(reason) {
    if (closed) return closed;
    closed = new CodexProtocolError(reason);
    buffer = Buffer.alloc(0);
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(closed); }
    pending.clear();
    for (const question of questions.values()) clearTimeout(question.timer);
    questions.clear();
    earlyEvents.length = 0;
    try { closeTransport(); } catch { /* closing an already-failed transport cannot reopen it */ }
    for (const resolve of readers.splice(0)) resolve({ value: undefined, done: true });
    return closed;
  }
  function ensureOpen() { if (closed) throw closed; }
  function emit(event) {
    if (closed) return;
    const waiting = readers.shift();
    if (waiting) waiting({ value: event, done: false });
    else if (events.length >= limits.events) fail("event queue limit reached");
    else events.push(event);
  }
  function send(message) {
    ensureOpen();
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > limits.frameBytes) throw fail("outgoing frame limit reached");
    try { Promise.resolve(write(line)).catch(() => fail("transport write failed")); }
    catch { throw fail("transport write failed"); }
  }
  function rpc(method, params) {
    ensureOpen();
    if (pending.size >= limits.pending || sequence >= Number.MAX_SAFE_INTEGER) throw fail("pending request limit reached");
    const requestId = `client-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail("request timed out; outcome is uncertain"), limits.requestTimeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try { send({ id: requestId, method, params }); } catch (err) { reject(err); }
    });
  }
  function errorReply(requestId, code, message) { send({ id: requestId, error: { code, message } }); }
  const active = (params) => thread && turnId && !interrupting && params?.threadId === thread.id && params?.turnId === turnId;
  function discardQuestions(reason) {
    for (const [publicId, question] of questions) {
      clearTimeout(question.timer);
      if (!closed) errorReply(question.nativeId, -32000, reason);
      questions.delete(publicId);
    }
  }

  function serverRequest(message) {
    const requestKey = `${typeof message.id}:${message.id}`;
    if (serverIds.has(requestKey) || serverIds.size >= limits.serverRequests) return fail("duplicate server request or request limit reached");
    serverIds.add(requestKey);
    // Native accepts can escape confinement or persist grants. A bounded change must be recompiled and
    // admitted through authorizeExecution instead.
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
      send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    if (message.method !== "item/tool/requestUserInput") return errorReply(message.id, -32601, "Unsupported native request");
    const params = message.params;
    const qs = params?.questions;
    if (!active(params) || !nativeId(params.itemId) || typeof params.isBlocking !== "boolean" || !Array.isArray(qs) || qs.length < 1 || qs.length > 3 ||
        qs.some((q) => !object(q) || !nativeId(q.id) || hasSecret(q.id) || !nonSecretText(q.header, 80) || !nonSecretText(q.question, 2048) || (q.isSecret !== undefined && q.isSecret !== false) ||
          (q.options != null && (!Array.isArray(q.options) || q.options.length > 8 || q.options.some((o) => !object(o) || !nonSecretText(o.label, 200) || !nonSecretText(o.description, 1000))))) ||
        new Set(qs.map((q) => q.id)).size !== qs.length || questions.size >= 20) {
      return errorReply(message.id, -32602, "Unsupported or stale question");
    }
    const publicId = `q-${++questionSequence}`;
    const timer = setTimeout(() => {
      if (!questions.delete(publicId) || closed) return;
      errorReply(message.id, -32000, "Question expired");
    }, limits.questionTimeoutMs);
    timer.unref?.();
    questions.set(publicId, { nativeId: message.id, turnId, questions: qs, timer });
    emit({ type: "permission-request", requestId: publicId, tool: "AskUserQuestion", input: { questions: qs.map((q) => ({ id: q.id, header: q.header, question: q.question,
      ...(q.options == null ? {} : { options: q.options.map((o) => ({ label: o.label, description: o.description })) }) })) } });
  }

  function notification(method, params) {
    // These can precede the correlated turn/start response. Hold only bounded data and expose nothing
    // until the acknowledgement names the turn.
    if (startingTurn && TURN_METHODS.includes(method)) {
      if (earlyEvents.length >= limits.events) return fail("early event queue limit reached");
      earlyEvents.push({ method, params });
      return;
    }
    if (!TURN_METHODS.includes(method)) return;
    const eventTurn = method.startsWith("turn/") ? params?.turn?.id : params?.turnId;
    if (!thread || params?.threadId !== thread.id || !nativeId(eventTurn)) return fail("foreign thread or invalid event identity");
    if (!turnId && eventTurn === endedTurn?.id && method === "turn/completed") {
      if (params.turn.status !== endedTurn.status || !isDeepStrictEqual(params.turn.error ?? null, endedTurn.error)) return fail("contradictory turn completion");
      return;
    }
    if (eventTurn !== turnId) return fail("foreign or stale turn notification");
    if (method === "turn/started") return;
    if (method === "turn/completed") {
      const status = params.turn.status;
      if (!["completed", "interrupted", "failed"].includes(status)) return fail("invalid turn completion");
      discardQuestions("Turn ended");
      endedTurn = { id: turnId, status, error: params.turn.error ?? null };
      turnId = null;
      interrupting = false;
      emit({ type: "done", ok: status === "completed" });
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (!nativeId(params.itemId) || typeof params.delta !== "string") return fail("invalid text event");
      emit({ type: "text", ...clipped(params.delta) });
      return;
    }
    const item = params.item;
    if (!object(item) || !nativeId(item.id) || typeof item.type !== "string") return fail("invalid item event");
    if (item.type === "collabAgentToolCall") return fail("native child delegation was observed");
    if (item.type === "agentMessage") {
      if (method === "item/completed" && typeof item.text === "string") emit({ type: "reply", ...clipped(item.text) });
      return;
    }
    if (!["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) return;
    if (method === "item/started") emit({ type: "tool-start", id: item.id, name: item.type, summary: typeof item.command === "string" ? cleanText(item.command).slice(0, 200) : item.type });
    else {
      emit({ type: "tool-result", id: item.id, ok: item.status === "completed", ...clipped(item.aggregatedOutput) });
      emit({ type: "tool-end", id: item.id });
    }
  }
  function receive(message) {
    if (!object(message) || (owns(message, "jsonrpc") && message.jsonrpc !== "2.0")) return fail("invalid envelope");
    if (owns(message, "method")) {
      if (typeof message.method !== "string" || !text(message.method, 256) || owns(message, "result") || owns(message, "error")) return fail("ambiguous request envelope");
      if (owns(message, "id")) {
        if (!id(message.id)) return fail("invalid server request identity");
        serverRequest(message);
      } else notification(message.method, message.params);
      return;
    }
    if (typeof message.id !== "string" || !pending.has(message.id) || owns(message, "result") === owns(message, "error")) return fail("unsolicited or ambiguous response");
    const call = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (owns(message, "error")) call.reject(new CodexProtocolError("RPC failed; native diagnostics withheld"));
    else call.resolve(message.result);
  }

  function feed(chunk) {
    if (closed) return;
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) return fail("invalid transport chunk");
    const incoming = Buffer.from(chunk);
    if (incoming.length > limits.frameBytes || buffer.length + incoming.length > limits.frameBytes * 2) return fail("incoming frame limit reached");
    buffer = Buffer.concat([buffer, incoming]);
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) {
        if (buffer.length > limits.frameBytes) fail("incoming frame limit reached");
        return;
      }
      if (newline > limits.frameBytes) return fail("incoming frame limit reached");
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (!frame.length) continue;
      try { receive(JSON.parse(decoder.decode(frame))); }
      catch { return fail("malformed JSON, UTF-8 or transport frame"); }
      if (closed) return;
    }
  }

  async function initialize() {
    ensureOpen();
    return initializing ??= (async () => {
      const response = await rpc("initialize", { clientInfo: { name: "dim-sum-den", version: "1" }, capabilities: { experimentalApi: true } });
      if (!object(response) || !text(response.userAgent, 1000)) throw fail("invalid initialize acknowledgement");
      send({ method: "initialized" });
      initialized = true;
    })();
  }
  async function discoverModels() {
    await initialize();
    if (catalog) return catalog;
    return loadingCatalog ??= (async () => {
      const found = new Map();
      const cursors = new Set();
      let cursor;
      for (let page = 0; page < limits.pages; page += 1) {
        const response = await rpc("model/list", { limit: 50, includeHidden: true, ...(cursor === undefined ? {} : { cursor }) });
        if (!object(response) || !Array.isArray(response.data) || response.data.length > 100 || !(response.nextCursor === null || text(response.nextCursor, 1000))) throw fail("invalid model discovery response");
        for (const model of response.data) {
          if (!object(model) || !nativeId(model.model) || !nativeId(model.id) || !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 10 ||
              model.supportedReasoningEfforts.some((e) => !object(e) || !text(e.reasoningEffort, 32)) || found.has(model.model) || found.size >= limits.models) throw fail("invalid model discovery catalog");
          found.set(model.model, Object.freeze({ model: model.model, efforts: Object.freeze(model.supportedReasoningEfforts.map((e) => e.reasoningEffort)) }));
        }
        if (response.nextCursor === null) return catalog = found;
        if (!response.nextCursor || cursors.has(response.nextCursor)) throw fail("model discovery cursor repeated");
        cursor = response.nextCursor;
        cursors.add(cursor);
      }
      throw fail("model discovery page limit reached");
    })();
  }
  async function supportsModel({ model, effort } = {}) {
    if (!nativeId(model) || !text(effort, 32)) return false;
    const found = await discoverModels();
    return found.get(model)?.efforts.includes(effort) === true;
  }
  async function authorize(context) {
    if (typeof authorizeExecution !== "function") throw new CodexProtocolError("protected execution integration is unavailable");
    const policy = await authorizeExecution(Object.freeze(context));
    ensureOpen();
    if (!object(policy) || typeof policy.profileId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(policy.profileId) ||
        !text(policy.cwd, 4096) || !policy.cwd.startsWith("/") || (policy.config !== undefined && !(object(policy.config) && safeConfig(policy.config))) ||
        (policy.developerInstructions !== undefined && !text(policy.developerInstructions, 128000))) throw new CodexProtocolError("protected execution integration refused the policy");
    return policy;
  }
  async function prepareThread({ model, effort, resumeThreadId } = {}) {
    ensureOpen();
    if (preparing || thread) throw new CodexProtocolError("thread is already being prepared or prepared");
    if (resumeThreadId !== undefined && !nativeId(resumeThreadId)) throw new CodexProtocolError("invalid recorded thread identity");
    preparing = true;
    try {
      const policy = await authorize({ phase: "thread", model, effort, resumeThreadId });
      if (!(await supportsModel({ model, effort }))) throw new CodexProtocolError("configured model or effort is unavailable; no fallback");
      const response = await rpc(resumeThreadId === undefined ? "thread/start" : "thread/resume", {
        model, cwd: policy.cwd, permissions: policy.profileId, approvalPolicy: "never", approvalsReviewer: "user",
        allowProviderModelFallback: false, multiAgentMode: "explicitRequestOnly",
        ...(policy.config === undefined ? {} : { config: policy.config }),
        ...(policy.developerInstructions === undefined ? {} : { developerInstructions: policy.developerInstructions }),
        ...(resumeThreadId === undefined ? {} : { threadId: resumeThreadId }),
      });
      if (!object(response) || !nativeId(response.thread?.id) || (resumeThreadId !== undefined && response.thread.id !== resumeThreadId) || response.model !== model ||
          response.cwd !== policy.cwd || response.activePermissionProfile?.id !== policy.profileId || (response.reasoningEffort != null && response.reasoningEffort !== effort)) throw fail("thread acknowledgement differs from the requested identity, model or profile");
      thread = Object.freeze({ id: response.thread.id, model, effort, profileId: policy.profileId, cwd: policy.cwd });
      emit({ type: "model", model });
      return thread.id;
    } finally { preparing = false; }
  }
  async function startTurn(input) {
    ensureOpen();
    if (!thread || turnId || startingTurn) throw new CodexProtocolError("no prepared idle thread");
    if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > MAX_TURN_INPUT_BYTES) throw new CodexProtocolError("invalid turn input");
    if (seenTurns.size >= limits.turns) throw fail("turn identity limit reached; a fresh protocol session is required");
    startingTurn = true;
    try {
      const policy = await authorize({ phase: "turn", ...thread });
      if (policy.profileId !== thread.profileId || policy.cwd !== thread.cwd) throw new CodexProtocolError("turn policy changed; fresh admission is required");
      const response = await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: input }], model: thread.model, effort: thread.effort,
        cwd: thread.cwd, permissions: thread.profileId, approvalPolicy: "never", approvalsReviewer: "user", multiAgentMode: "explicitRequestOnly" });
      if (!object(response) || !nativeId(response.turn?.id) || !["inProgress", "completed", "failed", "interrupted"].includes(response.turn.status)) throw fail("invalid turn acknowledgement");
      if (seenTurns.has(response.turn.id)) throw fail("reused turn identity");
      seenTurns.add(response.turn.id);
      turnId = response.turn.id;
      endedTurn = null;
      startingTurn = false;
      for (const event of earlyEvents.splice(0)) notification(event.method, event.params);
      if (response.turn.status !== "inProgress") notification("turn/completed", { threadId: thread.id, turn: response.turn });
      ensureOpen();
      return response.turn.id;
    } finally { startingTurn = false; }
  }
  function takeQuestion(publicId) {
    ensureOpen();
    const question = questions.get(publicId);
    if (!question || question.turnId !== turnId || interrupting) throw new CodexProtocolError("no pending question for the active turn");
    return question;
  }
  async function answerQuestion(publicId, answers) {
    const question = takeQuestion(publicId);
    const questionIds = question.questions.map((q) => q.id);
    if (!object(answers) || Object.keys(answers).length !== questionIds.length || Object.keys(answers).some((answerId) => !questionIds.includes(answerId)) ||
        Object.values(answers).some((a) => !object(a) || Object.keys(a).some((k) => k !== "answers") || !Array.isArray(a.answers) || a.answers.length < 1 || a.answers.length > 8 || a.answers.some((value) => !text(value, 2048) || hasSecret(value)))) throw new CodexProtocolError("invalid question answers");
    questions.delete(publicId);
    clearTimeout(question.timer);
    send({ id: question.nativeId, result: { answers } });
  }
  async function rejectQuestion(publicId) {
    const question = takeQuestion(publicId);
    questions.delete(publicId);
    clearTimeout(question.timer);
    errorReply(question.nativeId, -32000, "Question declined by the bridge");
  }
  async function interrupt() {
    ensureOpen();
    if (!turnId || interrupting) return false;
    interrupting = true;
    discardQuestions("Turn interrupted");
    try { await rpc("turn/interrupt", { threadId: thread.id, turnId }); } catch (err) { interrupting = false; throw err; }
    return true;
  }

  return {
    feed, initialize, supportsModel, prepareThread, startTurn, answerQuestion, rejectQuestion, interrupt,
    close: () => fail("closed"),
    end: () => fail(buffer.length ? "transport ended with a partial frame" : "transport ended"),
    state: () => ({ initialized, closed: closed !== null, threadId: thread?.id ?? null, turnId, pending: pending.size, questions: questions.size }),
    events: { [Symbol.asyncIterator]() { return { next() {
      if (events.length) return Promise.resolve({ value: events.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => readers.push(resolve));
    } }; } },
  };
}

// Wires a child already spawned as `codex app-server --stdio` (stdio piped) to a protocol. The child is
// killed when the protocol closes and the protocol closes when the child's stdout ends or it fails.
export function openCodexAppServer({ child, killGraceMs = 2000, ...options }) {
  const protocol = createCodexProtocol({
    ...options,
    write: (line) => new Promise((resolve, reject) => child.stdin.write(line, (err) => (err ? reject(err) : resolve()))),
    close: () => {
      child.stdin.destroy();
      child.kill("SIGTERM");
      const hard = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      hard.unref();
      child.once("close", () => clearTimeout(hard));
    },
  });
  child.stdin.on("error", () => protocol.close());
  child.stdout.on("data", protocol.feed);
  child.stdout.on("end", protocol.end);
  child.on("error", protocol.close);
  return protocol;
}
