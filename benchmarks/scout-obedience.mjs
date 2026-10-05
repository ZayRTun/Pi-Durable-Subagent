// Controlled instruction experiment: one real child-model delegation per definition, scripted local
// parent, identical disposable read-only fixture and task. The only variable is the scout definition.
// Not a benchmark or an OS sandbox. Uses the user's configured provider credentials.
//
//   node benchmarks/scout-obedience.mjs <baseline.md> <candidate.md>
//
// Prints one JSON object per definition with its raw answer, tool events, and a length verdict.
// The read-tool paths and raw shell commands are evidence, not a filesystem-access audit.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

const definitions = process.argv.slice(2);
assert.ok(definitions.length >= 1, 'Pass at least one definition path to test');
const model = process.env.SCOUT_MODEL || 'opencode-go/deepseek-v4.1-flash';
const thinking = process.env.SCOUT_THINKING || 'low';
const timeoutMinutes = Number(process.env.SCOUT_TIMEOUT_MINUTES || '2');
const task = process.env.SCOUT_TASK || [
  'Explore this workspace without modifying anything.',
  'Read one root-level project descriptor (for example README.md or package.json).',
  'Report the project name, the primary language or framework, one documented verification command if available, and the exact paths inspected.',
  'Keep the answer under 200 words.',
  'Do not run tests, install dependencies, or delegate.',
].join(' ');
const maxSentences = process.env.SCOUT_MAX_SENTENCES ? Number(process.env.SCOUT_MAX_SENTENCES) : undefined;
const maxWords = process.env.SCOUT_MAX_WORDS ? Number(process.env.SCOUT_MAX_WORDS) : undefined;

const files = {
  'README.md': '# Pocket Checkout\nA tiny invoice quote calculator. Entry point: src/index.ts. No test suite.\n',
  'package.json': JSON.stringify({ name: 'pocket-checkout', version: '1.0.0', description: 'Tiny invoice quote calculator', type: 'module', main: 'src/index.ts', scripts: { test: 'node --test' } }, null, 2),
  'src/index.ts': 'import { quote } from "./pricing";\nexport function main(input) { return quote(input); }\n',
  'src/pricing.ts': 'export function quote(input) {\n  const shipping = input.subtotal >= 50 ? 0 : 5;\n  return { total: input.subtotal + shipping };\n}\n',
  'src/settings.ts': 'export const DEFAULT_THRESHOLD = 50;\n',
};
const extensionPath = fileURLToPath(new URL('../index.ts', import.meta.url));

/** Strip a fenced block or surrounding whitespace so the verdict judges the answer, not markdown. */
function answerBody(text) {
  const trimmed = (text || '').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

async function run(definitionPath) {
  const directory = await mkdtemp(join(tmpdir(), 'durable-scout-obedience-'));
  const workspace = join(directory, 'workspace');
  const agents = join(directory, 'agents');
  await mkdir(join(workspace, 'src'), { recursive: true, mode: 0o700 });
  await mkdir(agents, { mode: 0o700 });
  for (const [path, body] of Object.entries(files)) await writeFile(join(workspace, path), body);
  // Pin the real model explicitly: the scripted parent is faux, so inheritance would otherwise use faux.
  const source = await readFile(definitionPath, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  assert.ok(match, `${definitionPath} has no frontmatter`);
  const frontmatter = match[1].split('\n').filter((line) => !/^(model|thinking|timeoutMinutes):/.test(line));
  frontmatter.unshift(`model: ${model}`, `thinking: ${thinking}`, `timeoutMinutes: ${timeoutMinutes}`);
  const definition = `---\n${frontmatter.join('\n')}\n---\n${match[2]}`;
  await writeFile(join(agents, 'scout.md'), definition);
  const previousAgents = process.env.PI_SUBAGENT_AGENTS;
  const previousStorage = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_AGENTS = agents;
  process.env.PI_SUBAGENT_STORAGE = join(directory, 'runs');

  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const parent = fauxProvider({ provider: 'durable-obedience-scripted-parent' });
  runtime.registerNativeProvider(parent.provider);
  const settings = SettingsManager.inMemory({ defaultTools: ['read', 'bash', 'subagent'], retry: { enabled: false } });
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
    fauxAssistantMessage([fauxToolCall('subagent', { agent: 'scout', task }, { id: 'obedience' })], { stopReason: 'toolUse' }),
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
    await session.prompt('Run the single read-only scout delegation exactly as described.');
    assert.ok(result, 'No delegation result');
    const output = String(result.details?.output ?? '');
    const body = answerBody(output);
    const reads = toolEvents.filter((event) => event.name === 'read').map((event) => event.args?.path);
    const bashCommands = toolEvents.filter((event) => event.name === 'bash').map((event) => event.args?.command);
    const words = body.split(/\s+/).filter(Boolean);
    const sentences = body.replace(/```[\s\S]*?```/g, ' ').split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
    const lengthViolation = (maxWords !== undefined && words.length > maxWords) || (maxSentences !== undefined && sentences.length > maxSentences);
    return {
      definitionPath,
      model,
      thinking,
      task,
      isError: result.isError ?? false,
      status: result.details?.status,
      error: result.details?.error,
      output,
      resultText: result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
      answer: body,
      wordCount: words.length,
      sentenceCount: sentences.length,
      toolEvents,
      reads,
      bashCommands,
      formatViolation: lengthViolation,
      maxWords: maxWords ?? null,
      maxSentences: maxSentences ?? null,
      hasTemplate: /^#{1,6}\s/m.test(output) || /\n```markdown/.test(output),
      usage: result.details?.usage,
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

for (const definitionPath of definitions) {
  const report = await run(definitionPath);
  console.log(JSON.stringify(report));
}
