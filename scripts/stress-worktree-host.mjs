import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testFile = "test/worktree-host-parallel.test.ts";

function options(args) {
  const result = { iterations: 40, concurrency: 8, logDir: join(repo, "test-results/worktree-stress") };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--log-dir") result.logDir = resolve(value);
    else if (flag === "--iterations" || flag === "--concurrency") {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer`);
      result[flag === "--iterations" ? "iterations" : "concurrency"] = number;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return result;
}

async function invocation(iteration, directory) {
  return new Promise((resolveResult, reject) => {
    const output = [];
    let spawnError;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--test", testFile], {
      cwd: repo, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    });
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => output.push(chunk));
    child.once("error", error => { spawnError = error.message; });
    child.once("close", async (code, signal) => {
      try {
        const failed = code !== 0 || spawnError !== undefined;
        const log = failed ? `iteration-${iteration}.log` : undefined;
        if (log) {
          const status = `Iteration ${iteration}: exit=${code}, signal=${signal ?? "none"}${spawnError ? `, error=${spawnError}` : ""}\n`;
          await writeFile(join(directory, log), status + Buffer.concat(output).toString("utf8"));
          console.error(`Iteration ${iteration} failed: ${join(directory, log)}`);
        }
        resolveResult({ iteration, code, signal, ...(spawnError ? { error: spawnError } : {}), ...(log ? { log } : {}) });
      } catch (error) { reject(error); }
    });
  });
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log("Usage: npm run test:workspace:stress -- [--iterations 40] [--concurrency 8] [--log-dir PATH]");
    return;
  }
  const settings = options(process.argv.slice(2));
  await mkdir(settings.logDir, { recursive: true });
  const directory = await mkdtemp(join(settings.logDir, "run-"));
  const started = Date.now();
  let next = 1;
  const results = [];
  console.log(`Running ${settings.iterations} parallel-worktree tests with ${Math.min(settings.concurrency, settings.iterations)} workers.`);
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, settings.iterations) }, async () => {
    while (next <= settings.iterations) {
      const iteration = next++;
      results.push(await invocation(iteration, directory));
    }
  }));
  results.sort((left, right) => left.iteration - right.iteration);
  const failed = results.filter(result => result.code !== 0 || result.error !== undefined);
  const summary = { testFile, iterations: settings.iterations, concurrency: Math.min(settings.concurrency, settings.iterations),
    passed: results.length - failed.length, failed: failed.length, durationMs: Date.now() - started, results };
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`Parallel worktree stress: ${summary.passed}/${summary.iterations} passed. Summary: ${join(directory, "summary.json")}`);
  if (failed.length) process.exitCode = 1;
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
