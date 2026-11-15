// Conformance only: no publication or deployment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, unpackChart, checkChart } from "./package.mjs";
import { discoverLocal } from "./discover.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-smoke-"));
try {
  const source = path.join(root, "source");
  fs.cpSync("tests/fixtures/delivery-static", source, { recursive: true });
  const sha = "a".repeat(40),
    repository = "example/static",
    pipelineRepository = "example/pipelines";
  const d = discoverLocal(source, {
    repository,
    pipelineRepository,
    branch: "main",
  });
  const composer = {
    repository,
    source: sha,
    sourceRef: "refs/heads/topic",
    controlSource: sha,
    workflow: "example/static/.github/workflows/ci.yml@refs/heads/main",
    pipelineRepository,
    pipelineRevision: sha,
    run: "123",
    attempt: "1",
  };
  const output = path.join(root, "output"),
    manifest = prepare(d, source, output, composer, "dev");
  checkChart(
    unpackChart(
      path.join(output, "chart.tgz"),
      path.join(root, "unpacked"),
      d.chartName,
    ),
    d,
    manifest,
  );
  console.log(
    "Native declaration discovery, OCI export and Helm packaging passed. No publication or deployment.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
