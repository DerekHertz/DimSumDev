import { randomBytes } from 'node:crypto';
import { hasSecret } from '../../../scripts/exposure.mjs';
import { REF_RE } from '../agents/policy.mjs';
import { SPECIALISTS, SEATS_MAX, TOPIC_MAX_BYTES } from './types.mjs';
import { parseBrief, optionText } from './plan.mjs';
import { meetingNote } from './prompts.mjs';
import { validProject } from '../agents/identity.mjs';

const refuse = (status, error) => ({ ok: false, status, error });
const textOf = value => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= TOPIC_MAX_BYTES && !hasSecret(value) ? value.trim() : null;
const token = () => randomBytes(8).toString('hex');
const rolesOK = roles => Array.isArray(roles) && roles.length > 0 && roles.length <= SEATS_MAX && new Set(roles).size === roles.length && roles.every(r => SPECIALISTS.includes(r));
export const estimateWork = (depth = 'quick', effort = 'medium') => (depth === 'dig-in' ? 0.9 : 0.4) * (effort === 'high' ? 2 : 1);
export const estimateSetup = (roles, depth) => ({ low: (roles.length + 1) * (depth === 'dig-in' ? 0.2 : 0.08), high: (roles.length + 1) * estimateWork(depth), label: 'Planning estimate for opening takes and one moderation pass; follow-ups add work. Actual billing may differ.' });
export function createMeetings({ host, log, store, readTicket, readProject = async project => project === 'den', proposeTicket, recordUrl = m => `/?meeting=${m.id}&project=${m.project}`, claimTicket = async () => {}, releaseTicket = async () => {}, onChange = () => {}, now = () => Date.now() }) {
  const meetings = new Map();
  let closing = false;
  const stamp = () => new Date(now()).toISOString();
  const view = m => structuredClone(Object.fromEntries(Object.entries(m).filter(([key]) => key !== 'chain')));
  const metadata = m => ({ schema: 2, id: m.id, ref: m.ref, project: m.project, title: 'Private meeting', moderator: m.moderator, chair: m.chair, state: m.state, seats: m.seats, round: m.round, live: m.live ? { runId: m.live.runId, role: m.live.role, part: m.live.part, estimate: m.live.estimate } : null, budget: m.budget, spent: m.spent, estimatedSpent: m.estimatedSpent, startedAt: m.startedAt, updatedAt: m.updatedAt });
  const event = (m, kind, actor, more = {}) => {
    const e = { id: `e-${token()}`, at: stamp(), round: m.round, version: m.events.length + 1, kind, actor, ...more };
    m.events.push(e); return e;
  };
  const save = async m => { m.updatedAt = new Date(Math.max(now(), (Date.parse(m.updatedAt) || 0) + 1)).toISOString(); await log.save(view(m)); if (m.held && ['ready-for-review', 'ended'].includes(m.state)) { await releaseTicket(m); m.held = false; await log.save(view(m)); } onChange({ type: 'meeting', meeting: metadata(m) }); };
  const status = (m, state, reason = '') => { m.state = state; event(m, 'status', m.moderator, { state, text: reason }); };
  const enqueue = (m, fn) => {
    const next = (m.chain ?? Promise.resolve()).then(fn).catch(async err => { if (m.state !== 'ended') status(m, 'paused', 'Storage or runtime failed. No further work starts.'); await save(m).catch(() => {}); return refuse(503, 'Meeting operation could not be durably completed. Review the private record before retrying.'); });
    m.chain = next; return next;
  };
  const ready = (async () => {
    for (let m of await log.replay()) {
      if (m.schema !== 2) {
        const legacy = structuredClone(m);
        const events = await store?.history(m) ?? [];
        m = { ...m, schema: 2, moderator: 'bao', project: m.project ?? 'den', state: ['closed', 'decided'].includes(m.state) ? 'ended' : 'paused', depth: 'quick', budget: 2, spent: 0, estimatedSpent: 0, queue: [], round: Math.max(1, m.briefs), seats: m.seats.map(s => ({ ...s, active: true })), events, questions: [], proposals: [], decisions: m.decisions.map(d => ({ text: d.title, sourceId: null, legacyTicket: d.ticket })), summary: (await store?.read(m))?.summary ?? '', legacy };
        event(m, 'status', 'bao', { state: m.state, text: 'Imported legacy record. No automatic expiry; opening never resumes discussion.' }); await save(m);
      }
      if (m.pendingWork && !m.live) {
        m.estimatedSpent += m.pendingWork.estimate;
        event(m, 'failure', m.pendingWork.part === 'chair' ? m.moderator : m.pendingWork.role, { text: 'Bridge restarted during launch. Work and billing are uncertain; the reserved allowance still counts.', estimate: m.pendingWork.estimate, cost: null });
        m.pendingWork = null;
        if (m.state !== 'ended') status(m, 'paused', 'Review the interrupted launch before explicitly resuming.');
        await save(m);
      }
      if (m.live) {
        const lost = m.live;
        m.estimatedSpent += lost.estimate ?? 0;
        event(m, 'failure', lost.part === 'chair' ? m.moderator : lost.role, { runId: lost.runId, sourceId: lost.sourceId ?? null, cost: null, estimate: lost.estimate ?? null, text: 'Bridge restarted before the response finished. Billing is unknown; its allowance still counts.' });
        const seat = m.seats.find(s => s.role === lost.role); if (seat) seat.status = 'failed';
        if (m.state !== 'ended') m.queue.unshift({ role: lost.role, part: lost.part, effort: lost.effort ?? 'medium', sourceId: lost.sourceId ?? null, context: true });
        m.live = null;
        if (m.state !== 'ended') status(m, 'paused', 'Bridge restarted. Resume explicitly after reconciling the interrupted attempt.');
        await save(m);
      } else if (['running', 'pausing'].includes(m.state)) { status(m, 'paused', 'Bridge restarted. Resume explicitly to continue.'); await save(m); }
      meetings.set(m.id, m);
    }
  })();
  const used = m => m.spent + m.estimatedSpent;
  const recordLink = recordUrl;
  const answer = m => ({ ok: true, status: 202, meeting: view(m) });
  const mutate = async (id, fn) => { await ready; const m = meetings.get(id); if (!m) return refuse(404, 'No such meeting'); return enqueue(m, async () => { const result = await fn(m); return result ?? answer(m); }); };
  function nextWork(m) {
    if (m.queue.length) return m.queue[0];
    const role = m.seats.find(s => s.active !== false && s.status === 'waiting')?.role;
    return { role: role ?? 'chief-of-staff', part: role ? 'take' : 'chair', effort: 'medium' };
  }
  async function advance(m) {
    if (closing || m.state !== 'running' || m.live) return;
    if (m.ref && !m.held) { try { await claimTicket(m); m.held = true; } catch { status(m, 'paused', 'Task is held elsewhere'); return save(m); } }
    if (m.pendingRoles) {
      for (const seat of m.seats) { if (!seat.active && m.pendingRoles.includes(seat.role)) { seat.status = 'waiting'; seat.joined = true; } seat.active = m.pendingRoles.includes(seat.role); }
      for (const role of m.pendingRoles) if (!m.seats.some(s => s.role === role)) m.seats.push({ role, active: true, status: 'waiting', takes: 0, joined: true });
      m.queue = m.queue.filter(w => m.pendingRoles.includes(w.role)); m.pendingRoles = null;
      event(m, 'participants-applied', 'user');
    }
    for (const e of m.events.filter(e => e.appliesNext && !m.events.some(applied => applied.kind === 'redirect-applied' && applied.sourceId === e.id))) event(m, 'redirect-applied', m.moderator, { sourceId: e.id });
    const work = nextWork(m);
    const { role, part, effort } = work;
    const estimate = estimateWork(m.depth, effort);
    if (used(m) + estimate > m.budget + 1e-9) { m.budgetRequest = { estimate, role, effort, remaining: Math.max(0, m.budget - used(m)) }; status(m, 'waiting-budget', 'Approve a larger budget before the next run.'); return save(m); }
    const allDiscussion = m.events.filter(e => ['message', 'redirect', 'decision-answer'].includes(e.kind));
    const discussion = allDiscussion.filter((e, i) => i >= allDiscussion.length - 12 || e.id === work.sourceId);
    const takes = part === 'chair' || m.round > 1 || work.sourceId || m.seats.find(s => s.role === role)?.takes || m.seats.find(s => s.role === role)?.joined || work.context ? discussion.map(e => ({ role: `${e.actor} [${e.id}]`, text: e.text })) : [];
    const file = meetingNote({ part: takes.length ? 'chair' : 'take', ref: m.ref ?? '(standalone)', topic: m.topic, takes, followUp: work.instruction }) + `\n## Meeting settings\nDepth: ${m.depth}. ${m.depth === 'dig-in' ? 'Investigate relevant code and docs; cite evidence.' : 'Concise independent views; read code when needed.'}\nEffort: ${effort}.\nCurrent summary (quoted):\n> ${m.summary.replaceAll('\n', '\n> ')}\nReply source: ${work.sourceId ?? 'none'}\nUser redirects (latest six, quoted):\n` + m.events.filter(e => e.kind === 'redirect').slice(-6).map(e => `> ${e.text.replaceAll('\n', '\n> ')}`).join('\n') + `\nRequest (quoted):\n> ${(work.instruction ?? 'Opening take or moderation').replaceAll('\n', '\n> ')}\nEarlier history remains in the permanent private record.\n`;
    m.pendingWork = { role, part, effort, estimate }; await save(m);
    const started = await host.start({ ref: `meetings/00-${m.id}`, project: m.project, runtime: m.moderator === 'jiao' ? 'codex' : 'claude', role, meeting: { part, file, effort, moderator: m.moderator, standalone: !m.ref, taskRef: m.ref } });
    m.pendingWork = null;
    if (!started.ok) { status(m, 'paused', started.error); return save(m); }
    if (m.queue[0] === work) m.queue.shift();
    m.live = { runId: started.agent.id, ...work, estimate };
    event(m, 'work-started', role, { runId: started.agent.id, estimate, effort, sourceId: work.sourceId ?? null }); await save(m);
  }
  async function start(input = {}) {
    await ready;
    const topic = textOf(input.topic);
    if (!topic || !rolesOK(input.roles)) return refuse(400, 'A topic and one to six distinct specialists are required.');
    if (input.ref !== undefined && !REF_RE.test(input.ref)) return refuse(400, 'Invalid task reference');
    const project = input.project ?? 'den';
    if (!validProject(project) || !await readProject(project)) return refuse(400, 'Choose an onboarded project');
    const ticket = input.ref ? await readTicket(input.ref, { project }) : null;
    if (input.ref && !ticket) return refuse(404, 'No such task');
    if (input.ref && [...meetings.values()].some(m => !m.suggestOnly && m.ref === input.ref && m.project === project && m.state !== 'ended')) return refuse(409, 'This task already has an open meeting');
    const moderator = input.moderator ?? ticket?.owner ?? 'bao';
    if (!['bao', 'jiao'].includes(moderator)) return refuse(400, 'Choose Bao or Jiao');
    const budget = input.budget ?? 2;
    if (!Number.isFinite(budget) || budget < 0) return refuse(400, 'Budget must be a nonnegative dollar amount');
    if (input.depth !== undefined && !['quick', 'dig-in'].includes(input.depth)) return refuse(400, 'Choose Quick takes or Dig in');
    const original = input.continuedFrom ? meetings.get(input.continuedFrom) : null;
    if (input.continuedFrom && (!original || original.state !== 'ended' || original.project !== project)) return refuse(409, 'Continuation needs an ended meeting in this project');
    const carry = rows => rows.map(row => ({ ...structuredClone(row), sourceMeetingId: row.sourceMeetingId ?? original.id }));
    const m = { schema: 2, id: `m-${token()}`, ref: input.ref ?? null, project, topic, title: ticket?.title ?? topic.split('\n')[0].slice(0, 120), moderator, chair: 'chief-of-staff', depth: input.depth ?? 'quick', budget, spent: 0, estimatedSpent: 0, estimate: estimateSetup(input.roles, input.depth), queue: [], state: 'running', round: 1, seats: input.roles.map(role => ({ role, active: true, status: 'waiting', takes: 0 })), events: [], decisions: original ? carry(original.decisions) : [], questions: original ? carry(original.questions) : [], proposals: [], summary: original?.summary ?? '', continuedFrom: original?.id ?? null, live: null, startedAt: stamp(), updatedAt: stamp() };
    if (m.ref) { try { await claimTicket(m); m.held = true; m.ticketStatus = ticket.status; } catch { return refuse(409, 'The task is held by another run or meeting'); } }
    if (input.suggestOnly === true) { m.suggestOnly = true; m.seats = []; m.queue.push({ role: 'chief-of-staff', part: 'chair', effort: 'medium', instruction: 'Suggest up to six specialists with a reason each. Do not discuss yet.' }); }
    event(m, 'created', 'user'); meetings.set(m.id, m); await save(m); enqueue(m, () => advance(m));
    return { ok: true, status: 201, meeting: view(m) };
  }
  async function onEnd(run) {
    const m = [...meetings.values()].find(m => m.live?.runId === run.agentId);
    if (!m) return;
    return enqueue(m, async () => {
      const live = m.live; m.live = null;
      const seat = m.seats.find(s => s.role === live.role);
      const text = typeof run.report === 'string' && !hasSecret(run.report) ? run.report.slice(0, 64000) : '[Contribution unavailable]';
      const cost = Number.isFinite(run.costUsd) && run.costUsd >= 0 ? run.costUsd : null;
      if (cost !== null) m.spent += cost;
      else m.estimatedSpent += live.estimate;
      const success = run.state === 'done' && typeof run.report === 'string' && !!run.report.trim() && !hasSecret(run.report);
      const message = event(m, success ? 'message' : 'failure', live.part === 'chair' ? m.moderator : live.role, { text: success ? text : 'Contribution missing. Retry is subject to the budget.', runId: run.agentId, cost, estimate: cost === null ? live.estimate : null, part: live.part, sourceId: live.sourceId ?? null, tools: Array.isArray(run.tools) ? run.tools.filter(t => typeof t === 'string' && !hasSecret(t)).slice(0, 50) : [] });
      if (seat) { seat.status = success ? 'taken' : 'failed'; seat.takes += success ? 1 : 0; }
      const asked = success && seat ? /^Question for the user:\s*(.+)/im.exec(text)?.[1]?.trim() : null;
      if (asked && !/^(none|no|n\/a)[.!]?$/i.test(asked)) m.questions.push({ id: `q-${token()}`, question: asked, actor: live.role, confidence: /^Confidence:\s*(.+)/im.exec(text)?.[1]?.trim() ?? null, options: [], sourceIds: [message.id], required: [live.role], answer: null });
      const was = m.state;
      if (was === 'pausing') status(m, 'paused', 'Current response finished; no new work starts.');
      else if (was !== 'ended' && live.part === 'chair') {
        if (!success) status(m, 'paused', 'Moderator contribution missing; retry to continue.');
        else moderate(m, text, message.id);
      }
      if (was === 'ended') m.summary = closingSummary(m);
      await save(m); return advance(m);
    });
  }
  function moderate(m, text, sourceId) {
    let plan;
    try { plan = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* The legacy brief format remains readable. */ }
    if (!plan) {
      const brief = parseBrief(text);
      if (brief) plan = { action: 'decision', question: /^# Question\s*\n([^#]+)/m.exec(text)?.[1].trim() ?? m.topic, ...brief, options: brief.options.map(o => ({ ...o, tradeoff: optionText(text, o.key) })), required: m.seats.filter(s => s.active).map(s => s.role) };
      else if (/^SETTLED:/m.test(text)) plan = { action: 'settled', summary: text.replace(/^SETTLED:\s*/, '') };
    }
    if (!plan || !['decision', 'follow-up', 'settled', 'suggestions'].includes(plan.action)) { status(m, 'paused', 'Moderator response needs a valid discussion plan; Retry to request it again.'); return; }
    if (plan.action === 'follow-up') {
      const requests = Array.isArray(plan.requests) ? plan.requests : [];
      if (!requests.length || requests.length > SEATS_MAX || requests.some(w => !m.seats.some(s => s.active && s.role === w.role) || !textOf(w.instruction) || !['medium', 'high'].includes(w.effort ?? 'medium') || (w.effort === 'high' && !textOf(w.reason)) || !m.events.some(e => e.id === w.sourceId && e.kind === 'message'))) { status(m, 'paused', 'Moderator follow-up needs a participant, source message and escalation reason.'); return; }
      m.round++;
      for (const w of requests) {
        m.queue.push({ role: w.role, part: 'take', sourceId: w.sourceId, instruction: w.instruction, effort: w.effort ?? 'medium', context: true });
        if (w.effort === 'high') event(m, 'effort', m.moderator, { text: w.reason, role: w.role, effort: 'high', estimate: estimateWork(m.depth, 'high'), sourceId });
      }
      return;
    }
    if (plan.action === 'decision') {
      if (!textOf(plan.question) || !Array.isArray(plan.options) || plan.options.length < 2 || plan.options.length > 3 || plan.options.some((o, i) => o.key !== 'ABC'[i] || !textOf(o.title) || !textOf(o.tradeoff)) || !plan.options.some(o => o.key === plan.recommended)) { status(m, 'paused', 'Decision needs a question, recommendation and alternatives with tradeoffs.'); return; }
      const sources = Array.isArray(plan.sourceIds) ? plan.sourceIds.filter(id => m.events.some(e => e.id === id && e.kind === 'message')) : [];
      const q = { id: `q-${token()}`, question: plan.question, options: plan.options.map(o => ({ key: o.key, title: o.title, tradeoff: o.tradeoff })), recommended: plan.recommended, sourceIds: [...new Set([sourceId, ...sources])], required: Array.isArray(plan.required) ? plan.required.filter(r => SPECIALISTS.includes(r)) : m.seats.filter(s => s.active).map(s => s.role), answer: null };
      const prior = m.questions.findLast(question => question.sentBack && !question.revisedQuestionId);
      if (prior) prior.revisedQuestionId = q.id;
      m.questions.push(q);
      m.focusedQuestionId = q.id;
      const missing = q.required.filter(r => !m.seats.some(s => s.role === r && s.status === 'taken'));
      status(m, missing.length ? 'paused' : 'waiting-decision', missing.length ? `Decision blocked by missing input: ${missing.join(', ')}` : 'Only you can settle this question.'); return;
    }
    if (plan.action === 'suggestions') {
      m.suggestions = (Array.isArray(plan.specialists) ? plan.specialists : []).filter(s => SPECIALISTS.includes(s.role) && textOf(s.reason)).slice(0, SEATS_MAX).map(s => ({ role: s.role, reason: s.reason }));
      status(m, 'ready-for-review', 'Specialist suggestions ready. Adjust setup before starting discussion.'); return;
    }
    m.summary = typeof plan.summary === 'string' && !hasSecret(plan.summary) ? plan.summary.slice(0, 16000) : 'Discussion settled. Review the source discussion.';
    m.proposals = (Array.isArray(plan.followUps) ? plan.followUps : []).slice(0, 20).filter(p => textOf(p.title) && textOf(p.text)).map(p => ({ id: `p-${token()}`, title: p.title, text: p.text, sourceId }));
    event(m, 'summary', m.moderator, { text: m.summary, sourceId });
    status(m, 'ready-for-review', 'Settled. No further work starts.');
  }
  const closingSummary = m => [m.closingBase ?? (m.summary || m.topic), ...m.decisions.map(d => `Agreed: ${d.text}`), ...m.questions.filter(q => !q.answer).map(q => `Unanswered: ${q.question}`)].join('\n');
  const stop = id => mutate(id, async m => { if (m.state === 'ended') return refuse(409, 'Meeting ended'); status(m, m.live ? 'pausing' : 'paused', 'Pause requested; current work still counts.'); await save(m); });
  const resume = id => mutate(id, async m => { if (!['paused', 'ready-for-review'].includes(m.state)) return refuse(409, 'This meeting cannot be resumed'); if (m.ref && !m.held) { try { await claimTicket(m); m.held = true; } catch { return refuse(409, 'Task is held elsewhere'); } } status(m, 'running'); m.round++; await save(m); await advance(m); });
  const close = id => mutate(id, async m => { if (m.state === 'ended') return refuse(409, 'Meeting already ended'); status(m, 'ended'); m.closingBase = m.summary || m.topic; m.summary = closingSummary(m); event(m, 'summary', m.moderator, { text: m.summary, sourceIds: m.events.filter(e => e.kind === 'message').map(e => e.id) }); await save(m); if (m.live) await host.stop(m.live.runId); });
  const ask = (id, body = {}) => mutate(id, async m => {
    if (m.state === 'ended') return refuse(409, 'Continue this discussion in a new meeting');
    const text = textOf(body.text);
    if (!text || body.reask && !m.seats.some(s => s.active && s.role === body.reask)) return refuse(400, 'Write a redirect and choose a participant');
    if (body.sourceId && !m.events.some(e => e.id === body.sourceId && e.kind === 'message')) return refuse(400, 'Source message not found');
    let questionAnswer;
    if (body.questionId) {
      const q = m.questions.find(q => q.id === body.questionId && !q.answer);
      if (!q || q.options.length) return refuse(409, 'Use the focused decision controls for this question');
      const e = event(m, 'decision-answer', 'user', { text, questionId: q.id, sourceId: q.sourceIds[0] });
      questionAnswer = e;
      q.answer = { text, eventId: e.id }; m.decisions.push({ questionId: q.id, text, sourceId: e.id });
    }
    const redirect = questionAnswer ?? event(m, 'redirect', 'user', { text, sourceId: body.sourceId ?? null, appliesNext: true });
    if (body.reask) m.queue.push({ role: body.reask, part: 'take', instruction: text, sourceId: body.sourceId ?? redirect.id, effort: 'medium', context: true });
    if (['waiting-decision', 'ready-for-review'].includes(m.state)) { status(m, 'running'); m.round++; }
    await save(m); await advance(m);
  });
  const decide = (id, body = {}) => mutate(id, async m => {
    if (m.state !== 'waiting-decision') return refuse(409, 'No decision is ready for an answer');
    const q = m.questions.find(q => q.id === m.focusedQuestionId && !q.answer);
    if (body.questionId && body.questionId !== q?.id) return refuse(409, 'This question is not the current decision');
    const choice = q?.options.find(o => o.key === body.option);
    const text = textOf(body.text) ?? choice?.title;
    if (!q || (!body.sendBack && !text)) return refuse(400, 'Choose an option or write your answer');
    if (body.sendBack) {
      event(m, 'decision-sent-back', 'user', { questionId: q.id, text: textOf(body.text) ?? 'Revisit the recommendation', sourceIds: q.sourceIds });
      for (const role of q.required) m.queue.push({ role, part: 'take', effort: 'medium', sourceId: q.sourceIds[0], instruction: textOf(body.text) ?? `Revisit: ${q.question}`, context: true });
      q.sentBack = true;
    } else {
      const e = event(m, 'decision-answer', 'user', { text, questionId: q.id, sourceId: q.sourceIds[0] });
      q.answer = { text, eventId: e.id }; m.decisions.push({ questionId: q.id, text, sourceId: e.id });
    }
    status(m, 'running'); m.round++; await save(m); await advance(m);
  });
  const approveBudget = (id, body = {}) => mutate(id, async m => {
    if (m.state === 'ended' || !Number.isFinite(body.budget) || body.budget <= m.budget || body.budget < used(m)) return refuse(400, 'Approve a larger total budget');
    m.budget = body.budget; m.budgetRequest = null; event(m, 'budget-approved', 'user', { budget: m.budget });
    if (m.state === 'waiting-budget') status(m, 'running'); await save(m); await advance(m);
  });
  const retry = (id, body = {}) => mutate(id, async m => {
    if (m.live || m.state === 'ended') return refuse(409, 'Retry is unavailable');
    const seat = m.seats.find(s => s.role === body.role && s.active && s.status === 'failed');
    if (!seat && body.role !== 'chief-of-staff') return refuse(400, 'Choose a missing contribution');
    m.queue.push({ role: body.role, part: seat ? 'take' : 'chair', effort: 'medium', context: true });
    status(m, 'running'); event(m, 'retry', 'user', { role: body.role }); await save(m); await advance(m);
  });
  const participants = (id, body = {}) => mutate(id, async m => {
    if (m.state === 'ended' || !rolesOK(body.roles)) return refuse(400, 'Choose one to six specialists');
    m.pendingRoles = body.roles; m.estimate = estimateSetup(body.roles, m.depth);
    event(m, 'participants', 'user', { roles: body.roles, text: 'Applies next', appliesNext: true }); await save(m); await advance(m);
  });
  const preview = (id, body = {}) => mutate(id, async m => {
    if (!['ready-for-review', 'ended'].includes(m.state) || !Array.isArray(body.tickets) || !body.tickets.length || body.tickets.length > 20 || body.tickets.some(p => !textOf(p.title) || !textOf(p.text))) return refuse(400, 'Review and select valid follow-ups first');
    const tickets = body.tickets.map(p => ({ title: p.title.trim(), text: p.text.trim() + (p.includeRecord === false ? '' : `\n\nPrivate meeting record: ${recordLink(m)}`), project: m.project }));
    m.preview = { id: `preview-${token()}`, tickets }; await save(m); return { ok: true, status: 200, previewId: m.preview.id, tickets };
  });
  const publish = (id, body = {}) => mutate(id, async m => {
    if (body.approved !== true || !m.preview || body.previewId !== m.preview.id) return refuse(409, 'Explicit approval of the exact public preview is required');
    if (m.preview.published?.length === m.preview.tickets.length) return { ok: true, status: 200, tickets: m.preview.published };
    m.preview.published ??= [];
    for (const ticket of m.preview.tickets.slice(m.preview.published.length)) {
      const created = await proposeTicket({ ...ticket, status: 'ready-for-human', source: 'Explicitly approved meeting follow-up' });
      m.preview.published.push(created); event(m, 'ticket-created', 'user', { ref: created.ref, previewId: m.preview.id }); await save(m);
    }
    return { ok: true, status: 201, tickets: m.preview.published, meeting: view(m) };
  });
  const continueMeeting = id => mutate(id, m => m.state !== 'ended' ? refuse(409, 'End this meeting before continuing it') : { ok: true, status: 200, setup: { topic: m.topic, ...(m.ref ? { ref: m.ref } : {}), project: m.project, moderator: m.moderator, depth: m.depth, roles: m.seats.filter(s => s.active).map(s => s.role), budget: m.budget, continuedFrom: m.id } });
  async function read(id) { await ready; const m = meetings.get(id); return m ? { ok: true, status: 200, meeting: view(m), events: view(m).events, takes: m.seats.flatMap(s => { const e = m.events.findLast(e => e.actor === s.role && e.kind === 'message'); return e ? [{ role: s.role, n: s.takes, text: e.text }] : []; }), thread: [], topic: m.topic, summary: m.summary } : refuse(404, 'No such meeting'); }
  async function shutdown() { closing = true; await Promise.all([...meetings.values()].map(m => m.chain)); }
  return { ready, start, read, onEnd, stop, resume, close, ask, decide, approveBudget, retry, participants, preview, publish, continueMeeting, shutdown, snapshot: () => [...meetings.values()].map(view), publicSnapshot: () => [...meetings.values()].map(metadata) };
}
