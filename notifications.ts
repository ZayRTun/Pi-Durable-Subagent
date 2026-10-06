import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { Run } from "./runtime.ts";
import { usageToReport } from "./usage.ts";

export const NOTIFICATION_TYPE = "durable-subagent-notification";
export interface Delivery {
  eventId: string;
  executionId: string;
  runId: string;
  sessionId: string;
  kind: "succeeded" | "failed" | "paused" | "blocker" | "stall";
  text: string;
  usage?: Usage;
  usageDelta?: Usage;
  deliveredAt?: number;
}
export class Notifications {
  private records = new Map<string, Delivery[]>();
  private writes = Promise.resolve();
  private stalled = new Map<string, { activity: string; toolCount: number; since: number }>();
  private directory: string;
  constructor(directory: string) { this.directory = directory; }
  private file(id: string) { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid run ID"); return join(this.directory, id, "deliveries.json"); }
  private async load(id: string) {
    let records = this.records.get(id);
    if (!records) {
      try { records = JSON.parse(await readFile(this.file(id), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; records = []; }
      this.records.set(id, records!);
    }
    return records!;
  }
  private async save(id: string) {
    const file = this.file(id), temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.records.get(id)), { mode: 0o600 }); await rename(temp, file);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const done = this.writes.then(operation); this.writes = done.then(() => {}, () => {}); return done;
  }
  observe(run: Run): Promise<void> {
    if (!run.nonblocking) return Promise.resolve();
    return this.serial(async () => {
      const records = await this.load(run.id);
      const executionId = `${run.id}:${run.executionAttempt ?? 0}`;
      const enqueue = (kind: Delivery["kind"], key: string, body: string) => {
        const eventId = `${executionId}:${kind}:${key}`;
        if (records.some(item => item.eventId === eventId)) return false;
        records.push({ eventId, executionId, runId: run.id, sessionId: run.sessionId, kind,
          text: `Sub-agent ${run.agent.name} · Run ${run.id} · ${kind}\n${body.slice(0, 3000)}${body.length > 3000 ? "\n[Answer excerpt]" : ""}\nFull retained result: subagent_status({"run":"${run.id}"}).`,
          ...(["succeeded", "failed", "paused"].includes(kind) ? { usage: run.usage } : {}) });
        return true;
      };
      let changed = false;
      if (run.status === "succeeded" || run.status === "failed" || run.status === "paused") {
        changed = enqueue(run.status, "result", run.status === "paused" ? run.handoff ?? run.handoffLimitation ?? run.activity : run.output ?? run.error ?? run.activity);
        this.stalled.delete(executionId);
      } else if (run.status === "running") {
        for (const tool of run.activityLog ?? []) {
          // Explicit tool errors/uncertainty are concrete attention facts, never inferred from progress text.
          if (tool.failed || tool.uncertain) changed = enqueue("blocker", tool.callId, `${tool.name}: ${tool.output ?? (tool.uncertain ? "Interrupted tool has uncertain effects; inspect before continuing." : "Tool failed; inspect retained diagnostics.")}`) || changed;
        }
        const previous = this.stalled.get(executionId);
        if (!previous || previous.activity !== run.activity || previous.toolCount !== (run.toolCount ?? 0)) this.stalled.set(executionId, { activity: run.activity, toolCount: run.toolCount ?? 0, since: Date.now() });
        else if (Date.now() - previous.since >= 120000) {
          const key = createHash("sha256").update(`${run.activity}:${run.toolCount ?? 0}`).digest("hex").slice(0, 16);
          changed = enqueue("stall", key, `No activity change for at least two minutes: ${run.activity}. Work remains active; inspect before intervening.`) || changed;
        }
      }
      if (changed) await this.save(run.id);
    });
  }
  async pending(sessionId: string) { await this.writes; return [...this.records.values()].flat().filter(item => item.sessionId === sessionId && !item.deliveredAt); }
  /** Reconcile retained host history before resending after reload/crash. */
  acknowledge(eventId: string): Promise<Delivery | undefined> {
    return this.serial(async () => {
      for (const [id, records] of this.records) {
        const item = records.find(record => record.eventId === eventId);
        if (!item) continue;
        if (!item.deliveredAt) {
          item.deliveredAt = Date.now();
          await this.save(id);
        }
        return item;
      }
    });
  }
  prepare(item: Delivery, entries: readonly {type: string; message?: unknown}[]): Delivery {
    // Cumulative ledger snapshots are used solely to report newly delivered model spend.
    return { ...item, usageDelta: usageToReport({ id: item.runId, usage: item.usage } as Run, entries) };
  }
  async deliveredResult(run: Run) { await this.writes; return (this.records.get(run.id) ?? []).some(item => item.executionId === `${run.id}:${run.executionAttempt ?? 0}` && item.kind === run.status && Boolean(item.deliveredAt)); }
  async close() { await this.writes; this.stalled.clear(); }
}
