import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { reference, predicates, read, validatePackage } from "./contracts.mjs";
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
    "--signer-digest",
    policy.revision,
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
export function loadPackage(ref, d, repository) {
  const expected = `ghcr.io/${repository.toLowerCase()}-release-packages/${d.chartName}`;
  assert.equal(reference(ref).name, expected, "wrong candidate repository");
  let p;
  for (const revision of d.policy.trustedPipelineRevisions) {
    try {
      const results = verified(
        ref,
        { repository, revision, ref: `refs/heads/${d.releaseBranch}` },
        `${d.policy.pipelineRepository}/.github/workflows/package.yml`,
        predicates.package,
      );
      p = results.find((x) => x.composer?.pipelineRevision === revision);
      if (p) break;
    } catch {
      /* Try only explicitly trusted revisions; fail closed below. */
    }
  }
  assert(p, "no trusted package evidence");
  return validatePackage(p, d, repository);
}
export function verifyImages(p, d, repository) {
  for (const image of Object.values(p.images)) {
    const producer = image.producer;
    const found = verified(
      image.reference,
      {
        repository,
        revision: producer.pipelineRevision,
        ref: `refs/heads/${d.releaseBranch}`,
      },
      `${d.policy.pipelineRepository}/.github/workflows/package.yml`,
      predicates.image,
      producer.controlSource,
    );
    assert(
      found.some(
        (x) =>
          JSON.stringify(x.producer) === JSON.stringify(producer) &&
          x.source === producer.source &&
          x.reference === image.reference &&
          x.compatibility === image.compatibility,
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
      `${d.policy.pipelineRepository}/.github/workflows/package.yml`,
      "https://spdx.dev/Document",
      producer.controlSource,
    );
  }
}
export function pullChart(ref, destination) {
  reference(ref);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chart-pull-"));
  const output = run("helm", ["pull", `oci://${ref}`, "--destination", tmp]);
  const files = fs.readdirSync(tmp).filter((x) => x.endsWith(".tgz"));
  assert.equal(files.length, 1, output);
  fs.copyFileSync(path.join(tmp, files[0]), destination);
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
