// den-mvp/88 (ADR 0027 decision 4): the work order file. Its "## Order" section is one list item per ticket, in order:
//   - <feature>/<NN>   or   - <feature>/<NN> not-beside: <ref>[, <ref>...]
// Blank lines are allowed there; any other line is an OrderError naming it. Everything outside the section is prose.
export class OrderError extends Error {}

const REF = "[A-Za-z0-9._-]+\\/\\d+";
const ENTRY = new RegExp(`^- (${REF})(?: not-beside: (.*))?$`);
const ONE_REF = new RegExp(`^${REF}$`);

export function parseOrder(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => /^## Order\s*$/.test(l));
  if (start < 0) throw new OrderError("the work order has no '## Order' section");
  const entries = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const line = lines[i].trimEnd();
    if (!line) continue;
    const bad = () => new OrderError(`line ${i + 1} of the work order is not '- feature/NN [not-beside: feature/NN, ...]': ${line}`);
    const m = ENTRY.exec(line);
    if (!m) throw bad();
    const notBeside = m[2] === undefined ? [] : m[2].split(",").map((s) => s.trim());
    if (notBeside.some((r) => !ONE_REF.test(r))) throw bad();
    if (entries.some((e) => e.ref === m[1])) throw new OrderError(`line ${i + 1}: ${m[1]} is in the order twice`);
    entries.push({ ref: m[1], notBeside });
  }
  return { entries };
}
