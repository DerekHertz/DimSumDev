// den-mvp/89: the claims the bridge holds for Runs that are live, kept in a small file so a boot after a hard crash (a kill,
// a freeze) can give them back. No Run survives its bridge, but a second bridge on the same root (PORT=<other>) shares the file,
// so each entry names the process that made it and only an entry whose process is gone is the dead bridge's to give back.
// An entry is { id, ref, project, role, pid }, added once the board has claimed and removed once it has released.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createRunClaims(file) {
  let chain = Promise.resolve();
  const read = async () => {
    try {
      const rows = JSON.parse(await readFile(file, "utf8"));
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };
  const change = (fn) => {
    const next = chain.then(async () => {
      const rows = fn(await read());
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(rows));
      await rename(tmp, file);
    });
    chain = next.catch(() => {});
    return next;
  };
  return {
    list: () => chain.then(read),
    add: (entry) => change((rows) => [...rows.filter((r) => r.id !== entry.id), { ...entry, pid: process.pid }]),
    remove: (id) => change((rows) => rows.filter((r) => r.id !== id)),
  };
}

// An entry with no pid predates the field, and no bridge of that kind is running.
export function ownerGone({ pid }) {
  if (!Number.isInteger(pid)) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code !== "EPERM";
  }
}
