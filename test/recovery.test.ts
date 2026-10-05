import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

test("opening and inspecting persisted work does not execute it before explicit resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-subagent-test-"));
  const path = join(directory, "run.sqlite");
  let executions = 0;
  const task = defineTask<{}, { phase: "run" }, string>({
    name: "test.resume", version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, context) => {
        executions++;
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "answer" } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test", tasks: [task] }));
  const options = { models: createModels(), registry };
  const context = BACKGROUND_CONTEXT;
  let harness;
  try {
    harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
    const root = await harness.root(context);
    const id = await root.commit((tx) => tx.createTask(task, {}, { ownership: { kind: "conversation" } }), context);
    assert.equal(executions, 0);
    await harness.close(context);
    harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
    const inspection = await harness.inspect(context);
    assert.equal(inspection.scheduling, "paused");
    assert.equal(inspection.tasks.length, 1);
    assert.equal(executions, 0);
    harness.resume();
    const result = await harness.waitForTask(id, context);
    assert.deepEqual(result.state.outcome, { status: "completed", result: "answer" });
    assert.equal(executions, 1);
    await harness.close(context);
    harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
    assert.deepEqual((await harness.getTask(id, context))?.state, result.state);
    assert.equal((await harness.inspect(context)).tasks.length, 0);
    assert.equal(executions, 1);
  } finally {
    if (harness) await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
