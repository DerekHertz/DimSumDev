import { SECRET_PATTERNS } from "./secret-patterns.mjs";
const MASK = "[masked: possible secret]";
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g;

// Visible \uXXXX instead of the character, so it cannot reorder or hide text.
export const escapeText = (text) => text.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// Only the span a secret pattern matches is masked, so the rest of a command stays readable and a fake secret-shaped
// token cannot hide it. A private key block is masked through its END line (or to the end of the text), because the
// pattern matches only its header.
const PEM_END_RE = /-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const GLOBAL_PATTERNS = SECRET_PATTERNS.map((p) => ({ name: p.name, re: new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`) }));
function maskSecrets(text) {
  const spans = [];
  for (const { name, re } of GLOBAL_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      let end = m.index + m[0].length;
      if (name === "private key block") {
        const tail = PEM_END_RE.exec(text.slice(end));
        end = tail ? end + tail.index + tail[0].length : text.length;
      }
      spans.push([m.index, end]);
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = "";
  let at = 0;
  for (const [start, end] of merged) {
    out += text.slice(at, start) + MASK;
    at = end;
  }
  return out + text.slice(at);
}
export const cleanText = (text) => escapeText(maskSecrets(text));

// Recorded invocation arguments only: text or a plain JSON object. Bound the safe copy,
// never stringify an unsupported payload as a fallback. Redact before any clipping.
export function safeToolInput(input, max = 16000) {
  const plain = v => v !== null && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v));
  if (typeof input !== "string" && !plain(input)) return undefined;
  let nodes = 0;
  const walk = (value, depth = 0) => {
    if (++nodes > 2048 || depth > 16) throw new Error("input too large");
    if (typeof value === "string") return cleanText(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(v => walk(v, depth + 1));
    if (!plain(value)) throw new Error("unsupported input");
    const out = Object.create(null);
    for (const [key, v] of Object.entries(value)) {
      const name = cleanText(key);
      if (Object.hasOwn(out, name)) throw new Error("ambiguous input keys");
      // Mask a credential assignment as a whole, but preserve safe text around inline
      // secrets in fields such as command. The string walker masks those spans.
      out[name] = typeof v === "string" && cleanText(`${key}=${JSON.stringify(v)}`) === MASK ? MASK : walk(v, depth + 1);
    }
    return out;
  };
  try {
    const safe = walk(input);
    const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
    return text.length <= max ? safe : `${text.slice(0, max)}\n[clipped input]`;
  } catch { return undefined; }
}

