// den/06: the right-hand cards at 1280x800 and 375 wide. Real styles.css, the card markup from Card.jsx / StationsCard,
// 28 ready tickets. Skips when no browser is installed (the CI smoke:ui job has one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLaunchOptions } from "../ci-cd/launch-options.mjs";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "src", "styles.css"), "utf8");
const card = (overlay, title, open, body) =>
  `<section class="card card-line${open ? "" : " card-closed"}" data-overlay="${overlay}"><h2 class="card-head"><button type="button" class="card-toggle" aria-expanded="${open}"><span class="card-title">${title}</span></button></h2><div class="card-body"${open ? "" : " hidden"}>${body}</div></section>`;
const rows = Array.from({ length: 28 }, (_, i) =>
  `<li class="queue-row"><div class="queue-line"><span class="pchip">P2</span><span class="queue-title">Ticket ${i + 1}</span></div><span class="code-small muted queue-ref">den/${i + 1}</span></li>`).join("");
const page = `<style>${css}</style><body style="margin:0;position:relative;height:100vh"><div class="cards">${
  card("stations", "Teams & queue", true, `<p class="ov">Next on the susan</p><ul class="queue-rows queue-rows-flow">${rows}</ul>`) +
  card("meetings", "Meetings", false, "<p>x</p>") + card("library", "Library", false, "<p>x</p>")}</div></body>`;

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch {}

for (const [w, h] of [[1280, 800], [375, 800]]) {
  test(`cards layout at ${w}px`, { skip: !chromium && "playwright not installed" }, async (t) => {
    let browser;
    try { browser = await chromium.launch(buildLaunchOptions(undefined)); } catch (e) { return t.skip("no browser: " + e.message.split("\n")[0]); }
    try {
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      await p.setContent(page);
      const r = await p.evaluate(() => {
        const list = document.querySelector(".queue-rows");
        const body = document.querySelector("[data-overlay=stations] .card-body");
        const closed = [...document.querySelectorAll(".card-closed")].map((c) => ({ h: c.getBoundingClientRect().height, head: c.querySelector(".card-head").getBoundingClientRect().height }));
        const last = list.lastElementChild;
        body.scrollTop = body.scrollHeight;
        const lb = last.getBoundingClientRect(), bb = body.getBoundingClientRect();
        return { listScrolls: list.scrollHeight > list.clientHeight + 1, bodyScrolls: body.scrollHeight > body.clientHeight, lastVisible: lb.bottom <= bb.bottom + 1 && lb.top >= bb.top, closed };
      });
      assert.equal(r.listScrolls, false, "the susan list has no scroll of its own");
      assert.equal(r.bodyScrolls, true, "the card body scrolls");
      assert.equal(r.lastVisible, true, "the 28th ticket can be scrolled to");
      for (const c of r.closed) assert.ok(c.h >= c.head - 0.5, `collapsed card ${c.h}px shows its ${c.head}px header`);
    } finally { await browser.close(); }
  });
}
