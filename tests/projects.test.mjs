import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { projectPlan } from "../tools/pipeline/projects.mjs";
import { renderProjectSummary } from "../tools/pipeline/project-summary.mjs";
const node = (root, targets = {}) => ({ data: { root, targets } });
const bake = {
  group: { application: { targets: ["orders-api", "public-web"] } },
  target: {
    "orders-api": { dockerfile: "services/orders/Dockerfile" },
    "public-web": { dockerfile: "clients/public/Dockerfile" },
  },
};
const graph = {
  nodes: {
    "money-core": node("modules/money", { build: {}, test: {} }),
    orders: node("services/orders"),
    public: node("clients/public", { build: {}, typecheck: {} }),
    workspace: node(".", {
      ci: { metadata: { description: "Test - Repository contracts" } },
    }),
  },
};
test("affected library and service produce named independent native jobs and only their affected image", () => {
  const p = projectPlan({
    graph,
    selected: ["money-core", "orders"],
    bake,
    mavenRoots: ["services/orders"],
  });
  assert.deepEqual(
    p.projectJobs.map((j) => j.label),
    [
      "Build/Test - money-core",
      "Build/Test - orders",
      "Test - Repository contracts",
    ],
  );
  assert.deepEqual(
    p.images.map((j) => j.label),
    ["Build Image - orders-api"],
  );
  assert.equal(p.skippedProjects[0].project, "public");
  assert.deepEqual(p.projectJobs[1].argv, [
    "./mvnw",
    "-B",
    "-ntp",
    "-pl",
    "services/orders",
    "-am",
    "verify",
  ]);
  assert(p.projectJobs[0].argv.includes("money-core"));
});
test("main always verifies every native project and rebuilds the complete image closure", () => {
  const p = projectPlan({
    graph,
    selected: null,
    bake,
    mavenRoots: ["services/orders"],
    event: "push",
  });
  assert.equal(p.projectJobs.length, 4);
  assert.equal(p.images.length, 2);
  assert(p.images.every((i) => i.label.startsWith("Build & Publish Image - ")));
});
test("unmapped image definitions build conservatively and empty release inventories fail", () => {
  const p = projectPlan({
    graph,
    selected: [],
    bake: {
      ...bake,
      target: { ...bake.target, "orders-api": { dockerfile: "Dockerfile" } },
    },
  });
  assert.deepEqual(
    p.images.map((i) => i.target),
    ["orders-api"],
  );
  assert.throws(() =>
    projectPlan({ graph, bake: { group: { application: { targets: [] } } } }),
  );
  assert.throws(() => projectPlan({ graph, selected: ["unknown"], bake }));
});
test("language-neutral native commands support a repo without npm, Maven or Nx", () => {
  const p = projectPlan({
    bake,
    checks: [
      {
        name: "weather-api",
        command: "python3 -m unittest discover -s source",
        cwd: "services/weather",
      },
      { name: "etl-worker", command: "make verify", cwd: "workers/etl" },
    ],
  });
  assert.deepEqual(
    p.projectJobs.map((j) => j.label),
    ["Build/Test - weather-api", "Build/Test - etl-worker"],
  );
  assert(p.projectJobs.every((j) => !j.argv));
  assert.equal(p.images.length, 2);
  assert.throws(() => projectPlan({ bake }));
  assert.throws(() =>
    projectPlan({
      bake,
      checks: [{ name: "escape", command: "true", cwd: "../outside" }],
    }),
  );
});
test("native task execution isolates summary writes and preserves failure status", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "project-task-"));
  try {
    const envFile = path.join(cwd, "env"),
      summary = path.join(cwd, "summary");
    fs.writeFileSync(summary, "sentinel");
    const env = {
      ...process.env,
      GITHUB_ENV: envFile,
      GITHUB_STEP_SUMMARY: summary,
      PROJECT_TASK: JSON.stringify({
        id: "native",
        project: "weather",
        root: ".",
        label: "Build/Test - weather",
        command:
          'printf hidden >> "$GITHUB_STEP_SUMMARY"; python3 -c "print(42)"',
      }),
    };
    const output = execFileSync(
      process.execPath,
      [path.resolve("tools/pipeline/run-project.mjs")],
      { cwd, env, encoding: "utf8" },
    );
    assert(output.includes("42"));
    assert.equal(fs.readFileSync(summary, "utf8"), "sentinel");
    env.PROJECT_TASK = JSON.stringify({
      id: "native",
      project: "weather",
      root: ".",
      label: "Build/Test - weather",
      command: "exit 7",
    });
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.resolve("tools/pipeline/run-project.mjs")],
          { cwd, env, stdio: "pipe" },
        ),
      (e) => e.status === 7,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
