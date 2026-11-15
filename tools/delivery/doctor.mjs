import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { descriptor, read } from "./contracts.mjs";
const root = process.argv[2] || ".";
const d = descriptor(read(path.join(root, ".delivery/application.json")));
assert(fs.existsSync(path.join(root, d.chart, "Chart.yaml")), "chart absent");
assert.equal(
  parse(fs.readFileSync(path.join(root, d.chart, "Chart.yaml"), "utf8")).name,
  d.chartName,
);
for (const file of [
  "ci",
  "create-dev-package",
  "create-release-candidate",
  "compose-release-candidate",
  "promote-release-candidate",
]) {
  const w = parse(
    fs.readFileSync(
      path.join(root, ".github/workflows", file + ".yml"),
      "utf8",
    ),
  );
  for (const job of Object.values(w.jobs)) {
    const match = /@([a-f0-9]{40})$/.exec(job.uses || "");
    assert(
      match && d.policy.trustedPipelineRevisions.includes(match[1]),
      `untrusted/unpinned caller ${file}`,
    );
  }
}
console.log("Local descriptor, chart and caller preflight passed.");
console.log(
  "Hosted activation still requires protected main, delivery-dev/release/promotion environments, registry retention, decision-ledger access and trusted qualification evidence.",
);
