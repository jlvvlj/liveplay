import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tests = path.dirname(fileURLToPath(import.meta.url));
const python =
  process.env.INSTRUMENT_LAB_PYTHON || path.join(tests, "../.venv/bin/python");
const commands = [
  [
    process.execPath,
    [
      "--test",
      ...readdirSync(tests)
        .filter((f) => f.endsWith(".test.mjs"))
        .map((f) => path.join(tests, f)),
    ],
  ],
  [python, ["-m", "unittest", "discover", "-s", tests, "-p", "test_*.py"]],
];
for (const [command, args] of commands) {
  const run = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, OPENBLAS_NUM_THREADS: "1" },
  });
  if (run.error) {
    console.error(
      "Run npm run setup:instruments before the analysis tests.",
      run.error.message,
    );
    process.exit(1);
  }
  if (run.status !== 0) process.exit(run.status || 1);
}
