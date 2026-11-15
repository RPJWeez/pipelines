import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { descriptor, shaRE, write } from "./contracts.mjs";
export function scaffold(destination, d, revision, checks = []) {
  descriptor(d);
  if (!Object.keys(d.components).length && !checks.length)
    checks = [
      {
        name: "chart",
        command: "helm lint " + "'" + d.chart.replaceAll("'", "'\"'\"'") + "'",
      },
    ];
  assert.match(revision, shaRE);
  assert(d.policy.trustedPipelineRevisions.includes(revision));
  const prefix = `${d.policy.pipelineRepository}/.github/workflows/`;
  const base = { permissions: { contents: "read" } };
  const publication = {
    contents: "read",
    actions: "read",
    "pull-requests": "read",
    packages: "write",
    "id-token": "write",
    attestations: "write",
  };
  const workflows = {
    "ci.yml": {
      name: "Application CI",
      on: { push: { branches: ["**"] }, pull_request: {}, merge_group: {} },
      ...base,
      concurrency: {
        group: "validation-${{ github.ref }}",
        "cancel-in-progress": true,
      },
      jobs: {
        delivery: {
          uses: prefix + "validate.yml@" + revision,
          permissions: {
            contents: "read",
            actions: "read",
            "pull-requests": "read",
          },
          with: {
            deduplicate: true,
            chart: d.chart,
            "project-checks": JSON.stringify(checks),
          },
        },
      },
    },
    "create-dev-package.yml": {
      name: "Create dev package",
      on: {
        workflow_dispatch: {
          inputs: {
            "source-ref": {
              description: "Same-repository branch to package",
              required: true,
              type: "string",
            },
          },
        },
      },
      ...base,
      jobs: {
        package: {
          uses: prefix + "package.yml@" + revision,
          permissions: publication,
          with: {
            operation: "dev",
            "source-ref": "${{ inputs.source-ref }}",
            "project-checks": JSON.stringify(checks),
          },
        },
      },
    },
    "create-release-candidate.yml": {
      name: "Create release candidate",
      on: { workflow_dispatch: {} },
      ...base,
      jobs: {
        package: {
          uses: prefix + "package.yml@" + revision,
          permissions: publication,
          with: {
            operation: "release",
            "project-checks": JSON.stringify(checks),
          },
        },
      },
    },
    "compose-release-candidate.yml": {
      name: "Compose release candidate",
      on: {
        workflow_dispatch: {
          inputs: {
            candidate: {
              description: "Immutable baseline candidate reference",
              required: true,
              type: "string",
            },
            overrides: {
              description: "JSON component to candidate reference mapping",
              default: "{}",
              type: "string",
            },
            reason: {
              description: "Why this component combination is needed",
              required: true,
              type: "string",
            },
          },
        },
      },
      ...base,
      jobs: {
        package: {
          uses: prefix + "package.yml@" + revision,
          permissions: publication,
          with: {
            operation: "compose",
            candidate: "${{ inputs.candidate }}",
            overrides: "${{ inputs.overrides }}",
            reason: "${{ inputs.reason }}",
          },
        },
      },
    },
    "promote-release-candidate.yml": {
      name: "Promote candidate to release",
      on: {
        workflow_dispatch: {
          inputs: {
            candidate: {
              description: "Immutable qualified candidate reference",
              required: true,
              type: "string",
            },
            "release-id": {
              description: "Unique immutable release identifier",
              required: true,
              type: "string",
            },
          },
        },
      },
      ...base,
      jobs: {
        promote: {
          uses: prefix + "promote.yml@" + revision,
          permissions: { ...publication, contents: "write" },
          with: {
            candidate: "${{ inputs.candidate }}",
            "release-id": "${{ inputs.release-id }}",
          },
        },
      },
    },
  };
  for (const name of [
    ...Object.keys(workflows).map((n) => path.join(".github/workflows", n)),
    ".delivery/application.json",
  ]) {
    assert(
      !fs.existsSync(path.join(destination, name)),
      `refusing overwrite: ${name}; generate into a clean directory and review the diff`,
    );
  }
  fs.mkdirSync(path.join(destination, ".github/workflows"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(destination, ".delivery"), { recursive: true });
  write(path.join(destination, ".delivery/application.json"), d);
  for (const [name, w] of Object.entries(workflows)) {
    const target = path.join(destination, ".github/workflows", name);
    assert(
      !fs.existsSync(target),
      `refusing overwrite: ${target}; generate into a clean directory and review the diff`,
    );
    fs.writeFileSync(target, stringify(w, { lineWidth: 0 }));
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [destination, file, revision] = process.argv.slice(2);
  scaffold(destination, JSON.parse(fs.readFileSync(file)), revision);
}
