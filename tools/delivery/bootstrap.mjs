import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";

// GitHub requires the trigger/form in the application repository. All execution stays here.
export function scaffold(
  destination,
  pipelineRepository = "RPJWeez/pipelines",
  version = "v1",
) {
  assert.match(pipelineRepository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(version, /^[A-Za-z0-9_.-]+$/);
  const file = path.join(destination, ".github/workflows/ci.yml");
  assert(
    !fs.existsSync(file),
    "Refusing to overwrite an existing workflow; generate elsewhere and review the diff",
  );
  const w = {
    name: "Application CI",
    on: {
      push: { branches: ["**"] },
      pull_request: {},
      merge_group: {},
      workflow_dispatch: {
        inputs: {
          operation: {
            type: "choice",
            description: "Delivery operation",
            required: true,
            options: ["dev", "candidate", "compose", "promote"],
          },
          "source-ref": {
            type: "string",
            description: "Dev only: branch to package",
          },
          candidate: {
            type: "string",
            description: "Compose/promote only: candidate digest reference",
          },
          overrides: {
            type: "string",
            default: "{}",
            description:
              "Compose only: JSON component to candidate reference map",
          },
          reason: {
            type: "string",
            description: "Compose only: reason for selecting this combination",
          },
          "release-id": {
            type: "string",
            description: "Promote only: release name, e.g. v1.2.3",
          },
          "qa-run": {
            type: "string",
            description: "Promote only: successful QA run URL you reviewed",
          },
        },
      },
    },
    permissions: { contents: "read" },
    jobs: {
      delivery: {
        if: "github.event_name != 'workflow_dispatch'",
        uses: `${pipelineRepository}/.github/workflows/validate.yml@${version}`,
        permissions: {
          contents: "read",
          actions: "read",
          "pull-requests": "read",
        },
      },
      publish: {
        if: "github.event_name == 'workflow_dispatch'",
        uses: `${pipelineRepository}/.github/workflows/delivery.yml@${version}`,
        permissions: {
          contents: "write",
          actions: "read",
          "pull-requests": "read",
          packages: "write",
          "id-token": "write",
          attestations: "write",
        },
        with: { request: "${{ toJSON(inputs) }}" },
      },
    },
  };
  w.jobs.delivery.concurrency = {
    group: "validation-${{ github.ref }}",
    "cancel-in-progress": true,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(w, { lineWidth: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  scaffold(...process.argv.slice(2));
