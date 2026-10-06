import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function initializeWorktreeHostRepo(repo: string): Promise<void> {
  await run("git", ["init", "-q", repo]);
  await run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await run("git", ["-C", repo, "config", "user.name", "Test"]);
}

export async function cleanupWorktreeHostFixture(fixture: { repo: string; harness: string; store: string; worktrees: string }): Promise<void> {
  try { await run("git", ["-C", fixture.repo, "worktree", "prune"]); } catch {}
  await rm(fixture.worktrees, { recursive: true, force: true });
  await rm(fixture.store, { recursive: true, force: true });
  await rm(fixture.harness, { recursive: true, force: true });
  await rm(fixture.repo, { recursive: true, force: true });
}
