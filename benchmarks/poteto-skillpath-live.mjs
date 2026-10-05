// One bounded live Durable delegation against the actual operator poteto-agent definition.
// Scripted local faux parent, disposable two-file read-only fixture, real child model.
// Proof targets: the child reads the pinned installed poteto-mode SKILL.md; reads no other skill
// installation; reads only the two named project files; runs zero shell commands; edits nothing;
// delegates nothing; and answers within 150 words. Not an OS sandbox: uses the user's configured
// provider credentials. Run from agent/durable-subagent:
//
//   node benchmarks/poteto-skillpath-live.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

const PINNED_SKILLS_ROOT = '/Users/zayar/.pi/agent/npm/node_modules/@casualjim/pi-pstack/skills';
const PINNED_SKILL = join(PINNED_SKILLS_ROOT, 'poteto-mode', 'SKILL.md');
const OPERATOR_AGENTS = '/Users/zayar/.pi/agent/my-agents-backup';
const model = process.env.POTETO_MODEL || 'opencode-go/deepseek-v4.1-flash';
const thinking = process.env.POTETO_THINKING || 'medium';
const timeoutMinutes = Number(process.env.POTETO_TIMEOUT_MINUTES || '3');

const task = [
  'Read the poteto-mode SKILL.md your operating definition pins, in full, before any other action.',
  "Then inspect only this workspace's README.md and package.json.",
  "Report the project's purpose and one documented verification command, plus any unknowns.",
  'Do not run shell commands. Do not edit files. Do not delegate.',
  'Answer in at most 150 words. Name a principle only if it shaped an actual decision you made.',
].join(' ');

const files = {
  'README.md': '# Pocket Ledger\n\nA small CLI that records ledger entries in a local JSON file. Entry point: `src/cli.ts`. Verification: `node --test`.\n',
  'package.json': JSON.stringify({ name: 'pocket-ledger', version: '2.0.0', description: 'Local JSON ledger CLI', type: 'module', bin: { ledger: './src/cli.ts' }, scripts: { test: 'node --test' } }, null, 2),
};

const extensionPath = fileURLToPath(new URL('../index.ts', import.meta.url));

function under(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

function answerBody(text) {
  const trimmed = (text || '').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'durable-poteto-skillpath-'));
  const workspace = join(directory, 'workspace');
  const store = join(directory, 'runs');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const [path, body] of Object.entries(files)) await writeFile(join(workspace, path), body);
  const previousAgents = process.env.PI_SUBAGENT_AGENTS;
  const previousStorage = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_AGENTS = OPERATOR_AGENTS;
  process.env.PI_SUBAGENT_STORAGE = store;

  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const parent = fauxProvider({ provider: 'durable-poteto-skillpath-parent' });
  runtime.registerNativeProvider(parent.provider);
  const settings = SettingsManager.inMemory({ defaultTools: ['read', 'bash', 'edit', 'write', 'subagent'], retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: workspace, agentDir: join(directory, 'parent-config'), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [extensionPath] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: workspace, agentDir: join(directory, 'parent-config'), resourceLoader: loader,
    settingsManager: settings, modelRuntime: runtime, model: parent.getModel(), thinkingLevel: 'off',
    sessionManager: SessionManager.create(workspace, join(directory, 'sessions')) });
  const toolEvents = [];
  let result;
  parent.setResponses([
    fauxAssistantMessage([fauxToolCall('subagent', { agent: 'poteto-agent', model, task }, { id: 'poteto-skillpath' })], { stopReason: 'toolUse' }),
    (context) => {
      result = context.messages.findLast((message) => message.role === 'toolResult');
      return fauxAssistantMessage('Done.');
    },
  ]);
  session.subscribe((event) => {
    if (event.type === 'tool_execution_start' && event.toolName !== 'subagent') toolEvents.push({ name: event.toolName, args: event.args });
  });
  try {
    await session.bindExtensions({ mode: 'print' });
    await session.prompt('Run the single read-only poteto-agent delegation exactly as described.');
    assert.ok(result, 'No delegation result');
    const output = String(result.details?.output ?? '');
    const body = answerBody(output);
    const words = body.split(/\s+/).filter(Boolean);
    const canonicalWorkspace = await realpath(workspace);
    const reads = toolEvents.filter((event) => event.name === 'read').map((event) => String(event.args?.path ?? ''));
    const resolvedReads = reads.map((path) => (isAbsolute(path) ? path : resolve(workspace, path)));
    const bashCommands = toolEvents.filter((event) => event.name === 'bash').map((event) => String(event.args?.command ?? ''));
    const editWrites = toolEvents.filter((event) => event.name === 'edit' || event.name === 'write')
      .map((event) => ({ name: event.name, args: event.args }));
    const otherTools = toolEvents.filter((event) => !['read', 'bash', 'edit', 'write'].includes(event.name)).map((event) => event.name);
    const exactSkillRead = resolvedReads.includes(PINNED_SKILL);
    const pinnedSkillReads = resolvedReads.filter((path) => under(PINNED_SKILLS_ROOT, path));
    const otherSkillReads = resolvedReads.filter((path) => /(^|\/)skills\//.test(path) && !under(PINNED_SKILLS_ROOT, path));
    const projectReads = [...new Set(resolvedReads.filter((path) => under(workspace, path) || under(canonicalWorkspace, path))
      .map((path) => relative(workspace, path)))];
    const outOfScopeReads = resolvedReads.filter((path) => !under(PINNED_SKILLS_ROOT, path) && !under(workspace, path) && !under(canonicalWorkspace, path));

    const stored = [];
    try {
      const ids = (await readdir(store)).filter((name) => /^[a-f0-9]{32}$/.test(name));
      for (const id of ids) {
        const record = JSON.parse(await readFile(join(store, id, 'run.json'), 'utf8'));
        stored.push({ id, agent: record.agent?.name, model: record.model, role: record.role, thinking: record.thinking,
          status: record.status, unavailable: record.unavailable, usage: record.usage });
      }
    } catch (error) {
      stored.push({ error: String(error.message) });
    }

    return {
      runAt: new Date().toISOString(),
      definitionPath: join(OPERATOR_AGENTS, 'poteto-agent.md'),
      requestedModel: model,
      requestedThinking: thinking,
      pinnedSkill: PINNED_SKILL,
      task,
      status: result.details?.status,
      isError: result.isError ?? false,
      error: result.details?.error,
      output,
      answer: body,
      wordCount: words.length,
      lengthViolation: words.length > 150,
      exactSkillRead,
      pinnedSkillReads,
      otherSkillReads,
      projectReads,
      onlyNamedProjectFiles: projectReads.every((path) => path === 'README.md' || path === 'package.json'),
      outOfScopeReads,
      bashCommands,
      bashCallCount: bashCommands.length,
      editWrites,
      otherTools,
      toolEvents,
      stored,
      childUsage: stored[0]?.usage,
      childCostUsd: stored[0]?.usage?.cost?.total,
      mentionsSetTasks: /set_tasks/i.test(output),
      principleMentions: body.match(/principle-[a-z-]+/gi) ?? [],
    };
  } finally {
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally {
      session.dispose();
      if (previousAgents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = previousAgents;
      if (previousStorage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previousStorage;
      await rm(directory, { recursive: true, force: true });
    }
  }
}

console.log(JSON.stringify(await run(), null, 2));
