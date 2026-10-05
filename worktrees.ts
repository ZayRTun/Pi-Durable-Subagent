import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
  base: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

/**
 * Create an isolated checkout for one step, so concurrent steps never share a write target.
 * The checkout sits at `base`, so it holds committed state only and never the caller's uncommitted work.
 */
export async function createWorktree(cwd: string, options: { label: string; branch?: string; base?: string }): Promise<Worktree> {
  let root: string;
  try { root = await git(cwd, ["rev-parse", "--show-toplevel"]); }
  catch { throw new Error(`Worktree isolation needs a git repository, and ${cwd} is not inside one. Run the steps without worktree isolation to run them in place.`); }
  const base = options.base ?? await git(root, ["rev-parse", "HEAD"]);
  const branch = options.branch ?? `durable/${options.label}`;
  const path = join(dirname(root), `${basename(root)}-worktrees`, options.label);
  await run("git", ["-C", root, "worktree", "add", "-b", branch, path, base]);
  return { path, branch, base };
}

/**
 * Remove a retained checkout. The branch is kept, because it holds the work. Uncommitted changes in
 * the checkout are lost, so they are refused unless the caller says to force it.
 */
export async function removeWorktree(path: string, options: { force?: boolean } = {}): Promise<void> {
  const dirty = await git(path, ["status", "--porcelain"]);
  if (dirty && !options.force) {
    throw new Error(`Checkout ${path} has uncommitted changes. Merge or discard them, or pass force: true, which loses those changes.`);
  }
  const common = await git(path, ["rev-parse", "--git-common-dir"]);
  const root = dirname(isAbsolute(common) ? common : join(path, common));
  await run("git", ["-C", root, "worktree", "remove", path, ...(options.force ? ["--force"] : [])]);
  await run("git", ["-C", root, "worktree", "prune"]);
}
