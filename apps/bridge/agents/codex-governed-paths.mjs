import { lstatSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';

// Native read-only bind mounts need real targets. Keep their policy unchanged.
export function prepareGovernedPaths(worktree, entries) {
  const created = [];
  const inspect = file => { try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const cleanup = () => {
    for (const item of [...created].reverse()) {
      try {
        const now = inspect(item.file);
        if (!now || now.ino !== item.ino || now.dev !== item.dev || now.isSymbolicLink()) continue;
        if (now.isDirectory()) rmdirSync(item.file); // Only empty directories we created.
        else if (now.isFile() && now.size === 0 && (now.mode & 0o777) === 0o400) unlinkSync(item.file);
      } catch { /* Changed content, a nonempty directory or another owner is retained. */ }
    }
  };
  function ensure(relative, directory) {
    const file = path.join(worktree, relative);
    const before = inspect(file);
    if (before?.isSymbolicLink() || (directory && before && !before.isDirectory())) throw new Error('governed mount target traverses a symlink or non-directory');
    if (before) return;
    try {
      if (directory) mkdirSync(file, { mode: 0o700 });
      else writeFileSync(file, '', { flag: 'wx', mode: 0o400 });
      created.push({ file, ...lstatSync(file) });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const raced = inspect(file);
      if (!raced || raced.isSymbolicLink() || (directory && !raced.isDirectory())) throw error;
    }
  }
  try {
    if (lstatSync(worktree).isSymbolicLink()) throw new Error('governed worktree cannot be a symlink');
    for (const entry of entries) {
      const relative = entry.replace(/\/\*\*$/, '');
      if (path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('invalid governed mount target');
      const parts = relative.split('/');
      for (let n = 1; n < parts.length; n++) ensure(parts.slice(0, n).join('/'), true);
      // Existing .git can be a worktree pointer file even when the rule also ends in /**.
      if (!inspect(path.join(worktree, relative))) ensure(relative, entry.endsWith('/**'));
      else if (inspect(path.join(worktree, relative)).isSymbolicLink()) throw new Error('governed mount target is a symlink');
    }
    return cleanup;
  } catch (error) { cleanup(); throw error; }
}
