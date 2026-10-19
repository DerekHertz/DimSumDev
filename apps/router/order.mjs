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

// The order text with `ref` ("fx/01-slug" or "fx/01") listed last, or null when it is listed already. A missing file (an empty
// text) or one without the section gains it. An approval in the den adds the ticket here, so the router can start it.
export function appendToOrder(text, ref) {
  const m = /^([A-Za-z0-9._-]+)\/(\d+)/.exec(String(ref));
  if (!m) throw new OrderError(`not a ticket ref: ${ref}`);
  const same = (r) => r.split("/")[0] === m[1] && Number(r.split("/")[1]) === Number(m[2]);
  const entry = `- ${m[1]}/${m[2]}`;
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => /^## Order\s*$/.test(l));
  if (start < 0) return `${String(text).trimEnd()}${text.trim() ? "\n\n" : ""}## Order\n${entry}\n`;
  if (parseOrder(text).entries.some((e) => same(e.ref))) return null;
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  let last = end;
  while (last > start + 1 && !lines[last - 1].trim()) last--;
  lines.splice(last, 0, entry);
  return lines.join("\n");
}
