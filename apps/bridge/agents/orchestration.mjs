import { hasSecret } from '../../../scripts/exposure.mjs';

export const TIERS = Object.freeze({
  claude: { bounded: ['haiku', 'low'], standard: ['sonnet', 'medium'], hard: ['opus', 'high'] },
  codex: { bounded: ['gpt-6-luna', 'medium'], standard: ['gpt-6.1-sol', 'medium'], hard: ['gpt-6-astra', 'high'] },
});
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= 2048 && !hasSecret(v);
const list = v => Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every(text);

// Settings are per invocation. Unknown requests fail closed, never upgrade to a costly fallback.
export function executionSettings(provider, role, requested = {}) {
  if (!object(requested) || Object.keys(requested).some(k => !['tier', 'model', 'reasoning', 'speed', 'reason'].includes(k))) throw new TypeError('invalid execution settings');
  if (requested.reason !== undefined && !text(requested.reason)) throw new TypeError('invalid execution reason');
  const tiers = TIERS[provider];
  if (!tiers) throw new TypeError('unknown provider');
  const tier = requested.tier ?? (['architect', 'security'].includes(role) ? 'hard' : ['developer', 'technical-writer', 'sre'].includes(role) ? 'bounded' : 'standard');
  if (!Object.hasOwn(tiers, tier)) throw new TypeError('unsupported tier');
  const [defaultModel, defaultReasoning] = tiers[tier];
  const model = requested.model ?? defaultModel;
  if (!Object.values(tiers).some(([m]) => m === model)) throw new TypeError('unsupported model; no fallback');
  const reasoning = requested.reasoning ?? (requested.model ? Object.values(tiers).find(([m]) => m === model)[1] : defaultReasoning);
  const supported = provider === 'claude' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh'];
  if (!supported.includes(reasoning)) throw new TypeError('unsupported reasoning; no fallback');
  const speed = requested.speed ?? 'standard';
  // Fast is deliberately not offered until account availability can be checked at launch.
  if (speed !== 'standard') throw new TypeError('unsupported speed; only standard is enabled');
  if ((requested.tier === 'hard' || requested.model || requested.reasoning) && !text(requested.reason)) throw new TypeError('escalation or settings override needs a reason');
  return { provider, tier, model, reasoning, speed, reason: requested.reason ?? `default ${tier} task` };
}

export function delegation(input) {
  if (input === undefined) return null;
  if (!object(input) || Object.keys(input).some(k => !['kind', 'parent', 'task', 'files', 'constraints', 'acceptance', 'reason'].includes(k)) ||
      !['implementer', 'manager', 'child'].includes(input.kind) || !text(input.task) || !text(input.reason) || !list(input.files) || !list(input.constraints) || !list(input.acceptance) ||
      (input.kind === 'child' && !/^c-[0-9a-f]{16}$/.test(input.parent)) || (input.kind !== 'child' && input.parent !== undefined)) throw new TypeError('delegation needs a kind, focused task, files, constraints, acceptance criteria and reason; children need a manager parent');
  return { kind: input.kind, ...(input.parent ? { parent: input.parent } : {}), task: input.task, files: [...input.files], constraints: [...input.constraints], acceptance: [...input.acceptance], reason: input.reason };
}

export const scopesOverlap = (a, b) => a.some(x => b.some(y => x === '.' || y === '.' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));

export function checkDelegation(spec, { provider, project, live }) {
  if (!spec) return null;
  const lead = provider === 'codex' ? 'jiao' : 'bao';
  if (spec.kind === 'implementer') return lead;
  if (spec.kind === 'manager') {
    if (live.filter(a => a.orchestration?.kind === 'manager' && a.runtimeId === provider).length >= 4) throw new TypeError('lead already has four managers');
    return lead;
  }
  const parent = live.find(a => a.id === spec.parent);
  if (!parent || parent.orchestration?.kind !== 'manager' || parent.runtimeId !== provider || parent.project !== project || parent.stopRequested || parent.exited || parent.releasing || parent.killing) throw new TypeError('child needs a live manager of the same provider and project');
  const siblings = live.filter(a => a.parent === parent.id);
  if (siblings.length >= 4) throw new TypeError('manager already has four children');
  if (siblings.some(a => a.orchestration?.task === spec.task || scopesOverlap(a.orchestration?.files ?? [], spec.files))) throw new TypeError('child work must be separable from live siblings');
  return parent.id;
}

