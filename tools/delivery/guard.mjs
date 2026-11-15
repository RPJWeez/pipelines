import assert from "node:assert/strict";
import fs from "node:fs";
import {
  descriptor,
  read,
  write,
  identity,
  shaRE,
  nameRE,
  reference,
  relative,
} from "./contracts.mjs";
import { run } from "./registry.mjs";
const [descriptorPath, output] = process.argv.slice(2);
relative(process.env.DESCRIPTOR || ".delivery/application.json");
let d = descriptor(read(descriptorPath));
assert.equal(
  d.releaseBranch,
  process.env.CONTROL_BRANCH,
  "delivery control must use the repository default branch, not a branch-supplied policy override",
);
assert.equal(
  process.env.GITHUB_EVENT_NAME,
  "workflow_dispatch",
  "manual dispatch required",
);
assert.equal(
  process.env.GITHUB_REF,
  `refs/heads/${d.releaseBranch}`,
  "dispatch the workflow on protected release branch",
);
assert.equal(
  process.env.GITHUB_REF_PROTECTED,
  "true",
  "protected release branch required",
);
const operation = process.env.OPERATION;
assert(["dev", "release", "compose", "promote"].includes(operation));
const sourceRef =
  operation === "dev" ? process.env.SOURCE_REF : d.releaseBranch;
assert.match(sourceRef, /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/);
assert(!sourceRef.includes("..") && !sourceRef.startsWith("refs/"));
// REST branch lookup is repository-scoped. Inputs cannot inject git/shell options.
const branch = JSON.parse(
  run("gh", [
    "api",
    `repos/${process.env.GITHUB_REPOSITORY}/branches/${encodeURIComponent(sourceRef)}`,
  ]),
);
assert.match(branch.commit.sha, shaRE);
if (operation === "dev") {
  const sourceDescriptor = JSON.parse(
    run("gh", [
      "api",
      `repos/${process.env.GITHUB_REPOSITORY}/contents/${process.env.DESCRIPTOR || ".delivery/application.json"}?ref=${branch.commit.sha}`,
    ]),
  );
  const declared = JSON.parse(
    Buffer.from(sourceDescriptor.content, "base64").toString("utf8"),
  );
  // Branches may add dev components/charts without first merging those declarations.
  // Application identity and every trust decision remain controlled by protected main.
  d = descriptor({
    ...declared,
    application: d.application,
    releaseBranch: d.releaseBranch,
    policy: d.policy,
  });
}

if (operation !== "dev")
  assert.equal(
    branch.commit.sha,
    process.env.GITHUB_SHA,
    "main moved; dispatch again against its current commit",
  );
const composer = identity({
  repository: process.env.GITHUB_REPOSITORY,
  source: branch.commit.sha,
  sourceRef: `refs/heads/${sourceRef}`,
  controlSource: process.env.GITHUB_SHA,
  workflow: process.env.GITHUB_WORKFLOW_REF,
  pipelineRepository: process.env.PIPELINE_REPOSITORY,
  pipelineRevision: process.env.PIPELINE_REVISION,
  run: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
});
assert.equal(composer.pipelineRepository, d.policy.pipelineRepository);
assert(
  d.policy.trustedPipelineRevisions.includes(composer.pipelineRevision),
  "pipeline revision must be allowed by protected descriptor",
);
if (["compose", "promote"].includes(operation))
  reference(process.env.CANDIDATE);
if (operation === "promote") assert.match(process.env.RELEASE_ID, nameRE);
fs.mkdirSync(output, { recursive: true });
write(`${output}/descriptor.json`, d);
write(`${output}/composer.json`, composer);
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `source=${composer.source}\nenvironment=${operation === "dev" ? "delivery-dev" : operation === "promote" ? "delivery-promotion" : "delivery-release"}\n`,
  );
