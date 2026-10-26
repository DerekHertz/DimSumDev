// multi-project/01 (ADR 0021 Amendment 7 decision 25): the one place a project's Board is made. `get(slug)` returns the Board of a
// project (the markdown board of a `.scratch/` tree, or the GitHub Issues board of its registry row), and the same instance every
// time: the GitHub adapter serializes its claims per instance, so a second instance would break the one-holder guarantee.
//
// A Board is { list, read, frontier, create, setStatus, claim, claimForHandoff, handoff, drop, resolve } over normalized tickets
// { ref, title, type, status, priority, blockedBy, holder, text? } (markdown adds feature, nn, goal, blockedReason and mtimeMs,
// which only the snapshot overlay reads). `exec` is the test seam for `gh`.
import { boardFor } from "./github-issues.mjs";
import { createMarkdownBoard } from "./markdown-board.mjs";

export function createProjectBoards({ projects, exec } = {}) {
  const byRoot = new Map(); // root + board row -> Board
  const bySlug = new Map(); // slug -> Board, for peek
  const build = (project) => {
    const key = `${project.root}\0${project.board?.kind ?? "markdown"}\0${project.board?.repo ?? ""}`;
    let board = byRoot.get(key);
    if (!board) {
      board = boardFor(project, project.board, exec ? { exec } : {}) ?? createMarkdownBoard(project.root);
      byRoot.set(key, board);
    }
    bySlug.set(project.slug, board);
    return board;
  };
  return {
    /** -> the project's Board, or null for a slug that is not onboarded (or whose start check now fails). */
    async get(slug) {
      const project = await projects.get(slug);
      return project ? build(project) : null;
    },
    /** The Board `get` made for this slug before, with no start check; `get` when there is none yet. For the hub's frequent reads. */
    async peek(slug) {
      return bySlug.get(slug) ?? this.get(slug);
    },
  };
}
