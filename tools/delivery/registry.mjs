import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { reference, predicates, validatePackage } from "./contracts.mjs";
export const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
// Verify signatures before interpreting predicates. CLI stdout contains only verified results.
export function verified(ref, policy, workflow, predicateType, source) {
  reference(ref);
  const args = [
    "attestation",
    "verify",
    `oci://${ref}`,
    "--repo",
    policy.repository,
    "--signer-workflow",
    workflow,
    "--source-ref",
    policy.ref,
    "--predicate-type",
    predicateType,
    "--format",
    "json",
    "--deny-self-hosted-runners",
    "--bundle-from-oci",
    "--limit",
    "100",
  ];
  if (policy.revision) args.push("--signer-digest", policy.revision);
  if (source) args.push("--source-digest", source);
  const results = JSON.parse(
    run(
      "gh",
      args,
      policy.token ? { env: { ...process.env, GH_TOKEN: policy.token } } : {},
    ),
  );
  assert(Array.isArray(results) && results.length, "no verified attestations");
  const statements = results
    .map((r) => r.verificationResult?.statement)
    .filter(Boolean);
  assert(statements.length, "verified statement missing");
  const digest = reference(ref).digest.slice(7);
  const predicatesFound = statements
    .filter(
      (s) =>
        s.predicateType === predicateType &&
        s.subject?.some((x) => x.digest?.sha256 === digest),
    )
    .map((s) => s.predicate);
  assert(predicatesFound.length, "verified subject/predicate missing");
  return predicatesFound;
}
export function loadPackage(ref, d, repository, component = null) {
  const expected = `ghcr.io/${repository.toLowerCase()}-release-packages/${d.chartName}`;
  assert.equal(reference(ref).name, expected, "wrong candidate repository");
  const results = verified(
    ref,
    { repository, ref: `refs/heads/${d.releaseBranch}` },
    `${d.pipelineRepository}/.github/workflows/package.yml`,
    predicates.package,
  );
  const p = results.find(
    (x) => x.composer?.pipelineRepository === d.pipelineRepository,
  );
  assert(p, "No package from the shared package workflow");
  validatePackage(p, d, repository, "release", component);
  approvedRevision(d.pipelineRepository, p.composer.pipelineRevision);
  const bound = verified(
    ref,
    {
      repository,
      revision: p.composer.pipelineRevision,
      ref: `refs/heads/${d.releaseBranch}`,
    },
    `${d.pipelineRepository}/.github/workflows/package.yml`,
    predicates.package,
    p.composer.controlSource,
  );
  assert(
    bound.some((x) => JSON.stringify(x) === JSON.stringify(p)),
    "package composer/source mismatch",
  );
  return p;
}
export function verifyImages(p, d, repository, component = null) {
  for (const image of component
    ? [p.images[component]]
    : Object.values(p.images)) {
    const producer = image.producer;
    approvedRevision(d.pipelineRepository, producer.pipelineRevision);
    const found = verified(
      image.reference,
      {
        repository,
        revision: producer.pipelineRevision,
        ref: `refs/heads/${d.releaseBranch}`,
      },
      `${d.pipelineRepository}/.github/workflows/package.yml`,
      predicates.image,
      producer.controlSource,
    );
    assert(
      found.some(
        (x) =>
          JSON.stringify(x.producer) === JSON.stringify(producer) &&
          x.source === producer.source &&
          x.reference === image.reference,
      ),
      "image producer mismatch",
    );
    verified(
      image.reference,
      {
        repository,
        revision: producer.pipelineRevision,
        ref: `refs/heads/${d.releaseBranch}`,
      },
      `${d.pipelineRepository}/.github/workflows/package.yml`,
      "https://spdx.dev/Document",
      producer.controlSource,
    );
  }
}
export function sha256(p) {
  const hash = createHash("sha256"),
    fd = fs.openSync(p, "r"),
    buffer = Buffer.alloc(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, size));
  } finally {
    fs.closeSync(fd);
  }
  return "sha256:" + hash.digest("hex");
}

const reviewed = new Set();
export function approvedRevision(repository, revision) {
  const key = repository + "@" + revision;
  if (reviewed.has(key)) return;
  const options = {
    env: {
      ...process.env,
      GH_TOKEN: process.env.PLATFORM_READ_TOKEN || process.env.GH_TOKEN,
    },
  };
  const repo = JSON.parse(run("gh", ["api", `repos/${repository}`], options));
  const comparison = JSON.parse(
    run(
      "gh",
      [
        "api",
        `repos/${repository}/compare/${revision}...${encodeURIComponent(repo.default_branch)}`,
      ],
      options,
    ),
  );
  assert(
    ["ahead", "identical"].includes(comparison.status),
    "Pipeline implementation must be merged into its default branch before publishing",
  );
  reviewed.add(key);
}
