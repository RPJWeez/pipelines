import assert from "node:assert/strict";
import fs from "node:fs";
import { write, identity, shaRE, releaseRE, reference } from "./contracts.mjs";
import { run, approvedRevision } from "./registry.mjs";
import { discover } from "./discover.mjs";
const [output] = process.argv.slice(2);
const branchName = process.env.CONTROL_BRANCH;
assert(branchName, "GitHub default branch is required");
assert.equal(
  process.env.GITHUB_EVENT_NAME,
  "workflow_dispatch",
  "manual dispatch required",
);
assert.equal(
  process.env.GITHUB_REF,
  `refs/heads/${branchName}`,
  "Run delivery from the repository default branch",
);
const operation = process.env.OPERATION;
assert(["dev", "release", "compose", "promote"].includes(operation));
const builderWorkflow = process.env.BUILDER_WORKFLOW;
const operations = {
  "build-package.yml": ["dev", "release"],
  "compose-candidate.yml": ["compose"],
  "promote.yml": ["promote"],
};
if (builderWorkflow)
  assert(
    operations[builderWorkflow]?.includes(operation),
    "Operation does not belong to this pipeline",
  );
const sourceRef = operation === "dev" ? process.env.SOURCE_REF : branchName;
assert.match(sourceRef, /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/);
assert(!sourceRef.includes("..") && !sourceRef.startsWith("refs/"));
const repository = process.env.GITHUB_REPOSITORY;
const branch = JSON.parse(
  run("gh", [
    "api",
    `repos/${repository}/branches/${encodeURIComponent(sourceRef)}`,
  ]),
);
assert.match(branch.commit.sha, shaRE);
if (operation !== "dev")
  assert.equal(
    branch.commit.sha,
    process.env.GITHUB_SHA,
    "Main moved; run delivery again",
  );
const tree = JSON.parse(
  run("gh", [
    "api",
    `repos/${repository}/git/trees/${branch.commit.sha}?recursive=1`,
  ]),
);
assert(
  !tree.truncated,
  "Repository tree is too large; use a chart-specific adapter",
);
const files = tree.tree
  .filter((e) => e.type === "blob" && e.mode !== "120000")
  .map((e) => e.path);
const d = discover(
  files,
  (p) => {
    const file = JSON.parse(
      run("gh", [
        "api",
        `repos/${repository}/contents/${p}?ref=${branch.commit.sha}`,
      ]),
    );
    return Buffer.from(file.content, "base64").toString("utf8");
  },
  {
    repository,
    branch: branchName,
    pipelineRepository: process.env.PIPELINE_REPOSITORY,
    chart: process.env.CHART || "",
  },
);
approvedRevision(
  process.env.PIPELINE_REPOSITORY,
  process.env.PIPELINE_REVISION,
);
const composer = identity({
  repository,
  source: branch.commit.sha,
  sourceRef: `refs/heads/${sourceRef}`,
  controlSource: process.env.GITHUB_SHA,
  workflow: process.env.GITHUB_WORKFLOW_REF,
  pipelineRepository: process.env.PIPELINE_REPOSITORY,
  pipelineRevision: process.env.PIPELINE_REVISION,
  ...(builderWorkflow ? { builderWorkflow } : {}),
  run: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
});
if (["compose", "promote"].includes(operation))
  reference(process.env.CANDIDATE);
if (operation === "promote") assert.match(process.env.RELEASE_ID, releaseRE);
fs.mkdirSync(output, { recursive: true });
write(`${output}/descriptor.json`, d);
write(`${output}/composer.json`, composer);
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `source=${composer.source}\n`);
