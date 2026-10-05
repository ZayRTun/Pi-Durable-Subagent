import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, watch } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("real Pi CLI SIGKILL recovery: paused reopen, approval, stale leases, no duplicate effect, cached retrieval", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-cli-kill-"));
  const eventsFile = join(directory, "events.jsonl");
  const live = new Set<ChildProcess>();
  const closing: Promise<unknown>[] = [];
  const events = (): any[] => existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  async function waitFor(predicate: (event: any) => boolean, child: ChildProcess) {
    return new Promise<any>((resolve, reject) => {
      const inspect = () => {
        try { const result = events().find(predicate); if (result) { cleanup(); resolve(result); } }
        catch (error) { cleanup(); reject(error); }
      };
      const onExit = () => { cleanup(); reject(new Error("CLI exited before readiness; inspect captured output")); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("CLI readiness timeout")); }, 15000);
      const watcher = watch(directory, inspect);
      const cleanup = () => { clearTimeout(timer); watcher.close(); child.off("exit", onExit); child.off("error", onError); };
      child.once("exit", onExit);
      child.once("error", onError);
      inspect();
    });
  }
  function launch(scenario: string, run?: string, approval = false) {
    const args = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "-e", fileURLToPath(new URL("../index.ts", import.meta.url)), "-e", fileURLToPath(new URL("./fixtures/cli-acceptance.ts", import.meta.url)),
      "--provider", "acceptance-local", "--model", "faux-1", "--thinking", "off", "--tools", "subagent,hold",
      "--session-dir", join(directory, "sessions"), "--session-id", "durable-acceptance", "--mode", "json", "--print"];
    if (approval) args.push("--subagent-resume", run!);
    args.push(`Acceptance scenario ${scenario}.`);
    const child = spawn(process.env.PI_ACCEPTANCE_CLI ?? "pi", args, { cwd: directory,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "config"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        PI_SUBAGENT_AGENTS: join(directory, "agents"), PI_SUBAGENT_STORAGE: join(directory, "runs"),
        DURABLE_ACCEPTANCE_DIR: directory, DURABLE_ACCEPTANCE_SCENARIO: scenario, DURABLE_ACCEPTANCE_RUN: run ?? "" },
      stdio: ["ignore", "pipe", "pipe"] });
    live.add(child);
    let output = "", errors = "";
    child.stdout!.on("data", chunk => { output += chunk; appendFileSync(join(directory, `${scenario}.stdout.jsonl`), chunk); });
    child.stderr!.on("data", chunk => { errors += chunk; appendFileSync(join(directory, `${scenario}.stderr.txt`), chunk); });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => { live.delete(child); resolve({ code, signal }); });
    });
    // Register rejection handling immediately; readiness failures still propagate above.
    closing.push(done.catch(() => undefined));
    const finish = async () => {
      const outcome = await done;
      await writeFile(join(directory, `${scenario}.stdout.jsonl`), output);
      await writeFile(join(directory, `${scenario}.stderr.txt`), errors);
      return { ...outcome, output, errors };
    };
    return { child, finish };
  }
  async function completed(scenario: string, run?: string, approval = false) {
    const process = launch(scenario, run, approval);
    const result = await process.finish();
    assert.equal(result.code, 0, `${scenario}: ${result.errors}\n${result.output.slice(-1500)}`);
    return events().filter(event => event.scenario === scenario);
  }
  let passed = false;
  try {
    await mkdir(join(directory, "agents"));
    await mkdir(join(directory, "config"));
    await writeFile(join(directory, "agents/probe.md"), "---\nname: probe\ndescription: Disposable crash probe\ntools: hold\ncolor: cyan\n---\nOriginal fixture role. Never repeat an uncertain side effect.");
    console.log(`CLI acceptance artifacts: ${directory}`);
    const initial = launch("hold");
    const ready = await waitFor(event => event.event === "hold-ready", initial.child);
    assert.equal(ready.pid, initial.child.pid, "Only the exact CLI process launched by this test may be killed");
    initial.child.kill("SIGKILL");
    assert.equal((await initial.finish()).signal, "SIGKILL");
    const initialInspection = events().find(event => event.scenario === "hold" && event.event === "inspected");
    assert.ok(initialInspection?.sessionFile);
    const entries = (await readFile(initialInspection.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const call = entries.flatMap(entry => entry.message?.content ?? []).find(part => part.type === "toolCall" && part.name === "subagent");
    assert.ok(call);
    const { runId } = await import("../runtime.ts");
    const id = runId(initialInspection.sessionId, call.id);
    const recordPath = join(directory, "runs", id, "run.json");
    assert.equal(JSON.parse(await readFile(recordPath, "utf8")).status, "running", "SIGKILL must not run orderly shutdown cleanup");
    await writeFile(join(directory, "agents/probe.md"), "---\nname: probe\ndescription: Changed probe\ntools: hold\n---\nChanged fixture role.");
    const inspection = await completed("inspect");
    assert.deepEqual(inspection.find(event => event.event === "inspected").runs, [{ id, status: "interrupted" }]);
    assert.ok(!inspection.some(event => event.event === "model" && !event.parent), "Reopen and inspection must not wake child execution");
    const denied = await completed("denied", id);
    const rejection = denied.find(event => event.event === "result");
    assert.ok(rejection?.isError);
    assert.match(JSON.stringify(rejection.content), /Explicit resume approval required/);
    assert.ok(!denied.some(event => event.event === "model" && !event.parent));
    // Observe real lease expiration, never remove locks or fake their timestamps.
    const lockPath = join(directory, "runs", `${id}.lock`);
    const lockTime = (await stat(lockPath)).mtimeMs;
    if (Date.now() < lockTime + 5000) {
      const early = await completed("early", id, true);
      assert.ok(early.find(event => event.event === "result")?.isError);
      assert.ok(!early.some(event => event.event === "model" && !event.parent));
      assert.equal(JSON.parse(await readFile(recordPath, "utf8")).status, "running");
    }
    await delay(Math.max(0, lockTime + 11000 - Date.now()));
    const resumed = await completed("resume", id, true);
    const result = resumed.find(event => event.event === "result");
    assert.equal(result?.isError, false, JSON.stringify(result));
    assert.equal(result.details.status, "succeeded");
    assert.ok(result.details.activityLog.some((call: { name: string; uncertain?: boolean }) => call.name === "hold" && call.uncertain), "Recovered unsafe tool must remain visibly uncertain");
    assert.ok(resumed.some(event => event.event === "recovered" && event.uncertain));
    assert.equal(await readFile(join(directory, "effect.txt"), "utf8"), "effect\n", "The persisted external effect must occur exactly once in this fixture");
    const retrieved = await completed("retrieve", id);
    assert.equal(retrieved.find(event => event.event === "result")?.isError, false);
    assert.ok(!retrieved.some(event => event.event === "model" && !event.parent));
    assert.equal(events().filter(event => event.event === "hold-ready").length, 1);
    passed = true;
  } finally {
    for (const child of live) child.kill("SIGKILL");
    await Promise.allSettled(closing);
    // Preserve failing evidence, and optionally retain passing evidence for acceptance reports.
    if (passed && !process.env.PI_KEEP_ACCEPTANCE_ARTIFACTS) await rm(directory, { recursive: true, force: true });
  }
});
