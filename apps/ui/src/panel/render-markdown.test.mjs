// dimsumden-ui-v0/09: the in-house handoff markdown parser (ADR 0011 decision 8, plus the 07 security forward:
// agent text is untrusted, the page carries gate buttons). Pure parse step; the .jsx maps nodes to React elements
// and never uses dangerouslySetInnerHTML.
// Interface pinned: parseMarkdown(text) -> Block[]
//   Block:  {type:"heading", level, children:Inline[]} | {type:"paragraph", children} | {type:"list", ordered, items:Inline[][]}
//           | {type:"code", lang, text}
//   Inline: {type:"text", text} | {type:"strong", children} | {type:"code", text} | {type:"link", href, children}
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown } from "./render-markdown.mjs";

// All human-visible text of a tree, to assert that raw markup survives only as text.
const flat = (nodes) =>
  nodes.map((n) => {
    if (n.type === "text" || n.type === "code") return n.text;
    if (n.type === "list") return n.items.map(flat).join("\n");
    return flat(n.children ?? []);
  }).join("");
const walk = (nodes, out = []) => {
  for (const n of nodes) {
    out.push(n);
    if (n.children) walk(n.children, out);
    if (n.items) for (const it of n.items) walk(it, out);
  }
  return out;
};

test("headings carry their level", () => {
  const [h1, h2] = parseMarkdown("# One\n\n## Two\n");
  assert.equal(h1.type, "heading");
  assert.equal(h1.level, 1);
  assert.equal(flat(h1.children), "One");
  assert.equal(h2.level, 2);
});

test("a paragraph with bold and inline code", () => {
  const [p] = parseMarkdown("This is **bold** and `code` here.");
  assert.equal(p.type, "paragraph");
  const kinds = p.children.map((c) => c.type);
  assert.deepEqual(kinds, ["text", "strong", "text", "code", "text"]);
  assert.equal(flat(p.children[1].children), "bold");
  assert.equal(p.children[3].text, "code");
});

test("a bullet list yields one item per line", () => {
  const [l] = parseMarkdown("- alpha\n- beta\n- gamma\n");
  assert.equal(l.type, "list");
  assert.equal(l.ordered, false);
  assert.deepEqual(l.items.map(flat), ["alpha", "beta", "gamma"]);
});

test("a numbered list is ordered", () => {
  const [l] = parseMarkdown("1. first\n2. second\n");
  assert.equal(l.ordered, true);
  assert.deepEqual(l.items.map(flat), ["first", "second"]);
});

test("a fenced code block keeps its text verbatim, including markdown characters and blank lines", () => {
  const [c] = parseMarkdown("```js\nconst a = **not bold**;\n\n# not a heading\n```\n");
  assert.equal(c.type, "code");
  assert.equal(c.lang, "js");
  assert.equal(c.text, "const a = **not bold**;\n\n# not a heading");
});

test("an unclosed fence does not swallow nothing: the rest is still code text, no crash", () => {
  const [c] = parseMarkdown("```\nline one\nline two");
  assert.equal(c.type, "code");
  assert.match(c.text, /line one\nline two/);
});

test("http and https links become link nodes", () => {
  const [p] = parseMarkdown("See [docs](https://example.com/a) and [old](http://example.com).");
  const links = walk(p.children).filter((n) => n.type === "link");
  assert.deepEqual(links.map((l) => l.href), ["https://example.com/a", "http://example.com"]);
  assert.equal(flat(links[0].children), "docs");
});

test("javascript:, data: and other schemes never become links", () => {
  const bad = [
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](  javascript:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    "[x](vbscript:msgbox)",
    "[x](file:///etc/passwd)",
    "[x](//evil.example/x)",
    "[x](/relative/path)",
  ];
  for (const md of bad) {
    const nodes = walk(parseMarkdown(md));
    assert.equal(nodes.filter((n) => n.type === "link").length, 0, md);
    assert.match(flat(parseMarkdown(md)), /x/, md); // the label text is kept
  }
});

test("no link node ever carries an href outside http/https", () => {
  const md = "[a](javascript:1) [b](https://ok.example) [c](ftp://h/f) [d](http://ok.example)";
  for (const n of walk(parseMarkdown(md))) {
    if (n.type === "link") assert.match(n.href, /^https?:\/\//i);
  }
});

test("raw HTML stays literal text, never a node with markup meaning", () => {
  const md = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n**<b>hi</b>**';
  const blocks = parseMarkdown(md);
  const text = flat(blocks);
  assert.ok(text.includes("<script>alert(1)</script>"));
  assert.ok(text.includes("<img src=x onerror=alert(1)>"));
  const types = new Set(walk(blocks).map((n) => n.type));
  for (const t of types) assert.ok(["heading", "paragraph", "list", "code", "text", "strong", "link"].includes(t), `unexpected node type ${t}`);
});

test("a link label containing markup is text too", () => {
  const [p] = parseMarkdown("[<img src=x onerror=1>](https://ok.example)");
  const link = walk(p.children).find((n) => n.type === "link");
  assert.ok(link);
  assert.ok(flat(link.children).includes("<img src=x onerror=1>"));
});

test("empty and whitespace input give no blocks", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("  \n\n "), []);
});

test("a real handoff-shaped document parses without throwing", () => {
  const doc = [
    "```json", '{"placement": "qa", "mode": "specify"}', "```", "",
    "# Title", "", "## Section", "", "- `a.mjs`: covers **AC1**", "- [link](https://x.example)", "",
    "Trailing paragraph.",
  ].join("\n");
  const blocks = parseMarkdown(doc);
  assert.deepEqual(blocks.map((b) => b.type), ["code", "heading", "heading", "list", "paragraph"]);
});

test("the UI source never uses dangerouslySetInnerHTML", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const offenders = [];
  const scan = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) scan(p);
      else if (/\.(jsx?|mjs)$/.test(name) && !name.endsWith(".test.mjs") && /dangerouslySetInnerHTML/.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  scan(dir);
  assert.deepEqual(offenders, []);
});

test('pathological unclosed links parse in bounded time (security fix, 8 KB cap)', async () => {
  const { parseMarkdown } = await import('./render-markdown.mjs');
  for (const unit of ['[a](b', '[a]((', '[](']) {
    const text = unit.repeat(Math.floor(8192 / unit.length));
    const t0 = performance.now();
    parseMarkdown(text);
    assert.ok(performance.now() - t0 < 500, 'slow parse for ' + JSON.stringify(unit));
  }
});

test('links with balanced parens in the url still parse', async () => {
  const { parseInline } = await import('./render-markdown.mjs');
  const n = parseInline('[w](https://en.wikipedia.org/wiki/A_(b)_c) x');
  assert.equal(n[0].type, 'link');
  assert.equal(n[0].href, 'https://en.wikipedia.org/wiki/A_(b)_c');
});
