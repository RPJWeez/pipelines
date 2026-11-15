import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";

// Only native GitHub triggers, forms and calls are installed in an application.
export function scaffold(
  destination,
  pipelineRepository = "RPJWeez/pipelines",
  version = "v1",
) {
  assert.match(pipelineRepository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(version, /^[A-Za-z0-9_.-]+$/);
  const read = { contents: "read", actions: "read", "pull-requests": "read" };
  const publish = {
    ...read,
    packages: "write",
    "id-token": "write",
    attestations: "write",
  };
  const input = (description, required = true, def) => ({
    type: "string",
    description,
    ...(required ? { required: true } : {}),
    ...(def === undefined ? {} : { default: def }),
  });
  const manual = (
    name,
    workflow,
    inputs,
    withInputs,
    permissions = publish,
  ) => ({
    name,
    on: { workflow_dispatch: { inputs } },
    permissions: { contents: "read" },
    jobs: {
      run: {
        uses: `${pipelineRepository}/.github/workflows/${workflow}@${version}`,
        permissions,
        ...(withInputs ? { with: withInputs } : {}),
      },
    },
  });
  const workflows = {
    "ci.yml": {
      name: "Application CI",
      on: { push: { branches: ["**"] }, pull_request: {}, merge_group: {} },
      permissions: { contents: "read" },
      jobs: {
        delivery: {
          uses: `${pipelineRepository}/.github/workflows/validate.yml@${version}`,
          permissions: read,
          concurrency: {
            group: "validation-${{ github.ref }}",
            "cancel-in-progress": true,
          },
        },
      },
    },
    "dev-package.yml": manual(
      "Create dev package",
      "dev-package.yml",
      { "source-ref": input("Branch to package") },
      { "source-ref": "${{ inputs.source-ref }}" },
    ),
    "release-candidate.yml": manual(
      "Create release candidate",
      "release-candidate.yml",
      {},
      undefined,
    ),
    "compose-candidate.yml": manual(
      "Compose release candidate",
      "compose-candidate.yml",
      {
        candidate: input("Baseline candidate digest reference"),
        overrides: input(
          "JSON component to candidate reference map",
          false,
          "{}",
        ),
        reason: input("Reason for this component selection"),
      },
      {
        candidate: "${{ inputs.candidate }}",
        overrides: "${{ inputs.overrides }}",
        reason: "${{ inputs.reason }}",
      },
    ),
    "promote-release.yml": manual(
      "Promote release candidate",
      "promote.yml",
      {
        candidate: input("Candidate digest reference"),
        "release-id": input("Release name, e.g. v1.2.3"),
        "qa-run": input("Successful QA run URL reviewed for this candidate"),
      },
      {
        candidate: "${{ inputs.candidate }}",
        "release-id": "${{ inputs.release-id }}",
        "qa-run": "${{ inputs.qa-run }}",
      },
      { ...publish, contents: "write" },
    ),
  };
  const directory = path.join(destination, ".github/workflows");
  for (const name of Object.keys(workflows))
    assert(
      !fs.existsSync(path.join(directory, name)),
      `Refusing to overwrite ${name}; generate elsewhere and review the diff`,
    );
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, workflow] of Object.entries(workflows))
    fs.writeFileSync(
      path.join(directory, name),
      stringify(workflow, { lineWidth: 0 }),
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  scaffold(...process.argv.slice(2));
