// Native Claude CLI against a local fake API: tool visibility only, no provider account call.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from "node:url";
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const root = mkdtempSync(`${tmpdir()}/den-claude-tool-`);
mkdirSync(`${root}/.claude/agents`, { recursive: true });
writeFileSync(`${root}/.claude/agents/developer.md`, '---\nname: developer\ntools: Read, Bash, Agent(runner)\nmodel: haiku\n---\nReply OK.\n');
writeFileSync(`${root}/mcp.json`, JSON.stringify({ mcpServers: { delegation: { command: process.execPath, args: [fileURLToPath(new URL('../../library/servers/delegation.mjs', import.meta.url))] } } }));
let tools = [], count = 0;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  if (++count > 4) { res.writeHead(500); return res.end(); }
  if (req.url.includes('count_tokens')) { res.writeHead(200); return res.end('{"input_tokens":10}'); }
  tools = (body.tools ?? []).map(t => t.name);
  const message = { id: 'msg_probe', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(message)); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, data] of [['message_start', { message: { ...message, content: [], stop_reason: null } }], ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', {}]]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
try {
  const child = spawn(process.env.DEN_CLAUDE_BIN ?? 'claude', ['-p', '--model', 'haiku', '--agent', 'developer', '--agents', JSON.stringify({ developer: { description: 'probe', prompt: 'Reply OK', tools: ['Read', 'Bash', 'Agent(runner)', 'mcp__delegation__delegate'], model: 'haiku' } }), '--setting-sources', '', '--strict-mcp-config', '--mcp-config', `${root}/mcp.json`, '--tools', 'default', '--allowedTools', 'mcp__delegation__delegate', '--settings', '{"disableAllHooks":true,"permissions":{"deny":["Agent","Task"]}}', 'Reply OK.'], { cwd: root, env: { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: ['local', 'fixture', 'not', 'real'].join('-'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { process.stderr.write(error.code + '\n'); });
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', d => stderr = (stderr + d).slice(-1000));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const code = await new Promise(r => child.once('close', r)); clearTimeout(timer);
  process.exitCode = code === 0 && tools.includes('mcp__delegation__delegate') && !tools.includes('Agent') ? 0 : 1;
  console.log(JSON.stringify({ code, requests: count, tools, managedToolAdvertised: tools.includes('mcp__delegation__delegate'), nativeAgentAdvertised: tools.includes('Agent'), ...(code !== 0 ? { stderr } : {}) }));
} finally { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); }
