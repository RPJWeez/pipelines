import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  descriptor,
  read,
  write,
  validatePackage,
  reference,
  predicates,
} from "./contracts.mjs";
import { unpackChart, checkChart, inspectOCI } from "./package.mjs";
import { run, verifyImages } from "./registry.mjs";
const [mode, dPath, composerPath, payload, output, target] =
  process.argv.slice(2);
const d = descriptor(read(dPath)),
  composer = read(composerPath);
const trust = process.env.TRUST_CLASS;
assert(["dev", "release"].includes(trust));
const manifest = validatePackage(
  read(path.join(payload, "package.json")),
  d,
  composer.repository,
  trust,
);
assert.deepEqual(manifest.composer, composer, "untrusted composer identity");
fs.mkdirSync(output, { recursive: true });
// The read-only inspect job validated/rendered the exact artifact ID consumed here.
// Extract again only for SBOM inventory; never run chart templates in this privileged job.
unpackChart(
  path.join(payload, "chart.tgz"),
  path.join(output, "chart"),
  d.chartName,
);
if (!manifest.composition) {
  for (const image of Object.values(manifest.images))
    assert.deepEqual(
      image.producer,
      composer,
      "producer differs from build source",
    );
}
if (mode === "image") {
  assert(!manifest.composition);
  assert(Object.hasOwn(d.components, target));
  const image = manifest.images[target],
    ref = reference(image.reference);
  const unpacked = path.join(output, "oci");
  run("python3", [
    new URL("./archive.py", import.meta.url).pathname,
    path.join(payload, `${target}.tar`),
    unpacked,
  ]);
  assert.equal(
    inspectOCI(unpacked),
    ref.digest,
    "published image differs from manifest",
  );
  // No branch code or image entrypoint executes in this job. Copy data by content digest.
  run(
    "skopeo",
    [
      "copy",
      "--all",
      "--preserve-digests",
      `oci:${unpacked}`,
      `docker://${ref.name}:run-${composer.run}-${composer.attempt}`,
    ],
    { stdio: "inherit" },
  );
  const raw = run("skopeo", [
    "inspect",
    "--raw",
    `docker://${image.reference}`,
  ]);
  assert(raw.trim(), "published image unavailable");
  write(path.join(output, "image.json"), {
    schemaVersion: 2,
    source: composer.source,
    reference: image.reference,
    compatibility: image.compatibility,
    producer: image.producer,
  });
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `name=${ref.name}\ndigest=${ref.digest}\n`,
  );
} else {
  assert.equal(mode, "chart");
  if (trust === "release") verifyImages(manifest, d, composer.repository);
  const registry = `ghcr.io/${composer.repository.toLowerCase()}-${trust}-packages`;
  run("helm", ["push", path.join(payload, "chart.tgz"), `oci://${registry}`], {
    stdio: "inherit",
  });
  // Resolve the just-published unique run/attempt tag once. No mutable latest pointer.
  const version = `0.0.${composer.run}-attempt.${composer.attempt}`;
  const log = run(
    "helm",
    [
      "pull",
      `oci://${registry}/${d.chartName}`,
      "--version",
      version,
      "--destination",
      output,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  // Helm writes its digest to stderr; resolve OCI manifest using skopeo instead.
  void log;
  const raw = run("skopeo", [
    "inspect",
    "--raw",
    `docker://${registry}/${d.chartName}:${version}`,
  ]);
  const { createHash } = await import("node:crypto");
  const digest = "sha256:" + createHash("sha256").update(raw).digest("hex");
  const ref = `${registry}/${d.chartName}@${digest}`;
  write(path.join(output, "package.json"), manifest);
  write(path.join(output, "handoff.json"), {
    package: ref,
    source: composer.source,
    trust,
    qa: "pending",
    certification: "pending",
  });
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `name=${registry}/${d.chartName}\ndigest=${digest}\nreference=${ref}\n`,
  );
  fs.writeFileSync(
    path.join(output, "summary.md"),
    `## ${trust === "dev" ? "Dev package" : "Release candidate"} published\n\n\`${ref}\`\n\nSource: \`${composer.source}\`. QA and certification pending. No deployment occurred.\n`,
  );
}
