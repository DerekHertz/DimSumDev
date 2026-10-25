import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync, symlinkSync, rmSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { prepareGovernedPaths } from './codex-governed-paths.mjs';

test('missing CI parents and read-only targets exist before native setup and retire without changing existing files', () => {
  const root = mkdtempSync(`${tmpdir()}/den-governed-`);
  try {
    writeFileSync(`${root}/.git`, 'gitdir: real-worktree-pointer\n');
    const retire = prepareGovernedPaths(root, ['.git', '.git/**', '.github/workflows/**', '.github/CODEOWNERS', 'apps/bridge/agents/limits.json']);
    assert.ok(lstatSync(`${root}/.github/workflows`).isDirectory());
    assert.equal(lstatSync(`${root}/.github/CODEOWNERS`).mode & 0o777, 0o400);
    assert.equal(lstatSync(`${root}/apps/bridge/agents/limits.json`).mode & 0o777, 0o400);
    retire();
    assert.equal(existsSync(`${root}/.github`), false);
    assert.equal(existsSync(`${root}/apps`), false);
    assert.equal(readFileSync(`${root}/.git`, 'utf8'), 'gitdir: real-worktree-pointer\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('symlink parents fail closed and partial scaffolding is removed', () => {
  const root = mkdtempSync(`${tmpdir()}/den-governed-`);
  const outside = mkdtempSync(`${tmpdir()}/den-governed-outside-`);
  try {
    symlinkSync(outside, `${root}/.github`);
    assert.throws(() => prepareGovernedPaths(root, ['new/file', '.github/CODEOWNERS']), /symlink/);
    assert.equal(existsSync(`${root}/new`), false);
    assert.equal(existsSync(`${outside}/CODEOWNERS`), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('cleanup retains changed content, replacement inodes and user files', () => {
  const root = mkdtempSync(`${tmpdir()}/den-governed-`);
  try {
    const retire = prepareGovernedPaths(root, ['.github/CODEOWNERS', 'existing/file', 'replacement.txt']);
    chmodSync(`${root}/.github/CODEOWNERS`, 0o600);
    writeFileSync(`${root}/.github/CODEOWNERS`, 'user content');
    writeFileSync(`${root}/existing/user.txt`, 'keep');
    writeFileSync(`${root}/replacement-source`, '', { mode: 0o400 });
    renameSync(`${root}/replacement-source`, `${root}/replacement.txt`);
    retire();
    assert.equal(readFileSync(`${root}/.github/CODEOWNERS`, 'utf8'), 'user content');
    assert.equal(readFileSync(`${root}/existing/user.txt`, 'utf8'), 'keep');
    assert.equal(existsSync(`${root}/existing/file`), false);
    assert.equal(existsSync(`${root}/replacement.txt`), true, 'a different inode is not our placeholder');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
