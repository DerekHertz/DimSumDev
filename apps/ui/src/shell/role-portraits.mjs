// Literal local URLs let the asset graph verify every runtime portrait.
export const ROLE_PORTRAITS = Object.freeze({
  orchestrator:'/den/portraits/bao-jade.webp',
  product:'/den/portraits/product.webp',
  architect:'/den/portraits/architect.webp',
  // team-and-den-ux/23: species portraits; both runtimes share the body (labels tell them apart). The old
  // panda portraits were removed (unreferenced files fail reachability); rollback is a git revert.
  developer:'/den/portraits/developer-red-panda.webp',
  scout:'/den/portraits/scout.webp',
  runner:'/den/portraits/runner.webp',
  debugger:'/den/portraits/debugger.webp',
  qa:'/den/portraits/qa.webp',
  security:'/den/portraits/security.webp',
  designer:'/den/portraits/designer.webp',
  herald:'/den/portraits/herald.webp',
  'release-manager':'/den/portraits/release-manager.webp',
  'code-reviewer':'/den/portraits/code-reviewer.webp',
  sre:'/den/portraits/sre.webp',
  'technical-writer':'/den/portraits/technical-writer-cloud-dragon.webp',
  'knowledge-keeper':'/den/portraits/knowledge-keeper.webp',
  'docs-writer':'/den/portraits/docs-writer.webp',
  'stem-cub':'/den/portraits/stem-cub.webp',
  "codex:orchestrator":"/den/portraits/codex-orchestrator.webp",
  "codex:product":"/den/portraits/codex-product.webp",
  "codex:architect":"/den/portraits/codex-architect.webp",
  "codex:developer":"/den/portraits/developer-red-panda.webp",
  "codex:scout":"/den/portraits/codex-scout.webp",
  "codex:runner":"/den/portraits/codex-runner.webp",
  "codex:qa":"/den/portraits/codex-qa.webp",
  "codex:security":"/den/portraits/codex-security.webp",
  "codex:designer":"/den/portraits/codex-designer.webp",
  "codex:herald":"/den/portraits/codex-herald.webp",
  'codex:code-reviewer':'/den/portraits/codex-code-reviewer.webp',
  'codex:release-manager':'/den/portraits/codex-release-manager.webp',
  'codex:sre':'/den/portraits/codex-sre.webp',
  'codex:technical-writer':'/den/portraits/technical-writer-cloud-dragon.webp',
});

// Retained until the user accepts Bao. The cached portrait can fail independently
// of the model; the old art keeps its fixed-size space and accessible role label.
export const ROLE_PORTRAIT_FALLBACKS = Object.freeze({orchestrator:'/den/portraits/orchestrator.webp'});
