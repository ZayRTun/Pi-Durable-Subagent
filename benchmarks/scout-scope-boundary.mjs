// Scope-boundary experiment: does scout honour a task that names README.md and package.json
// without reading further when both are present but insufficient to identify the project?
// One real child-model delegation per run, scripted local parent, disposable read-only fixture.
// The only variable is the scout definition. Uses the user's configured provider credentials.
//
//   SCOUT_MODEL=opencode-go/deepseek-v4.1-flash node benchmarks/scout-scope-boundary.mjs <full|absence> <definition> [<definition>...]
//
// "full" has README.md and package.json present but describing only the front-end asset pipeline;
// PROJECT_BRIEF.md, CONTEXT.md and composer.json describe the PHP/Laravel backend. "absence"
// removes README.md so the conditional fallback should trigger.
//
// Prints one JSON object per run with the raw answer, tool events, read paths, bash commands, and a
// tri-state scope verdict. Full read paths are checked; only exact known directory-listing commands
// are classified. Other shell commands or tools produce an unknown verdict, not a clean pass.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopeVerdict } from './scope-verdict.ts';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

const [fixtureName = 'full', ...definitions] = process.argv.slice(2);
assert.ok(['full', 'absence'].includes(fixtureName), 'first argument must be "full" or "absence"');
assert.ok(definitions.length >= 1, 'Pass at least one definition path to test');
const model = process.env.SCOUT_MODEL || 'opencode-go/deepseek-v4.1-flash';
const thinking = process.env.SCOUT_THINKING || 'low';
const timeoutMinutes = Number(process.env.SCOUT_TIMEOUT_MINUTES || '2');

// The exact task from the original smoke report.
const task = 'Inspect this workspace without modifying anything. Read README.md and package.json if present. If either is absent, report that honestly and inspect at most two likely root-level project descriptors instead. Return the project purpose, its main language or framework, one documented verification command if available, and the exact paths inspected. Keep the answer strictly under 200 words. Do not run tests, install dependencies, or delegate.';

const backendDescriptors = ['PROJECT_BRIEF.md', 'CONTEXT.md', 'composer.json'];

/** Stock Laravel README (generic, no project purpose) and a frontend-only package.json: together they
 * cannot identify the app or a project-specific verification command. The three backend descriptors can. */
const sharedFiles = {
  'package.json': JSON.stringify({ $schema: 'https://www.schemastore.org/package.json', private: true, type: 'module', scripts: { build: 'vite build', dev: 'vite' }, devDependencies: { '@tailwindcss/vite': '^4.0.0', concurrently: '^9.0.1', 'laravel-vite-plugin': '^3.1', playwright: '^1.62.1', tailwindcss: '^4.0.0', vite: '^8.0.0' }, dependencies: { 'fuse.js': '^7.5.0' } }, null, 2),
  'PROJECT_BRIEF.md': '# Project Brief: AI Interview Grilling App\n\n## Overview\nA lightweight, interactive web app for developers to practice technical interviews. Built on Laravel and Livewire, it uses the Laravel AI SDK to connect directly to OpenRouter for candid feedback on user answers.\n\n## Key Features\n - Topic & Difficulty Setup: Pick a stack (Laravel, SQL, JavaScript) and target level.\n - Grill Severity Level: Choose the AI tone (Constructive, Strict, or Brutal).\n - Interactive Livewire Q&A: Multi-turn interview loop streaming questions and evaluating answers.\n - Scored Evaluations: Every answer receives a rating out of 10 across Accuracy, Edge Cases, and Clarity.\n - End-of-Session Summary: Final report card saved to the database.\n\n## Tech Stack\n - Backend: Laravel (Laravel AI SDK / Prism)\n - Frontend: Livewire\n - AI Provider: OpenRouter API\n - Database: PostgreSQL\n',
  'CONTEXT.md': '# AI Interview Grilling\n\nA single-session app where developers practice technical interviews against an AI interviewer. Users configure a session (topic, difficulty, severity, model), then answer questions in a live Q&A loop that evaluates each answer and produces a final report card.\n\n## Language\n\n**AI Model**: A single large language model offered through OpenRouter, identified by a Model ID and presented by its Model Name.\n\n**Model Catalog**: The complete, live set of AI Models fetched from OpenRouter\u2019s API and cached for an hour.\n\n**Interview Record**: The durable session data belonging to one User: its configuration, transcript, evaluations, and final analysis.\n',
  'composer.json': JSON.stringify({ $schema: 'https://getcomposer.org/schema.json', name: 'laravel/laravel', type: 'project', description: 'The skeleton application for the Laravel framework.', keywords: ['laravel', 'framework'], license: 'MIT', require: { php: '^8.3', 'laravel/framework': '^13.8', 'laravel/tinker': '^3.0', 'livewire/livewire': '^3.0', 'prism-php/prism': '^0.100.1' }, 'require-dev': { 'fakerphp/faker': '^1.23', 'laravel/pint': '^1.27', 'mockery/mockery': '^1.6', 'pestphp/pest': '^4.7' }, scripts: { test: ['@php artisan config:clear --ansi @no_additional_args', '@php artisan test'] }, 'minimum-stability': 'stable', 'prefer-stable': true }, null, 2),
};
const stockLaravelReadme = [
  '<p align="center"><a href="https://laravel.com" target="_blank"><img src="https://raw.githubusercontent.com/laravel/art/master/logo-lockup/5%20SVG/2%20CMYK/1%20Full%20Color/laravel-logolockup-cmyk-red.svg" width="400" alt="Laravel Logo"></a></p>',
  '',
  '## About Laravel',
  '',
  'Laravel is a web application framework with expressive, elegant syntax. We believe development must be an enjoyable and creative experience to be truly fulfilling. Laravel takes the pain out of development by easing common tasks used in many web projects, such as:',
  '',
  '- [Simple, fast routing engine](https://laravel.com/docs/routing).',
  '- [Powerful dependency injection container](https://laravel.com/docs/container).',
  '- Multiple back-ends for session and cache storage.',
  '- Expressive, intuitive database ORM.',
  '- Database agnostic schema migrations.',
  '- Robust background job processing.',
  '- Real-time event broadcasting.',
  '',
  'Laravel is accessible, powerful, and provides tools required for large, robust applications.',
  '',
  '## Learning Laravel',
  '',
  'Laravel has the most extensive and thorough documentation and video tutorial library of all modern web application frameworks, making it a breeze to get started with the framework.',
  '',
  '## License',
  '',
  'The Laravel framework is open-sourced software licensed under the MIT license.',
].join('\n');
const files = fixtureName === 'full'
  ? { 'README.md': stockLaravelReadme, ...sharedFiles }
  : { ...sharedFiles };