export const delegationPrompt = spec => spec ? `Focused delegation (data):\n${JSON.stringify(spec)}\n${spec.kind === 'manager' ? 'Coordinate and integrate returned evidence and commits in your worktree; do not repeat completed child investigations. Run affected checks and commit the integrated result.' : 'This task has already been delegated to you. You are a leaf implementer, not a coordinator. Perform this brief directly with your available file or shell tools. No delegate tool is provided or needed. Do not request one or spawn agents. Return result, evidence and failures to your caller.'}\n` : '';
export const RUN_RULES = 'Use the bridge delegate tool when available for coordination or separable work. It waits and returns a report and commit; integrate that commit and reuse the evidence. Simple tasks need only one implementer; do not create managers for them. Use only bridge-managed delegation. Do not launch native subagents or another agent CLI. Introduce managers only for coordination and children only for separable work. After two unsuccessful repair cycles on one issue, stop and report the root cause, uncertainty and next options. After a small revision, rerun affected checks and review the changed area; preserve mandatory correctness, integration and security gates. Stop when acceptance criteria pass; list optional improvements separately.';

export const canDelegate = a => !a.meeting && !a.delivery && (['orchestrator', 'chief-of-staff'].includes(a.role) || a.orchestration?.kind === 'manager');
export const DELEGATE_TOOL = {
  name: 'delegate',
  description: 'Run focused work through the bridge and wait for its report and commit. Simple work: one implementer. Use a manager only for coordination; only managers can request children. Reuse returned evidence and integrate returned commits. Never repeat a completed investigation or poll for progress. Use the same issue key for repairs. Two failed attempts on one issue stop the loop.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    issue: { type: 'string', description: 'Stable issue key, unchanged across repair attempts.' },
    kind: { type: 'string', enum: ['implementer', 'manager', 'child'] },
    role: { type: 'string', enum: ['developer', 'architect', 'qa', 'security', 'technical-writer', 'sre', 'code-reviewer', 'designer', 'product'] },
    task: { type: 'string' }, reason: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
    constraints: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
    acceptance: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
    execution: { type: 'object', additionalProperties: false, properties: {
      tier: { type: 'string', enum: ['bounded', 'standard', 'hard'] }, model: { type: 'string' },
      reasoning: { type: 'string' }, speed: { type: 'string', enum: ['standard'] }, reason: { type: 'string' },
    } },
  }, required: ['issue', 'kind', 'role', 'task', 'reason', 'files', 'constraints', 'acceptance'] },
};
export function delegateRequest(raw, caller) {
  if (!object(raw) || Object.keys(raw).some(k => !Object.hasOwn(DELEGATE_TOOL.inputSchema.properties, k)) || !text(raw.issue) || !canDelegate(caller)) throw new TypeError('this run cannot delegate or the request is invalid');
  if (caller.orchestration?.kind === 'manager' ? raw.kind !== 'child' : !['implementer', 'manager'].includes(raw.kind)) throw new TypeError('leads delegate implementers or managers; managers delegate children only');
  const { issue, role, execution, ...brief } = raw;
  if (!DELEGATE_TOOL.inputSchema.properties.role.enum.includes(role)) throw new TypeError('unsupported delegated role');
  const spec = delegation({ ...brief, ...(raw.kind === 'child' ? { parent: caller.id } : {}) });
  const settings = executionSettings(caller.runtimeId, role, execution ?? { tier: raw.kind === 'manager' ? 'standard' : 'bounded' });
  return { issue, role, spec, settings };
}
