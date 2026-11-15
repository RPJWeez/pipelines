import assert from "node:assert/strict";
import fs from "node:fs";
import { descriptor, read, write, compose, reference } from "./contracts.mjs";
import { loadPackage, verifyImages } from "./registry.mjs";
const [descriptorPath, composerPath, output] = process.argv.slice(2);
const d = descriptor(read(descriptorPath)),
  composer = read(composerPath);
const baselineRef = process.env.CANDIDATE;
const baseline = loadPackage(baselineRef, d, composer.repository);
verifyImages(baseline, d, composer.repository);
const refs = JSON.parse(process.env.OVERRIDES || "{}");
assert(refs && typeof refs === "object" && !Array.isArray(refs));
assert(Object.keys(refs).length <= Object.keys(d.components).length);
const overrides = {};
for (const [name, ref] of Object.entries(refs)) {
  assert(Object.hasOwn(d.components, name), "unknown component override");
  reference(ref);
  const manifest = loadPackage(ref, d, composer.repository, name);
  verifyImages(manifest, d, composer.repository, name);
  overrides[name] = { manifest };
}
const selected = compose(
  d,
  baseline,
  overrides,
  composer.repository,
  composer,
  process.env.REASON,
);
selected.baseline = baselineRef;
selected.overrides = refs;
fs.mkdirSync(output, { recursive: true });
write(`${output}/selection.json`, selected);