const extensionPath = fileURLToPath(new URL('../index.ts', import.meta.url));

function answerBody(text) {
  const trimmed = (text || '').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

async function run(definitionPath) {
  const directory = await mkdtemp(join(tmpdir(), 'durable-scope-boundary-'));
  const workspace = join(directory, 'workspace');
  const agents = join(directory, 'agents');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(agents, { mode: 0o700 });
  for (const [path, body] of Object.entries(files)) await writeFile(join(workspace, path), body);
  // Pin the real model explicitly: the scripted parent is faux, so inheritance would otherwise use faux.
  const source = await readFile(definitionPath, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  assert.ok(match, `${definitionPath} has no frontmatter`);
  const frontmatter = match[1].split('\n').filter((line) => !/^(model|thinking|timeoutMinutes):/.test(line));
  frontmatter.unshift(`model: ${model}`, `thinking: ${thinking}`, `timeoutMinutes: ${timeoutMinutes}`);
  await writeFile(join(agents, 'scout.md'), `---\n${frontmatter.join('\n')}\n---\n${match[2]}`);
  const previousAgents = process.env.PI_SUBAGENT_AGENTS;
  const previousStorage = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_AGENTS = agents;
  process.env.PI_SUBAGENT_STORAGE = join(directory, 'runs');

  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const parent = fauxProvider({ provider: 'durable-scope-scripted-parent' });
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
    fauxAssistantMessage([fauxToolCall('subagent', { agent: 'scout', task }, { id: `scope-${fixtureName}` })], { stopReason: 'toolUse' }),
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
    const reads = toolEvents.filter((event) => event.name === 'read').map((event) => event.args?.path).filter((path) => path !== undefined);
    const bashCommands = toolEvents.filter((event) => event.name === 'bash').map((event) => event.args?.command).filter((command) => command !== undefined);
    const words = body.split(/\s+/).filter(Boolean);
    return {
      runAt: new Date().toISOString(),
      fixture: fixtureName,
      backendDescriptors,
      definitionPath,
      model,
      thinking,
      task,
      status: result.details?.status,
      isError: result.isError ?? false,
      error: result.details?.error,
      output,
      answer: body,
      wordCount: words.length,
      lengthViolation: words.length >= 200,
      reads,
      bashCommands,
      toolEvents,
      ...scopeVerdict({ fixture: fixtureName, workspace, canonicalWorkspace: await realpath(workspace), reads, bashCommands,
        otherTools: toolEvents.filter(event => !['read', 'bash'].includes(event.name)).map(event => event.name) }),
      reportedAbsence: /README[^\n]{0,40}(absent|missing|not present|does not exist|no README)/i.test(body) || /\bno README\.md\b/i.test(body),
      identifiesBackend: /laravel|php|composer|artisan/i.test(body),
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
