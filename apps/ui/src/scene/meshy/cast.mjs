// team-and-den-ux/25-35: which character a role wears. Claude and Codex share a species for every
// role except the orchestrator, where Bao is Claude and Jiao is Codex. Species convey no authority.
export const CAST = Object.freeze({
  orchestrator: Object.freeze({ claude: 'bao', codex: 'jiao' }),
  product: 'fox', architect: 'crane', designer: 'deer', 'code-reviewer': 'lion', qa: 'otter',
  security: 'pangolin', 'release-manager': 'lucky-cat', sre: 'tortoise', runner: 'golden-monkey',
});

/** The character id a role's runtime wears, or undefined for a role outside the cast (developer, technical-writer, visitors). */
export function castCharacterId(role, runtime = 'claude') {
  const entry = CAST[role];
  return typeof entry === 'string' ? entry : entry?.[runtime];
}
