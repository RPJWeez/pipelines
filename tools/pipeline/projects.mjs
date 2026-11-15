import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runIdentity } from "./context.mjs";
const safeRoot = (root) => {
  assert(
    typeof root === "string" &&
      !path.isAbsolute(root) &&
      !root.split(/[\\/]/).includes(".."),
    "project root must stay inside checkout",
  );
  return root;
};
const id = (name) =>
  createHash("sha256").update(name).digest("hex").slice(0, 16);
export function projectPlan({
  graph = { nodes: {} },
  selected = null,
  bake,
  mavenRoots = [],
  checks = [],
  fallback = "",
  event = "pull_request",
  allowEmptyImages = false,
  skipImages = false,
}) {
  const all = bake.group?.application?.targets;
  assert(
    Array.isArray(all) && (allowEmptyImages || all.length > 0),
    "Bake application group must not be empty",
  );
  assert.equal(new Set(all).size, all.length, "duplicate image target");
  for (const target of all)
    assert(
      /^[A-Za-z0-9_.-]+$/.test(target) && bake.target?.[target],
      `invalid image target: ${target}`,
    );
  const nodes = Object.entries(graph.nodes);
  const selectedSet =
    selected === null
      ? new Set(nodes.map(([name]) => name))
      : new Set(selected);
  for (const name of selectedSet)
    assert(graph.nodes[name], `affected project absent from graph: ${name}`);
  const jobs = [],
    skipped = [];
  for (const [name, { data }] of nodes) {
    const root = safeRoot(data.root);
    const targets = data.targets || {};
    let argv, label;
    if (targets.ci) {
      argv = ["npx", "nx", "run", `${name}:ci`];
      label = targets.ci.metadata?.description
        ? `${targets.ci.metadata.description} - ${name}`
        : `Build/Test - ${name}`;
    } else if (mavenRoots.includes(root)) {
      argv = ["./mvnw", "-B", "-ntp", "-pl", root, "-am", "verify"];
      label = `Build/Test - ${name}`;
    } else {
      const tasks = ["build", "test", "typecheck", "lint"].filter(
        (t) => targets[t],
      );
      if (!tasks.length) continue;
      argv = [
        "npx",
        "nx",
        "run-many",
        "-t",
        ...tasks,
        "--projects",
        name,
        "--parallel=1",
      ];
      label = `${tasks.includes("test") ? "Build/Test" : tasks.includes("build") ? (tasks.includes("typecheck") ? "Build/Typecheck" : "Build") : tasks.includes("lint") ? "Lint" : "Typecheck"} - ${name}`;
    }
    const job = { id: id(name), project: name, root, label, argv };
    if (selectedSet.has(name) || root === ".") jobs.push(job);
    else
      skipped.push({ project: name, label, reason: "Not affected by this PR" });
  }
  for (const check of checks) {
    assert(
      check.name && typeof check.command === "string" && check.command.trim(),
      "checks require a name and native command",
    );
    const root = safeRoot(check.cwd || ".");
    jobs.push({
      id: id(check.name),
      project: check.name,
      root,
      label: `Build/Test - ${check.name}`,
      command: check.command,
    });
  }
  if (fallback)
    jobs.push({
      id: id("application-checks"),
      project: "application-checks",
      root: ".",
      label: "Build/Test - Application checks",
      command: fallback,
    });
  assert(
    jobs.length + skipped.length > 0,
    "No executable project checks found. Declare native Nx targets or supply project-checks for your build system.",
  );
  assert.equal(
    new Set(jobs.map((j) => j.id)).size,
    jobs.length,
    "duplicate project/check names",
  );
  assert.equal(
    new Set(jobs.map((job) => job.label)).size,
    jobs.length,
    "project job labels must be unique",
  );
  const images = all
    .filter((target) => {
      if (skipImages) return false;
      if (event !== "pull_request" || selected === null) return true;
      const context = bake.target[target].context || ".";
      const dockerfile = path.posix.normalize(
        path.posix.join(
          context,
          bake.target[target].dockerfile || "Dockerfile",
        ),
      );
      const owner = nodes
        .filter(
          ([, n]) =>
            n.data.root !== "." &&
            (dockerfile === n.data.root ||
              dockerfile.startsWith(n.data.root + "/")),
        )
        .sort((a, b) => b[1].data.root.length - a[1].data.root.length)[0];
      return !owner || selectedSet.has(owner[0]); // Unknown mapping builds conservatively.
    })
    .map((target) => ({
      target,
      label: `${event === "pull_request" ? "Build Image" : "Build & Publish Image"} - ${target}`,
    }));
  assert(
    jobs.length <= 256 && images.length <= 256,
    "GitHub supports at most 256 rows per job matrix; group native checks explicitly for larger applications",
  );
  return {
    kind: "plan",
    schemaVersion: 1,
    verification: {
      mode: "projects",
      ...(skipImages ? { containerProof: false } : {}),
    },
    projectJobs: jobs,
    skippedProjects: skipped,
    images,
    selected: { images: all, chart: ["application-candidate"] },
    validation: {},
    files: [],
    direct: [],
    reasons: {},
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const run = (args) =>
    execFileSync(args[0], args.slice(1), {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "/dev/null" },
    });
  const bake =
    process.env.VALIDATION_ONLY === "true" && !fs.existsSync("docker-bake.hcl")
      ? { group: { application: { targets: [] } }, target: {} }
      : JSON.parse(run(["docker", "buildx", "bake", "--print", "application"]));
  let graph = { nodes: {} },
    selected = null;
  if (fs.existsSync("nx.json")) {
    // show projects fails closed on graph errors; graph --file alone can emit a partial graph.
    run(["npx", "nx", "show", "projects", "--json"]);
    run(["npx", "nx", "graph", "--file=.work/graph.json"]);
    graph = JSON.parse(fs.readFileSync(".work/graph.json")).graph;
    const base = process.env.PR_BASE || process.env.AFFECTED_BASE;
    const canSelect =
      process.env.GITHUB_EVENT_NAME === "pull_request" ||
      (process.env.VALIDATION_ONLY === "true" &&
        /^[a-f0-9]{40}$/.test(base || "") &&
        !/^0+$/.test(base));
    if (canSelect && process.env.FORCE_ALL !== "true") {
      assert(/^[a-f0-9]{40}$/.test(base || ""), "exact PR base required");
      selected = JSON.parse(
        run([
          "npx",
          "nx",
          "show",
          "projects",
          "--affected",
          `--base=${base}`,
          `--head=${process.env.SOURCE_SHA || process.env.GITHUB_SHA}`,
          "--json",
        ]),
      );
    }
  }
  const mavenRoots = Object.values(graph.nodes)
    .map((n) => n.data.root)
    .filter((root) => {
      const pom = path.join(safeRoot(root), "pom.xml");
      return (
        fs.existsSync(pom) && !/<modules\b/.test(fs.readFileSync(pom, "utf8"))
      );
    });
  const declaredChecks = JSON.parse(process.env.PROJECT_CHECKS || "[]");
  if (
    process.env.VALIDATION_ONLY === "true" &&
    !fs.existsSync("nx.json") &&
    !declaredChecks.length &&
    !process.env.VERIFICATION_COMMAND
  ) {
    const { discoverLocal } = await import("../delivery/discover.mjs");
    const app = discoverLocal(process.cwd(), {
      repository: process.env.GITHUB_REPOSITORY,
      branch: "main",
      pipelineRepository: process.env.GITHUB_REPOSITORY,
      chart: process.env.APP_CHART || "",
    });
    declaredChecks.push({
      name: "chart",
      command: "helm lint '" + app.chart.replaceAll("'", "'\"'\"'") + "'",
    });
  }
  const plan = projectPlan({
    graph,
    selected,
    bake,
    mavenRoots,
    checks: declaredChecks,
    fallback: process.env.VERIFICATION_COMMAND || "",
    event:
      process.env.VALIDATION_ONLY === "true"
        ? "pull_request"
        : process.env.GITHUB_EVENT_NAME,
    allowEmptyImages: process.env.VALIDATION_ONLY === "true",
    skipImages:
      process.env.VALIDATION_ONLY === "true" &&
      process.env.SKIP_IMAGE_PROOF === "true",
  });
  plan.run = runIdentity();
  plan.head = process.env.SOURCE_SHA || process.env.GITHUB_SHA;
  plan.base = process.env.PR_BASE || process.env.AFFECTED_BASE || null;
  fs.writeFileSync(".work/plan.json", JSON.stringify(plan, null, 2));
  fs.writeFileSync(".work/bake.json", JSON.stringify(bake, null, 2));
  const output = {
    checks: JSON.stringify(plan.projectJobs),
    checks_count: String(plan.projectJobs.length),
    images: JSON.stringify(plan.images),
    images_count: String(plan.images.length),
    all_images: JSON.stringify(plan.selected.images),
  };
  for (const [key, value] of Object.entries(output))
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(
    JSON.stringify(
      {
        checks: plan.projectJobs.map((j) => j.label),
        images: plan.images.map((i) => i.label),
        unaffected: plan.skippedProjects,
      },
      null,
      2,
    ),
  );
}
