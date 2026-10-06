# Automatic checks

`.github/workflows/checks.yml` runs on pushes, pull requests, and manual requests. It installs the locked dependencies, runs typechecking and the complete regression suite, then repeats the real-Pi host parallel worktree test 40 times with eight concurrent workers.

Run the same checks locally:

```sh
npm ci
npm run typecheck
npm test
npm run test:workspace:stress
```

The stress command uses the repo's Node installation and its existing `test/worktree-host-parallel.test.ts` public-host fixture. Each invocation creates disposable repositories and checks actual shell, read, and write effects, parent contents, and Supervised group completion.

For a shorter local run:

```sh
npm run test:workspace:stress -- --iterations 10 --concurrency 4
```

Each stress run writes a summary and the output of failed iterations under `test-results/worktree-stress/run-*`. Use `--log-dir PATH` to select another output directory. Any failed iteration, process-start error, or 60-second invocation timeout makes the command fail. GitHub retains the stress results for seven days, including when another check fails.
