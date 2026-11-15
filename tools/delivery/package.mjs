import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import {
  descriptor,
  read,
  write,
  reference,
  digestRE,
  identity,
  validatePackage,
} from "./contracts.mjs";
import { run, sha256 } from "./registry.mjs";
import { validateRendered } from "../pipeline/candidate.mjs";
const script = (name) =>
  path.join(path.dirname(new URL(import.meta.url).pathname), name);
export function bind(d, values, images) {
  const result = structuredClone(values);
  const workloads = result.application?.workloads || {};
  const expected = Object.values(d.components)
    .flatMap((c) => c.workloads)
    .sort();
  assert.deepEqual(
    Object.keys(workloads).sort(),
    expected,
    "chart workload inventory differs from descriptor",
  );
  for (const [name, c] of Object.entries(d.components))
    for (const workload of c.workloads) {
      assert(
        ["BUILD_OUTPUT", `BUILD_OUTPUT:${name}`].includes(
          workloads[workload].image,
        ),
        "source chart must use build placeholders",
      );
      workloads[workload].image = images[name].reference;
    }
  return result;
}
export function inspectOCI(directory) {
  assert.equal(
    read(path.join(directory, "oci-layout")).imageLayoutVersion,
    "1.0.0",
  );
  const index = read(path.join(directory, "index.json"));
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.manifests?.length, 1, "one OCI root required");
  const root = index.manifests[0];
  assert.match(root.digest, digestRE);
  const seen = new Set();
  const visit = (entry) => {
    assert.match(entry.digest, digestRE);
    if (seen.has(entry.digest)) return;
    seen.add(entry.digest);
    assert(seen.size <= 10000, "too many OCI blobs");
    const file = path.join(directory, "blobs", "sha256", entry.digest.slice(7));
    assert.equal(fs.statSync(file).size, entry.size, "OCI blob size mismatch");
    assert.equal(sha256(file), entry.digest, "OCI blob digest mismatch");
    if (/manifest|index/.test(entry.mediaType)) {
      assert(entry.size <= 4 * 1024 ** 2, "oversized OCI manifest");
      const m = read(file);
      for (const item of [
        ...(m.manifests || []),
        ...(m.layers || []),
        ...(m.config ? [m.config] : []),
      ])
        visit(item);
      if (
        m.config &&
        entry.annotations?.["vnd.docker.reference.type"] !==
          "attestation-manifest"
      ) {
        assert(m.config.size <= 4 * 1024 ** 2, "oversized image config");
        const config = read(
          path.join(directory, "blobs", "sha256", m.config.digest.slice(7)),
        );
        assert.equal(config.os, "linux", "only Linux image output supported");
        assert.equal(
          config.architecture,
          "amd64",
          "only amd64 image output supported",
        );
      }
    }
  };
  visit(root);
  return root.digest;
}
export function unpackChart(archive, dest, chartName) {
  run("python3", [
    script("archive.py"),
    archive,
    dest,
    String(256 * 1024 * 1024),
  ]);
  assert.deepEqual(
    fs.readdirSync(dest),
    [chartName],
    "one expected chart root required",
  );
  return path.join(dest, chartName);
}
export function checkChart(chart, d, manifest) {
  const meta = parse(fs.readFileSync(path.join(chart, "Chart.yaml"), "utf8"));
  assert.equal(meta.name, d.chartName);
  const embedded = read(path.join(chart, "build.json"));
  assert.deepEqual(embedded, manifest, "chart manifest mismatch");
  const rendered = run("helm", [
    "template",
    "candidate",
    chart,
    "--include-crds",
  ]);
  validateRendered(rendered, {
    images: Object.fromEntries(
      Object.entries(manifest.images).map(([n, i]) => [n, i.reference]),
    ),
  });
}
export function prepare(d, source, output, composer, trust, selected) {
  descriptor(d);
  identity(composer);
  fs.mkdirSync(output, { recursive: true });
  let images = selected?.images || {};
  const registry = `ghcr.io/${composer.repository.toLowerCase()}-${trust}`;
  if (!selected && Object.keys(d.components).length) {
    const bake = JSON.parse(
      run("docker", ["buildx", "bake", "--print", "application"], {
        cwd: source,
      }),
    );
    assert.deepEqual(
      [...bake.group.application.targets].sort(),
      Object.keys(d.components).sort(),
      "Bake/descriptor inventory mismatch",
    );
    images = {};
    for (const [name, component] of Object.entries(d.components)) {
      const archive = path.resolve(output, `${name}.tar`);
      // Override all exporters/caches/secrets/platforms from branch Bake definitions.
      const override = path.resolve(output, `${name}.bake.json`);
      const target = bake.target[name];
      assert(
        !target.ssh?.length && !target.secret?.length,
        "credential-bearing builds unsupported",
      );
      write(override, {
        target: {
          [name]: {
            output: [`type=oci,dest=${archive}`],
            tags: [
              `${registry}/${name}:run-${composer.run}-${composer.attempt}`,
            ],
            platforms: ["linux/amd64"],
            "cache-from": [],
            "cache-to": [],
            attest: [
              "type=provenance,mode=max",
              `type=sbom,generator=${read(new URL("../pipeline/config.json", import.meta.url)).sbomGenerator}`,
            ],
          },
        },
      });
      run(
        "docker",
        [
          "buildx",
          "bake",
          `--allow=fs.write=${path.dirname(archive)}`,
          "-f",
          "docker-bake.hcl",
          "-f",
          override,
          name,
        ],
        { cwd: source, stdio: "inherit" },
      );
      const unpacked = path.resolve(output, `${name}.oci`);
      run("python3", [script("archive.py"), archive, unpacked]);
      const digest = inspectOCI(unpacked);
      fs.rmSync(unpacked, { recursive: true });
      images[name] = {
        reference: `${registry}/${name}@${digest}`,
        compatibility: component.compatibility,
        platforms: ["linux/amd64"],
        producer: composer,
      };
    }
  }
  const manifest = {
    schemaVersion: 2,
    kind: "package",
    application: d.application,
    trust,
    chartName: d.chartName,
    configCompatibility: d.configCompatibility,
    composer,
    images,
    ...(selected
      ? {
          composition: true,
          reason: selected.reason,
          baseline: selected.baseline,
          overrides: selected.overrides,
        }
      : {}),
  };
  validatePackage(manifest, d, composer.repository, trust);
  const chart = path.join(source, d.chart);
  const valuesPath = path.join(chart, "values.yaml");
  fs.writeFileSync(
    valuesPath,
    stringify(bind(d, parse(fs.readFileSync(valuesPath, "utf8")), images)),
  );
  const chartPath = path.join(chart, "Chart.yaml");
  const meta = parse(fs.readFileSync(chartPath, "utf8"));
  assert.equal(meta.name, d.chartName);
  meta.version = `0.0.${composer.run}-attempt.${composer.attempt}`;
  meta.appVersion = composer.source;
  fs.writeFileSync(chartPath, stringify(meta));
  write(path.join(chart, "build.json"), manifest);
  run("helm", ["dependency", "build", "--skip-refresh", chart], {
    stdio: "inherit",
  });
  checkChart(chart, d, manifest);
  run("helm", ["lint", chart], { stdio: "inherit" });
  const packaged = path.resolve(output, "charts");
  fs.mkdirSync(packaged, { recursive: true });
  run("helm", ["package", chart, "--destination", packaged], {
    stdio: "inherit",
  });
  const archives = fs.readdirSync(packaged);
  assert.equal(archives.length, 1);
  fs.renameSync(
    path.join(packaged, archives[0]),
    path.join(output, "chart.tgz"),
  );
  fs.rmSync(packaged, { recursive: true });
  for (const f of fs
    .readdirSync(output)
    .filter((f) => f.endsWith(".bake.json")))
    fs.rmSync(path.join(output, f));
  write(path.join(output, "package.json"), manifest);
  return manifest;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [d, source, output, composer, trust, selected] = process.argv.slice(2);
  prepare(
    read(d),
    source,
    output,
    read(composer),
    trust,
    selected ? read(selected) : undefined,
  );
}
