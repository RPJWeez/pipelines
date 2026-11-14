import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
const task = JSON.parse(process.env.PROJECT_TASK);
assert(task.id && task.project && task.label, "project task identity required");
// Native Nx/Maven commands run at reactor/workspace root; declared custom commands use cwd.
const cwd = task.command ? path.resolve(task.root) : process.cwd();
assert(
  cwd === process.cwd() || cwd.startsWith(process.cwd() + path.sep),
  "task cwd outside checkout",
);
const argv = task.command
  ? ["bash", "-euo", "pipefail", "-c", task.command]
  : task.argv;
assert(Array.isArray(argv) && argv.length, "native command required");
console.log(
  `${task.label}\nCommand: ${argv.join(" ")}\nWorking directory: ${cwd}`,
);
const delimiter = randomUUID();
fs.appendFileSync(
  process.env.GITHUB_ENV,
  `VALIDATION_COMMAND<<${delimiter}\n${task.command || argv.join(" ")}\n${delimiter}\n`,
);
const result = spawnSync(argv[0], argv.slice(1), {
  cwd,
  stdio: "inherit",
  env: { ...process.env, GITHUB_STEP_SUMMARY: "/dev/null" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
