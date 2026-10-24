import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const MEETING_DIR_RE = /^\d{2,4}-[a-z0-9][a-z0-9-]{0,59}$/;
const SEPARATOR = '\n---\n\n';
const versioned = (stem, n) => `${stem}${n > 1 ? `-${n}` : ''}.md`;

export function createMeetingStore(root) {
  const dirOf = m => {
    if (!MEETING_DIR_RE.test(m.dir) || !/^[a-z0-9][a-z0-9-]*\//.test(m.ref)) throw new Error('Invalid legacy meeting location');
    return path.join(root, '.scratch', m.ref.split('/')[0], 'meetings', m.dir);
  };
  const saved = async (m, name) => {
    const text = await readFile(path.join(dirOf(m), name), 'utf8').catch(() => null);
    if (text === null) return null;
    const at = text.indexOf(SEPARATOR);
    return (at < 0 ? text : text.slice(at + SEPARATOR.length)).trimEnd();
  };
  async function read(m) {
    const takes = [];
    for (const seat of m.seats) if (seat.takes > 0) {
      const text = await saved(m, versioned(`take-${seat.role}`, seat.takes));
      if (text !== null) takes.push({ role: seat.role, n: seat.takes, text });
    }
    const raw = await readFile(path.join(dirOf(m), 'thread.jsonl'), 'utf8').catch(() => '');
    const thread = raw.split('\n').flatMap(line => { try { const e = JSON.parse(line); return ['user', 'chair'].includes(e.from) && typeof e.text === 'string' ? [e] : []; } catch { return []; } });
    return { takes, thread, brief: m.brief ? await saved(m, versioned('brief', m.brief.version)) : null, summary: await readFile(path.join(dirOf(m), 'summary.md'), 'utf8').catch(() => null) };
  }
  async function history(m) {
    const events = [];
    for (const name of await readdir(dirOf(m)).catch(() => [])) {
      const take = /^take-([a-z-]+?)(?:-(\d+))?\.md$/.exec(name);
      if (!take && !/^brief(?:-\d+)?\.md$/.test(name)) continue;
      const text = await saved(m, name);
      const metadata = await stat(path.join(dirOf(m), name));
      const raw = await readFile(path.join(dirOf(m), name), 'utf8');
      events.push({ id: `legacy-${m.id}-${name}`, kind: 'message', actor: take?.[1] ?? 'bao', text, at: metadata.mtime.toISOString(), round: Number(take?.[2] ?? /-(\d+)\.md$/.exec(name)?.[1] ?? 1), runId: /from run (c-[0-9a-f]{16})/.exec(raw)?.[1] ?? null, part: take ? 'take' : 'chair', cost: null, estimate: null, tools: [] });
    }
    const data = await read(m);
    data.thread.forEach((e, i) => events.push({ id: `legacy-${m.id}-thread-${i}`, kind: e.from === 'user' ? 'redirect' : 'message', actor: e.from === 'user' ? 'user' : 'bao', text: e.text, at: e.ts ?? m.startedAt, round: 1 }));
    return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((e, i) => ({ ...e, version: i + 1 }));
  }
  return { read, history };
}
