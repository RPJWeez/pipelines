import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
export const digestRE = /^sha256:[a-f0-9]{64}$/;
export const shaRE = /^[a-f0-9]{40}$/;
export const nameRE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const predicates = {
  package: "https://delivery-reference-platform.dev/package/v2",
  image: "https://delivery-reference-platform.dev/image/v2",
  release: "https://delivery-reference-platform.dev/release/v1",
};
export const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export const write = (p, v) =>
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
export function relative(p) {
  assert(
    typeof p === "string" &&
      p.length &&
      !p.includes("\\") &&
      !path.posix.isAbsolute(p),
  );
  assert(
    p.split("/").every((x) => x && x !== ".." && x !== ".git"),
    "unsafe relative path",
  );
  return p;
}
export function reference(ref) {
  assert(typeof ref === "string");
  const m = /^(ghcr\.io\/[a-z0-9._/-]+)@(sha256:[a-f0-9]{64})$/.exec(ref);
  assert(
    m && !m[1].includes("..") && !m[1].includes("//"),
    "immutable GHCR reference required",
  );
  return { name: m[1], digest: m[2] };
}
export function descriptor(d) {
  assert.equal(d.schemaVersion, 1, "unsupported descriptor version");
  assert.match(d.application, /^[a-z0-9][a-z0-9._-]{0,99}$/);
  relative(d.chart);
  assert.match(d.releaseBranch, /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/);
  assert(!d.releaseBranch.includes(".."));
  assert.match(d.chartName, nameRE);
  assert(
    d.components &&
      typeof d.components === "object" &&
      !Array.isArray(d.components),
  );
  assert(
    Object.keys(d.components).length <= 256,
    "at most 256 components in this profile",
  );
  for (const [name, c] of Object.entries(d.components)) {
    assert.match(name, nameRE);
    assert(c && typeof c === "object");
    assert(Array.isArray(c.workloads) && c.workloads.length > 0);
    for (const w of c.workloads) assert.match(w, nameRE);
  }
  const workloads = Object.values(d.components).flatMap((c) => c.workloads);
  assert.equal(
    new Set(workloads).size,
    workloads.length,
    "duplicate workload mapping",
  );
  assert.match(d.pipelineRepository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  return d;
}
export function identity(i) {
  assert.match(i.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(i.source, shaRE);
  assert.match(i.controlSource, shaRE);
  assert.match(i.pipelineRevision, shaRE);
  assert.match(i.pipelineRepository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(i.sourceRef, /^refs\/heads\/[A-Za-z0-9/_.-]+$/);
  assert.match(
    i.workflow,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@refs\/heads\/[A-Za-z0-9/_.-]+$/,
  );
  for (const k of ["run", "attempt"])
    assert.match(String(i[k]), /^[1-9][0-9]*$/);
  return i;
}
export function validatePackage(
  p,
  d,
  repository,
  trust = "release",
  component = null,
) {
  descriptor(d);
  assert.equal(p.schemaVersion, 2);
  assert.equal(p.kind, "package");
  assert.equal(p.application, d.application);
  assert.equal(p.trust, trust, "wrong artifact trust class");
  identity(p.composer);
  assert.equal(p.composer.repository, repository);
  assert.equal(p.composer.pipelineRepository, d.pipelineRepository);
  assert(p.images && typeof p.images === "object" && !Array.isArray(p.images));
  if (component) {
    assert(
      Object.hasOwn(d.components, component) &&
        Object.hasOwn(p.images, component),
      "selected component absent",
    );
  } else
    assert.deepEqual(
      Object.keys(p.images).sort(),
      Object.keys(d.components).sort(),
      "incomplete/extra component inventory",
    );
  // An override imports one image, not the historical package's other components/config.
  const selectedImages = component
    ? [[component, p.images[component]]]
    : Object.entries(p.images);
  for (const [name, image] of selectedImages) {
    const ref = reference(image.reference);
    assert.equal(
      ref.name,
      `ghcr.io/${repository.toLowerCase()}-${trust}/${name}`,
      "cross-application image",
    );
    assert.deepEqual(image.platforms, ["linux/amd64"], "unsupported platform");
    identity(image.producer);
    assert.equal(image.producer.repository, repository);
    assert.equal(image.producer.pipelineRepository, d.pipelineRepository);
    if (trust === "release")
      assert.equal(image.producer.sourceRef, `refs/heads/${d.releaseBranch}`);
  }
  if (trust === "release")
    assert.equal(p.composer.sourceRef, `refs/heads/${d.releaseBranch}`);
  assert.equal(p.chartName, d.chartName);
  return p;
}
export function compose(d, baseline, overrides, repository, composer, reason) {
  validatePackage(baseline, d, repository);
  assert(
    reason && reason.trim().length >= 8 && reason.length <= 1000,
    "composition reason required",
  );
  assert(
    overrides && typeof overrides === "object" && !Array.isArray(overrides),
  );
  const images = structuredClone(baseline.images);
  for (const [name, selected] of Object.entries(overrides)) {
    assert(Object.hasOwn(images, name), `unknown component ${name}`);
    validatePackage(selected.manifest, d, repository, "release", name);
    images[name] = structuredClone(selected.manifest.images[name]);
  }
  const result = {
    ...structuredClone(baseline),
    composer,
    images,
    reason,
    composition: true,
  };
  return validatePackage(result, d, repository);
}
export function existingDesignation(previous, proposed) {
  assert.equal(previous.schemaVersion, 1);
  assert.equal(previous.kind, "release");
  for (const key of ["application", "candidate", "releaseId", "qaRun"])
    assert.equal(
      previous[key],
      proposed[key],
      `release identifier conflict: ${key}`,
    );
  identity(previous.promotedBy);
  assert.equal(previous.promotedBy.repository, proposed.promotedBy.repository);
  return previous;
}

export const releaseRE =
  /^(?!.*\.\.)(?!.*\.lock$)[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/;
