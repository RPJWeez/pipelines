import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { descriptor, relative } from "./contracts.mjs";

// Read existing chart declarations. No second service inventory or application config.
export function discover(
  paths,
  readText,
  { repository, branch, pipelineRepository, chart = "" },
) {
  const candidates = paths.filter(
    (p) =>
      p.endsWith("Chart.yaml") &&
      !/(^|\/)(node_modules|\.git|\.work|\.platform|target|dist)(\/|$)/.test(p),
  );
  const matches = [];
  for (const file of candidates) {
    const root = path.posix.dirname(file);
    if (chart && root !== chart) continue;
    const valuesFile = path.posix.join(root, "values.yaml");
    if (!paths.includes(valuesFile)) continue;
    const values = parse(readText(valuesFile));
    if (!values?.application?.workloads) continue;
    const meta = parse(readText(file));
    const components = Object.create(null);
    for (const [name, workload] of Object.entries(
      values.application.workloads,
    )) {
      const target =
        workload.image === "BUILD_OUTPUT"
          ? name
          : /^BUILD_OUTPUT:([a-z0-9-]+)$/.exec(workload.image || "")?.[1];
      assert(
        target,
        `Chart workload ${name} must use BUILD_OUTPUT or BUILD_OUTPUT:<target>`,
      );
      (components[target] ||= { workloads: [] }).workloads.push(name);
    }
    matches.push({
      schemaVersion: 1,
      application: repository.split("/")[1].toLowerCase(),
      chart: relative(root),
      chartName: meta.name,
      releaseBranch: branch,
      pipelineRepository,
      components,
    });
  }
  assert.equal(
    matches.length,
    1,
    "Expected one application chart with application.workloads; pass chart when the repository has more than one",
  );
  return descriptor(matches[0]);
}
export function discoverLocal(root, context) {
  const paths = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      if (
        [
          "node_modules",
          ".git",
          ".work",
          ".platform",
          "target",
          "dist",
        ].includes(entry.name)
      )
        continue;
      const p = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) paths.push(p);
    }
  };
  walk("");
  return discover(
    paths,
    (p) => fs.readFileSync(path.join(root, p), "utf8"),
    context,
  );
}
