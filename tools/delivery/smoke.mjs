// Local/hosted conformance only: no registry publication and no cluster access.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, unpackChart, checkChart } from "./package.mjs";
import { read } from "./contracts.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-smoke-"));
try {
  const source = path.join(root, "source");
  fs.cpSync("tests/fixtures/delivery-static", source, { recursive: true });
  const d = read("bootstrap/example-application.json"),
    sha = "a".repeat(40);
  const composer = {
    repository: "example/static",
    source: sha,
    sourceRef: "refs/heads/topic",
    controlSource: sha,
    workflow:
      "example/static/.github/workflows/create-dev-package.yml@refs/heads/main",
    pipelineRepository: d.policy.pipelineRepository,
    pipelineRevision: d.policy.trustedPipelineRevisions[0],
    run: "123",
    attempt: "1",
  };
  const output = path.join(root, "output");
  const manifest = prepare(d, source, output, composer, "dev");
  const chart = unpackChart(
    path.join(output, "chart.tgz"),
    path.join(root, "unpacked"),
    d.chartName,
  );
  checkChart(chart, d, manifest);
  console.log(
    "Non-Nx Docker OCI export, blob verification and Helm package conformance passed. No publication or deployment.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
