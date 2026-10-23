// den-mvp/89: the claims the bridge holds for Runs that are live, kept in a small file so a boot after a hard crash (a kill,
// a freeze) can give them back: a claim with no live run is the bridge's own, because no Run survives the bridge.
// An entry is { id, ref, project, role }, added once the board has claimed and removed once it has released.
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
      await writeFile(`${file}.tmp`, JSON.stringify(rows));
      await rename(`${file}.tmp`, file);
    });
    chain = next.catch(() => {});
    return next;
  };
  return {
    list: () => chain.then(read),
    add: (entry) => change((rows) => [...rows.filter((r) => r.id !== entry.id), entry]),
    remove: (id) => change((rows) => rows.filter((r) => r.id !== id)),
  };
}
