import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseAllDocuments } from "yaml";

test("chart SBOM inventories the packaged artifact as a directory", () => {
  const action = parseAllDocuments(
    readFileSync(".github/actions/publish-chart/action.yml", "utf8"),
  )[0].toJSON();
  const inventory = action.runs.steps.find((step) => step.id === "inventory");
  const scanner = action.runs.steps.find((step) =>
    step.uses?.startsWith("anchore/sbom-action@"),
  );
  const directory = mkdtempSync(join(tmpdir(), "fieldsignal-chart-inventory-"));
  try {
    execFileSync("helm", [
      "package",
      resolve("tests/fixtures/fieldsignal-charts/application"),
      "--destination",
      directory,
    ]);
    const archive = join(
      directory,
      readdirSync(directory).find((name) => name.endsWith(".tgz")),
    );
    execFileSync("bash", ["-c", inventory.run], {
      cwd: directory,
      env: { ...process.env, ARCHIVE: archive },
    });
    const scanPath = join(directory, scanner.with.path);
    assert(statSync(scanPath).isDirectory());
    assert.equal(
      readFileSync(join(scanPath, "application/Chart.yaml"), "utf8"),
      execFileSync("tar", ["-xOzf", archive, "application/Chart.yaml"], {
        encoding: "utf8",
      }),
    );
    assert(
      !readdirSync(join(scanPath, "application")).includes("project.json"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
