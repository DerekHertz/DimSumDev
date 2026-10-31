// trust-ladder/01 (ADR 0032): the Profile, one lean/full setting that sets the org tiers and verifier count together.
// The table is the single source of those values; the delivery reads it on every run, so a flip
// needs no restart. It never holds a resource-group limit: limits.json is the wall and reads the same in both profiles.
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_PROFILE = "full";

// Tunable (first full-profile runs): full's leafTier, verifierLoopCap, splitAboveTokens and verifier counts are first guesses.
export const PROFILES = Object.freeze({
  lean: Object.freeze({
    leafTier: "haiku",
    verifiers: Object.freeze({ standard: 1, riskPath: 1, ui: 1 }),
    verifierLoopCap: 2,
    splitAboveTokens: 150000,
  }),
  full: Object.freeze({
    leafTier: "sonnet",
    verifiers: Object.freeze({ standard: 1, riskPath: 2, ui: 2 }),
    verifierLoopCap: 3,
    splitAboveTokens: null, // one outcome per ticket, no size guidance
  }),
});

// `file` holds the choice (absent: in memory only). The choice is read once and kept; set() is the only writer.
export function createProfile({ file, table = PROFILES } = {}) {
  const known = (name) => typeof name === "string" && Object.hasOwn(table, name);
  let current = DEFAULT_PROFILE;
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"))?.profile;
      if (known(saved)) current = saved;
    } catch {}
  }
  let writing = Promise.resolve(); // sets run one at a time, so the file and the memory end on the same choice
  const values = () => table[current];
  const view = () => ({ name: current, values: values() });
  return {
    name: () => current,
    values,
    view,
    set(name) {
      if (!known(name)) return Promise.reject(new Error("profile must be lean or full"));
      const run = writing.then(async () => {
        if (file) {
          await mkdir(path.dirname(file), { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          await writeFile(tmp, `${JSON.stringify({ profile: name })}\n`);
          await rename(tmp, file);
        }
        current = name;
        return view();
      });
      writing = run.catch(() => {});
      return run;
    },
  };
}
