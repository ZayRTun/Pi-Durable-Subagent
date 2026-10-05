// Real end-to-end CLI run: the actual `pi` binary with Durable loaded explicitly.
// Creates a disposable repository, delegates one read-only task to scout, then retrieves
// the terminal result in a second process and checks the record was not rewritten.
// Makes live model calls with the configured provider. Not part of the offline test suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = fileURLToPath(new URL('../index.ts', import.meta.url));
const cli = process.env.PI_ACCEPTANCE_CLI || 'pi';
const directory = await mkdtemp(join(tmpdir(), 'durable-cli-live-'));
const workspace = join(directory, 'workspace');
const storage = join(directory, 'runs');
await mkdir(join(workspace, 'src'), { recursive: true, mode: 0o700 });
const files = {
  'README.md': '# Pocket Checkout\nA tiny invoice quote calculator. Entry point: src/index.ts. Shipping must be computed on the AFTER-discount subtotal: free at >= 50, otherwise 5. No test suite is provided.\n',
  'package.json': JSON.stringify({ name: 'pocket-checkout', version: '1.0.0', type: 'module', main: 'src/index.ts' }, null, 2),
  'src/index.ts': 'import { settings } from "./settings";\nimport { quote } from "./pricing";\nexport function main(input, env) { return quote(input, settings(env)); }\n',
  'src/settings.ts': 'export function settings(env) { return { threshold: Number(env.FREE_SHIPPING ?? "50") }; }\n',
  'src/pricing.ts': 'export function quote(input, config) {\n  const shipping = input.subtotal >= config.threshold ? 0 : 5;\n  const discounted = input.subtotal * (1 - input.discount);\n  return { discounted, shipping, total: discounted + shipping };\n}\n',
};
for (const [path, body] of Object.entries(files)) await writeFile(join(workspace, path), body);
console.log(`CLI live artifacts: ${directory}`);

async function fingerprint(path) {
  const out = {};
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) for (const [name, digest] of Object.entries(await fingerprint(join(path, entry.name)))) out[`${entry.name}/${name}`] = digest;
    else out[entry.name] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex');
  }
  return out;
}
const task = 'Inspect this repository without editing or executing code. Read README.md and package.json directly first, then the source files needed to identify the entry point and trace main through settings and quote. Stay inside the current working directory; use relative paths and narrowly scoped discovery only. Evaluate main({subtotal:60,discount:0.2},{}) by reading the code. Return only JSON with purpose (string), entrypoint (path), callChain (function names in execution order), inspectedFiles (paths), concern ({actualTotal:number,correctTotal:number,description:string}), verificationGaps (string array), and unavailableCapabilities (tool-name array). Report missing tests and absent capabilities honestly. No file changes, installs, commands with side effects, or delegation.';
function run(prompt) {
  const started = Date.now();
  const child = spawnSync(cli, ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
    '-e', extension, '--tools', 'read,bash,subagent', '--session-dir', join(directory, 'sessions'), '--session-id', 'durable-cli-live',
    '--mode', 'json', '--print', prompt],
    // Keep sessions and Durable storage isolated, but let Pi read the real agent directory so the
    // configured provider credentials resolve. Extensions, skills, templates, themes, and context
    // files are all disabled above, so only authentication and provider settings are shared.
    { cwd: workspace, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PI_SUBAGENT_STORAGE: storage } });
  const events = (child.stdout ?? '').trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { ms: Date.now() - started, status: child.status, signal: child.signal, stderr: child.stderr ?? '', events,
    output: child.stdout ?? '' };
}
const before = await fingerprint(workspace);

const delegate = run(`Delegate this exact task to the scout sub-agent using the subagent tool, then report its answer. Do not do the investigation yourself.\n\nTask:\n${task}`);
assert.equal(delegate.signal, null, `delegation timed out: ${delegate.stderr.slice(-400)}`);
assert.equal(delegate.status, 0, `delegation failed: ${delegate.stderr.slice(-800)}`);
const runIds = (await readdir(storage)).filter(name => /^[a-f0-9]{32}$/.test(name));
assert.equal(runIds.length, 1, `expected exactly one run record, found ${runIds.length}`);
const [id] = runIds;
const recordPath = join(storage, id, 'run.json');
const record = JSON.parse(await readFile(recordPath, 'utf8'));
await writeFile(join(directory, 'delegate.events.jsonl'), delegate.output);
assert.equal(record.status, 'succeeded', `run status ${record.status}: ${record.error ?? ''}`);
assert.equal(record.agent.name, 'scout');
const answer = JSON.parse(record.output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
assert.equal(answer.entrypoint, 'src/index.ts');
assert.deepEqual(answer.callChain, ['main', 'settings', 'quote']);
assert.equal(answer.concern.actualTotal, 48);
assert.equal(answer.concern.correctTotal, 53);
assert.ok(answer.verificationGaps.some(gap => /test/i.test(gap)), 'expected an honest missing-test gap');
for (const path of Object.keys(files)) assert.ok(answer.inspectedFiles.includes(path), `not inspected: ${path}`);
const after = await fingerprint(workspace);
assert.deepEqual(after, before, 'the disposable repository was modified');
console.log(JSON.stringify({ phase: 'delegate', ms: delegate.ms, id, status: record.status, model: record.model, thinking: record.thinking,
  unavailable: record.unavailable, usage: record.usage, toolCalls: record.activityLog?.length ?? null, answer }, null, 2));

// Retrieval must be read-only and must not start new work.
const recordBefore = await readFile(recordPath, 'utf8');
const retrieve = run(`Call the subagent tool exactly once with {"resume":"${id}"} and then report the returned text verbatim. Do not call it more than once and do not delegate anything new.`);
assert.equal(retrieve.signal, null, `retrieval timed out: ${retrieve.stderr.slice(-400)}`);
assert.equal(retrieve.status, 0, `retrieval failed: ${retrieve.stderr.slice(-800)}`);
const recordAfter = await readFile(recordPath, 'utf8');
assert.equal(recordAfter, recordBefore, 'retrieval rewrote run.json');
assert.equal(JSON.parse(recordAfter).updatedAt, record.updatedAt);
await writeFile(join(directory, 'retrieve.events.jsonl'), retrieve.output);
const subagentResults = retrieve.events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'subagent');
assert.ok(subagentResults.length >= 1, 'retrieval did not call the subagent tool');
const retrieved = subagentResults.at(-1);
assert.equal(retrieved.isError, false, JSON.stringify(retrieved.result?.content));
const returnedText = (retrieved.result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
assert.ok(returnedText.includes('succeeded'), `retrieval result missing status: ${returnedText.slice(0, 200)}`);
assert.ok(returnedText.includes('53'), 'retrieval did not return the cached answer');
// A terminal retrieval must report no new spend to the parent.
const retrieveUsage = retrieved.result?.usage;
assert.ok(!retrieveUsage || !retrieveUsage.totalTokens, `retrieval reported new spend: ${JSON.stringify(retrieveUsage)}`);
assert.equal(JSON.parse(recordAfter).status, 'succeeded');
assert.equal((await readdir(storage)).filter(name => /^[a-f0-9]{32}$/.test(name)).length, 1, 'retrieval created another run');
console.log(JSON.stringify({ phase: 'retrieve', ms: retrieve.ms, id, recordUnchanged: true, subagentCalls: subagentResults.length,
  status: JSON.parse(recordAfter).status, usageReportedToParent: retrieveUsage ?? null,
  firstLines: returnedText.split('\n').slice(0, 3) }, null, 2));
console.log('CLI live check passed');
