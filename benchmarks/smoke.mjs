// One real child-model delegation, scripted local parent, disposable read-only fixture.
// Not a benchmark or an OS sandbox. Uses the user's configured provider credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

const extension = fileURLToPath(new URL('../index.ts', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'durable-real-smoke-'));
const workspace = join(directory, 'workspace');
const agents = join(directory, 'agents');
const model = process.env.SMOKE_MODEL || 'opencode-go/deepseek-v4.1-flash';
const thinking = process.env.SMOKE_THINKING || 'high';
assert.match(model, /^[\w.-]+\/[\w./:-]+$/);
assert.ok(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking));
await mkdir(join(workspace, 'src'), { recursive: true, mode: 0o700 });
await mkdir(agents, { mode: 0o700 });
const files = {
  'README.md': '# Pocket Checkout\nA tiny invoice quote calculator. Entry point: src/index.ts. Shipping must be computed on the AFTER-discount subtotal: free at >= 50, otherwise 5. No test suite is provided.\n',
  'package.json': JSON.stringify({ name: 'pocket-checkout', version: '1.0.0', type: 'module', main: 'src/index.ts' }, null, 2),
  'src/index.ts': 'import { settings } from "./settings";\nimport { quote } from "./pricing";\nexport function main(input, env) { return quote(input, settings(env)); }\n',
  'src/settings.ts': 'export function settings(env) { return { threshold: Number(env.FREE_SHIPPING ?? "50") }; }\n',
  'src/pricing.ts': 'export function quote(input, config) {\n  const shipping = input.subtotal >= config.threshold ? 0 : 5;\n  const discounted = input.subtotal * (1 - input.discount);\n  return { discounted, shipping, total: discounted + shipping };\n}\n',
};
for (const [path, body] of Object.entries(files)) await writeFile(join(workspace, path), body);
const original = await readFile(new URL('../../my-agents-backup/scout.md', import.meta.url), 'utf8');
const definition = original.replace('---\n', `---\nmodel: ${model}\nthinking: ${thinking}\n`).replace('timeoutMinutes: 30', 'timeoutMinutes: 1');
await writeFile(join(agents, 'scout.md'), definition);
process.env.PI_SUBAGENT_AGENTS = agents;
process.env.PI_SUBAGENT_STORAGE = join(directory, 'runs');
console.log(`Smoke artifacts: ${directory}`);

async function fingerprint(path) {
  const result = {};
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      for (const [name, digest] of Object.entries(await fingerprint(join(path, entry.name)))) result[`${entry.name}/${name}`] = digest;
    } else {
      assert.ok(entry.isFile(), 'Unexpected non-file fixture entry');
      result[entry.name] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex');
    }
  }
  return result;
}
const before = await fingerprint(workspace);
const task = 'Inspect this repository without editing or executing code. Read README.md and package.json directly first, then at most three source files to identify the entry point and trace main through settings and quote. Stay inside the current working directory; use relative paths and narrowly scoped discovery only. Do not search elsewhere for missing guidance or tools. Evaluate main({subtotal:60,discount:0.2},{}) by reading the code. Return only JSON with purpose (string), entrypoint (path), callChain (function names in execution order), inspectedFiles (paths), concern ({actualTotal:number,correctTotal:number,description:string}), verificationGaps (string array), and unavailableCapabilities (tool-name array). Report missing tests and absent capabilities honestly. No file changes, installs, commands with side effects, or delegation.';
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const parent = fauxProvider({ provider: 'durable-smoke-scripted-parent' });
runtime.registerNativeProvider(parent.provider);
const settings = SettingsManager.inMemory({ defaultTools: ['read', 'bash', 'subagent'], retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: workspace, agentDir: join(directory, 'parent-config'), settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [extension] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd: workspace, agentDir: join(directory, 'parent-config'), resourceLoader: loader,
  settingsManager: settings, modelRuntime: runtime, model: parent.getModel(), thinkingLevel: 'off',
  sessionManager: SessionManager.create(workspace, join(directory, 'sessions')) });
const toolEvents = [];
let result;
parent.setResponses([
  fauxAssistantMessage([fauxToolCall('subagent', { agent: 'scout', task }, { id: 'real-smoke-scout' })], { stopReason: 'toolUse' }),
  context => {
    result = context.messages.findLast(message => message.role === 'toolResult');
    return fauxAssistantMessage('Smoke complete.');
  },
]);
session.subscribe(event => {
  if (event.type === 'tool_execution_start' && event.toolName !== 'subagent') toolEvents.push({ name: event.toolName, args: event.args });
});
const start = performance.now();
try {
  await session.bindExtensions({ mode: 'print' });
  await session.prompt('The operator requests this single isolated real-model scout delegation.');
  const after = await fingerprint(workspace);
  const report = { model, thinking, elapsedMs: Math.round(performance.now() - start), task, result, toolEvents,
    fixtureUnchanged: JSON.stringify(before) === JSON.stringify(after), before, after };
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  assert.ok(result, 'No delegation result');
  assert.equal(result.isError, false, result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n'));
  assert.equal(result.details.status, 'succeeded');
  assert.equal(report.fixtureUnchanged, true, 'Fixture changed');
  assert.equal(await readFile(new URL('../../my-agents-backup/scout.md', import.meta.url), 'utf8'), original, 'Original definition changed');
  const text = result.details.output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const answer = JSON.parse(text);
  assert.equal(answer.entrypoint, 'src/index.ts');
  assert.deepEqual(answer.callChain, ['main', 'settings', 'quote']);
  assert.equal(answer.concern.actualTotal, 48);
  assert.equal(answer.concern.correctTotal, 53);
  assert.ok(answer.verificationGaps.some(gap => /test/i.test(gap)));
  for (const path of Object.keys(files)) assert.ok(answer.inspectedFiles.includes(path), `Missing inspected file ${path}`);
  for (const name of result.details.unavailable) assert.ok(answer.unavailableCapabilities.includes(name), `Missing unavailable capability ${name}`);
  const reads = toolEvents.filter(event => event.name === 'read');
  assert.ok(reads.length >= 5, 'Expected real nested file reads');
  assert.ok(reads.slice(0, 2).every(event => ['README.md', 'package.json'].includes(event.args.path)), 'Named-path-first reading regressed');
  assert.ok(reads.every(event => Object.hasOwn(files, event.args.path)), 'Unexpected file read');
  console.log(JSON.stringify({ passed: true, runId: result.details.id, model: result.details.model, elapsedMs: report.elapsedMs,
    fixtureUnchanged: true, toolEvents, unavailable: result.details.unavailable, usage: result.details.usage, answer }, null, 2));
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
