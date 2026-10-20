import { cleanText } from '../../../shared/safe-text.mjs';
import { sourceKey } from '../../../shared/transcript-source.mjs';
import { DESK_REF } from '../../../bridge/agents/policy.mjs';

const BUDGET = 320;
const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
// Standalone runtime notices sometimes arrive as assistant text. Match whole
// notices only, so an agent's explanation of an actual blocker remains visible.
const NOTICE = /^(?:\[Request interrupted by user(?: for tool use)?\]|\[Tool use rejected by user\]|Waiting for (?:user )?(?:permission|approval)|Reconnecting|Connection (?:lost|restored))[. …!]*$/i;

// Only presentation markup is removed. This is an excerpt of one recorded message,
// never a synthesized claim. Sanitize the full original before extraction or clipping.
function plainText(value) {
  if (typeof value !== 'string') return '';
  const extracted = cleanText(value)
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, '')
    .replace(/(`+)([^`]*?)\1/g, '$2')
    .replace(/(\*\*|__|~~)([\s\S]*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?;:]|$)/g, '$1$2')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\s+/g, ' ').trim();
  return cleanText(extracted); // Removing markup can join a previously split token.
}

/** Pure projection of already-loaded, durably attributed messages for one run. */
export function transcriptSummary(entries, scope) {
  if (!sourceKey({ ...scope, entryId: 0 })) return { task: null, update: null };
  const scoped = (Array.isArray(entries) ? entries : []).filter(e => {
    const s = e?.source;
    return sourceKey(s) &&
      ['project', 'runtime', 'role', 'runId'].every(k => s[k] === scope[k]) &&
      (e.runId === undefined || e.runId === scope.runId) && e.id === s.entryId;
  });
  const candidates = scoped.filter(e => e.kind === 'message');
  const counts = new Map();
  for (const e of candidates) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
  const visible = candidates.filter(e => counts.get(e.id) === 1 && !e.hidden && !e.internal &&
    !['analysis', 'reasoning', 'tool', 'system'].includes(e.channel) && !e.boilerplate);
  // Follow-up launches record their initiating text at entry 1. A direct run can
  // also receive an immediate message at 1, so require recorded launch provenance.
  const marker = scoped.find(e => e.kind === 'run' && e.id === 0);
  const resumeOf = scope.resumeOf ?? marker?.resumeOf;
  const initiated = typeof resumeOf === 'string' && resumeOf.length > 0 || scope.ref === DESK_REF || marker?.ref === DESK_REF;
  const taskEntry = initiated ? visible.find(e => e.id === 1 && e.role === 'user') : null;
  const updateEntry = visible.filter(e => e.role === 'agent' && plainText(e.text) && !NOTICE.test(plainText(e.text))).sort((a, b) => b.id - a.id)[0];
  const field = e => {
    const text = plainText(e?.text);
    if (!text) return null;
    const { project, runtime, role, runId, entryId } = e.source;
    return { text, source: { project, runtime, role, runId, entryId } };
  };
  const task = field(taskEntry), update = field(updateEntry);
  const taskMax = update ? Math.max(BUDGET / 2, BUDGET - update.text.length) : BUDGET;
  const updateMax = task ? Math.max(BUDGET / 2, BUDGET - task.text.length) : BUDGET;
  return {
    task: task ? { ...task, text: clip(task.text, taskMax) } : null,
    update: update ? { ...update, text: clip(update.text, updateMax) } : null,
  };
}