test("only the final report can write a summary and bundled action summaries are disabled", () => {
  const w = parse(fs.readFileSync(".github/workflows/application.yml", "utf8"));
  let writers = 0;
  assert.equal(w.env.DOCKER_BUILD_SUMMARY, "false");
  for (const job of Object.values(w.jobs))
    for (const step of job.steps) {
      if (step.run?.includes("--github-summary")) {
        writers++;
        assert.notEqual(step.env?.GITHUB_STEP_SUMMARY, "/dev/null");
      } else
        assert.equal(
          step.env?.GITHUB_STEP_SUMMARY,
          "/dev/null",
          step.name || step.uses,
        );
      if (step.uses?.startsWith("actions/attest"))
        assert.equal(step.with["show-summary"], false);
    }
  assert.equal(writers, 1);
  const action = parse(
    fs.readFileSync(".github/actions/publish-chart/action.yml", "utf8"),
  );
  for (const step of action.runs.steps)
    if (step.uses?.startsWith("actions/attest"))
      assert.equal(step.with["show-summary"], false);
});
test("validation gate rejects failed or cancelled project/image jobs and only allows intentional empty matrices", () => {
  const w = parse(fs.readFileSync(".github/workflows/application.yml", "utf8")),
    script = w.jobs.ci.steps[0].run;
  const run = (env) =>
    execFileSync("bash", ["-euo", "pipefail", "-c", script], {
      env: {
        ...process.env,
        PLAN: "success",
        CHECKS: "success",
        IMAGES: "success",
        CHECKS_COUNT: "2",
        IMAGES_COUNT: "1",
        ...env,
      },
      stdio: "pipe",
    });
  assert.doesNotThrow(() => run({}));
  assert.throws(() => run({ CHECKS: "failure" }));
  assert.throws(() => run({ IMAGES: "failure" }));
  assert.throws(() => run({ CHECKS: "cancelled" }));
  assert.throws(() => run({ IMAGES: "skipped" }));
  assert.doesNotThrow(() => run({ IMAGES: "skipped", IMAGES_COUNT: "0" }));
  assert.doesNotThrow(() =>
    run({
      CHECKS: "skipped",
      CHECKS_COUNT: "0",
      IMAGES: "skipped",
      IMAGES_COUNT: "0",
    }),
  );
});
test("project summary lists actual projects/images, failures, skipped projects and one publication result", () => {
  const plan = projectPlan({
    graph,
    selected: ["money-core", "orders"],
    bake,
    mavenRoots: ["services/orders"],
  });
  const jobDetails = [
    ...plan.projectJobs.map((j) => ({
      name: j.label,
      conclusion: "success",
      html_url: "https://example.test/check",
    })),
    {
      name: plan.images[0].label,
      conclusion: "failure",
      html_url: "https://example.test/image",
      steps: [{ name: "Build container", conclusion: "failure" }],
    },
  ];
  const md = renderProjectSummary({
    run: { event: "pull_request", sha: "abcdef0123456789" },
    plan,
    validations: [],
    jobs: {
      ci: { result: "failure" },
      "publish-images": { result: "failure" },
    },
    jobDetails,
    results: [],
    candidate: null,
    artifacts: [],
    runUrl: "https://example.test/run",
    notices: [],
  });
  assert.match(md, /money-core.*Build\/Test.*Passed/);
  assert.match(md, /orders-api.*Failed.*Build container/);
  assert.match(md, /public.*Not affected/);
  assert.doesNotMatch(md, /Source verification|No affected projects/);
  assert.match(md, /PRs never publish candidates/);
  assert.match(md, /# Application delivery — Build\/test checks failed/);
});
test("image aggregation rejects missing, duplicate and inconsistent native build outputs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "image-matrix-"));
  const script = path.resolve("tools/pipeline/collect-images.mjs");
  const inventory = {
    ...bake,
    target: {
      "orders-api": { tags: ["ghcr.io/acme/app/orders:run"] },
      "public-web": { tags: ["ghcr.io/acme/app/web:run"] },
    },
  };
  try {
    fs.mkdirSync(cwd + "/.work/native/orders", { recursive: true });
    fs.writeFileSync(
      cwd + "/.work/plan.json",
      JSON.stringify({ selected: { images: bake.group.application.targets } }),
    );
    const write = (dir, target) => {
      fs.mkdirSync(cwd + "/.work/native/" + dir, { recursive: true });
      fs.writeFileSync(
        cwd + "/.work/native/" + dir + "/bake.json",
        JSON.stringify(inventory),
      );
      fs.writeFileSync(
        cwd + "/.work/native/" + dir + "/metadata.json",
        JSON.stringify({
          [target]: { "containerimage.digest": "sha256:" + "a".repeat(64) },
        }),
      );
    };
    write("orders", "orders-api");
    const run = () =>
      execFileSync(
        process.execPath,
        [script, ".work/native", ".work/plan.json"],
        { cwd, stdio: "pipe" },
      );
    assert.throws(run);
    write("web", "public-web");
    assert.doesNotThrow(run);
    assert.equal(
      Object.keys(JSON.parse(fs.readFileSync(cwd + "/.work/metadata.json")))
        .length,
      2,
    );
    write("duplicate", "public-web");
    assert.throws(run);
    fs.rmSync(cwd + "/.work/native/duplicate", { recursive: true });
    fs.writeFileSync(cwd + "/.work/native/web/bake.json", "{}");
    assert.throws(run);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
