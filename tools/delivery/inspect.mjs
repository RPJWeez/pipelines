import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { read, descriptor, validatePackage, reference } from "./contracts.mjs";
import { unpackChart, checkChart, inspectOCI } from "./package.mjs";
import { run } from "./registry.mjs";
const [dPath, composerPath, payload, output] = process.argv.slice(2);
const d = descriptor(read(dPath)),
  composer = read(composerPath);
const manifest = validatePackage(
  read(path.join(payload, "package.json")),
  d,
  composer.repository,
  process.env.TRUST_CLASS,
);
assert.deepEqual(manifest.composer, composer);
if (!manifest.composition)
  for (const image of Object.values(manifest.images))
    assert.deepEqual(image.producer, composer);
fs.mkdirSync(output, { recursive: true });
const chart = unpackChart(
  path.join(payload, "chart.tgz"),
  path.join(output, "chart"),
  d.chartName,
);
checkChart(chart, d, manifest);
fs.rmSync(path.join(output, "chart"), { recursive: true });
if (!manifest.composition)
  for (const [name, image] of Object.entries(manifest.images)) {
    const dest = path.join(output, "oci");
    run("python3", [
      new URL("./archive.py", import.meta.url).pathname,
      path.join(payload, name + ".tar"),
      dest,
    ]);
    assert.equal(inspectOCI(dest), reference(image.reference).digest);
    fs.rmSync(dest, { recursive: true });
  }
// Upload only validated data under a new immutable artifact ID from this read-only job.
for (const file of fs.readdirSync(payload))
  fs.copyFileSync(path.join(payload, file), path.join(output, file));
