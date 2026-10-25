// Test-only Claude CLI stand-in. It calls the real MCP transport; no provider request.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const send = row => process.stdout.write(JSON.stringify(row) + '\n');
const model = args[args.indexOf('--model') + 1];
const configAt = args.indexOf('--mcp-config');
const delegation = configAt < 0 ? null : JSON.parse(readFileSync(args[configAt + 1], 'utf8')).mcpServers.delegation;
let started = false;
const git = (...rest) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...rest], { encoding: 'utf8' });
createInterface({ input: process.stdin }).on('line', async line => {
  const row = JSON.parse(line);
  if (row.type !== 'user') return;
  if (row.uuid) send({ ...row, isReplay: true });
  const prompt = typeof row.message.content === 'string' ? row.message.content : row.message.content[0].text;
  if (started || (args[args.indexOf('--agent') + 1] === 'chief-of-staff' && !prompt.includes('Coordinate one independent'))) return;
  started = true;
  send({ type: 'system', subtype: 'init', model });
  let report = 'child evidence: targeted checks passed';
  if (delegation) {
    const role = JSON.parse(args[args.indexOf('--agents') + 1])[args[args.indexOf('--agent') + 1]];
    if (!role.tools?.includes('mcp__delegation__delegate') || !role.prompt.includes('Be the')) throw new Error('managed role must preserve its prompt and expose the tool');
    const manager = /"kind":"manager"/.test(prompt);
    const input = { issue: manager ? 'child-check' : 'manager-integration', kind: manager ? 'child' : 'manager', role: 'developer', task: manager ? 'Write probe result' : 'Coordinate probe work', reason: 'Separate check and integration', files: ['sample.txt'], constraints: ['No dependencies'], acceptance: ['Return verified probe result'] };
    const child = spawn(delegation.command, delegation.args, { env: { ...process.env, ...delegation.env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      createInterface({ input: child.stdout }).on('line', text => {
        const reply = JSON.parse(text);
        if (reply.id === 1) resolve(reply.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate', arguments: input } }) + '\n');
    });
    child.kill();
    const returned = JSON.parse(result.content[0].text);
    if (!returned.ok) throw new Error(JSON.stringify(returned));
    if (manager) git('cherry-pick', returned.sha);
    report = `Integrated returned evidence: ${returned.report}; commit ${returned.sha}`;
  } else {
    writeFileSync('sample.txt', 'verified child work\n');
    git('add', 'sample.txt');
    git('commit', '-m', 'probe child work');
  }
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: report }] } });
  send({ type: 'result', subtype: 'success', is_error: false, result: report, duration_ms: 1, num_turns: 1 });
});
