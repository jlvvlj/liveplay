import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const args of [
  ["venv", "--allow-existing", "--python", "3.11", path.join(root, ".venv")],
  [
    "pip",
    "install",
    "--python",
    path.join(root, ".venv/bin/python"),
    "-r",
    path.join(root, "analysis/requirements.txt"),
  ],
]) {
  const run = spawnSync(process.env.UV_PATH || "uv", args, {
    stdio: "inherit",
  });
  if (run.error) {
    console.error(
      "Install uv and Python 3.11, then run setup:instruments again.",
      run.error.message,
    );
    process.exit(1);
  }
  if (run.status !== 0) process.exit(run.status || 1);
}
console.log(
  "Instrument analysis is ready. Run npm run dev:instruments. FFmpeg must be on PATH.",
);
