import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import {
  descriptor,
  validatePackage,
  compose,
  reference,
  existingDesignation,
  releaseRE,
} from "../tools/delivery/contracts.mjs";
import {
  bind,
  inspectOCI,
  prepare,
  unpackChart,
  checkChart,
} from "../tools/delivery/package.mjs";
import { discoverLocal } from "../tools/delivery/discover.mjs";
import { scaffold } from "../tools/delivery/bootstrap.mjs";
const sha = "a".repeat(40),
  digest = "sha256:" + "b".repeat(64);
const d = {
  schemaVersion: 1,
  application: "orders",
  releaseBranch: "main",
  chart: "deploy/orders",
  chartName: "orders",
  components: { api: { workloads: ["api"] }, web: { workloads: ["web"] } },
  pipelineRepository: "enterprise/pipelines",
};
const producer = {
  repository: "enterprise/orders",
  source: sha,
  sourceRef: "refs/heads/main",
  controlSource: sha,
  workflow: "enterprise/orders/.github/workflows/ci.yml@refs/heads/main",
  pipelineRepository: "enterprise/pipelines",
  pipelineRevision: sha,
  run: "1",
  attempt: "1",
};
const pkg = {
  schemaVersion: 2,
  kind: "package",
  application: "orders",
  trust: "release",
  chartName: "orders",
  composer: producer,
  images: Object.fromEntries(
    Object.keys(d.components).map((name) => [
      name,
      {
        reference: `ghcr.io/enterprise/orders-release/${name}@${digest}`,
        platforms: ["linux/amd64"],
        producer,
      },
    ]),
  ),
};

test("data archive reader rejects traversal, links, duplicates and size overflow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-archive-"));
  try {
    const script = path.resolve("tools/delivery/archive.py");
    for (const kind of ["traversal", "link", "duplicate", "size"]) {
      const archive = path.join(dir, kind + ".tar");
      execFileSync("python3", [
        "-c",
        `import tarfile,io,sys\np=tarfile.open(sys.argv[1],'w')\nn=tarfile.TarInfo('../escape' if sys.argv[2]=='traversal' else 'file')\nn.size=1\nif sys.argv[2]=='link': n.type=tarfile.SYMTYPE; n.linkname='/tmp/escape'\np.addfile(n,io.BytesIO(b'x'))\nif sys.argv[2]=='duplicate': p.addfile(n,io.BytesIO(b'x'))\np.close()`,
        archive,
        kind,
      ]);
      if (kind === "size")
        assert.throws(() =>
          execFileSync(
            "python3",
            [
              "-c",
              `import sys;sys.path.insert(0,'tools/delivery');from archive import unpack;unpack(sys.argv[1],sys.argv[2],limit=0)`,
              archive,
              path.join(dir, kind),
            ],
            { stdio: "pipe" },
          ),
        );
      else
        assert.throws(() =>
          execFileSync("python3", [script, archive, path.join(dir, kind)], {
            stdio: "pipe",
          }),
        );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("publisher verifies actual OCI blob content rather than trusting declared digest", async () => {
  const { createHash } = await import("node:crypto");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-oci-"));
  try {
    fs.mkdirSync(path.join(dir, "blobs/sha256"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "oci-layout"),
      JSON.stringify({ imageLayoutVersion: "1.0.0" }),
    );
    const content = JSON.stringify({ schemaVersion: 2, layers: [] }),
      hash = createHash("sha256").update(content).digest("hex");
    fs.writeFileSync(path.join(dir, "blobs/sha256", hash), content);
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({
        schemaVersion: 2,
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: "sha256:" + hash,
            size: Buffer.byteLength(content),
          },
        ],
      }),
    );
    assert.equal(inspectOCI(dir), "sha256:" + hash);
    fs.writeFileSync(path.join(dir, "blobs/sha256", hash), "modified");
    assert.throws(() => inspectOCI(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("zero-image planning is explicit and unsupported matrix sizes fail before scheduling", async () => {
  const { projectPlan } = await import("../tools/pipeline/projects.mjs");
  const bake = { group: { application: { targets: [] } }, target: {} };
  const checks = Array.from({ length: 256 }, (_, n) => ({
    name: "check-" + n,
    command: "true",
  }));
  assert.equal(
    projectPlan({ bake, checks, allowEmptyImages: true }).projectJobs.length,
    256,
  );
  assert.throws(() =>
    projectPlan({
      bake,
      checks: [...checks, { name: "overflow", command: "true" }],
      allowEmptyImages: true,
    }),
  );
  assert.throws(() => projectPlan({ bake, checks: [] }));
});
test("main validation reporting never claims image or candidate publication", async () => {
  const { renderProjectSummary } = await import(
    "../tools/pipeline/project-summary.mjs"
  );
  const report = renderProjectSummary({
    run: { event: "push", sha, validationOnly: true },
    plan: {
      projectJobs: [],
      skippedProjects: [],
      images: [{ target: "api", label: "Build Image - api" }],
      selected: { images: ["api"] },
    },
    validations: [],
    jobs: { ci: { result: "success" } },
    jobDetails: [],
    results: [],
    candidate: null,
    artifacts: [],
    runUrl: "https://example.test/run",
    notices: [],
  });
  assert.match(report, /Validation only/);
  assert.match(report, /separate manual package workflow/);
  assert.doesNotMatch(
    report,
    /Main builds and publishes|candidate not confirmed|Build and publish image/,
  );
});
test("manual package creation validates native checks without duplicate container builds", async () => {
  const { projectPlan } = await import("../tools/pipeline/projects.mjs");
  const plan = projectPlan({
    graph: {
      nodes: {
        api: { data: { root: "api", targets: { build: {}, test: {} } } },
      },
    },
    bake: {
      group: { application: { targets: ["api"] } },
      target: { api: { dockerfile: "api/Dockerfile" } },
    },
    skipImages: true,
  });
  assert.equal(plan.projectJobs.length, 1);
  assert.equal(plan.images.length, 0);
  assert.deepEqual(plan.selected.images, ["api"]);
  const workflow = parse(
    fs.readFileSync(".github/workflows/package.yml", "utf8"),
  );
  assert.equal(workflow.jobs.validate.with["container-proof"], false);
});
test("package checks preserve provenance and reject dev, incomplete and cross-application inputs", () => {
  assert.doesNotThrow(() => validatePackage(pkg, d, producer.repository));
  for (const change of [
    (p) => (p.trust = "dev"),
    (p) => delete p.images.api,
    (p) => (p.images.api.reference = `ghcr.io/other/app-release/api@${digest}`),
    (p) =>
      (p.images.api.producer = {
        ...producer,
        pipelineRepository: "attacker/pipelines",
      }),
    (p) =>
      (p.images.api.producer = { ...producer, sourceRef: "refs/heads/topic" }),
  ]) {
    const p = structuredClone(pkg);
    change(p);
    assert.throws(() => validatePackage(p, d, producer.repository));
  }
  assert.throws(() => reference("ghcr.io/enterprise/orders:latest"));
});
test("composition imports only selected historical components and records a new combination", () => {
  const old = structuredClone(pkg);
  delete old.images.web;
  old.images.api.producer = { ...producer, run: "2" };
  const result = compose(
    d,
    pkg,
    { api: { manifest: old } },
    producer.repository,
    { ...producer, run: "3" },
    "Reuse the earlier API",
  );
  assert.equal(result.images.api.producer.run, "2");
  assert.deepEqual(result.images.web, pkg.images.web);
  assert.equal(result.composer.run, "3");
  old.images.api.reference = `ghcr.io/other/app-release/api@${digest}`;
  assert.throws(() =>
    compose(
      d,
      pkg,
      { api: { manifest: old } },
      producer.repository,
      producer,
      "Reuse the earlier API",
    ),
  );
});
test("release retries keep the original selection, conflicting IDs cannot change candidate or QA record", () => {
  const original = {
    schemaVersion: 1,
    kind: "release",
    application: "orders",
    candidate: `ghcr.io/enterprise/orders-release-packages/orders@${digest}`,
    releaseId: "v1.2.3",
    qaRun: "https://github.com/enterprise/qa/actions/runs/1",
    promotedBy: producer,
  };
  assert.deepEqual(
    existingDesignation(original, {
      ...original,
      promotedBy: { ...producer, run: "2" },
    }),
    original,
  );
  assert.throws(() =>
    existingDesignation(original, { ...original, qaRun: "other" }),
  );
  assert.throws(() =>
    existingDesignation(original, { ...original, candidate: "other" }),
  );
  for (const id of ["v1.2.3", "r1", "1"]) assert.match(id, releaseRE);
  for (const id of ["../escape", "a..b", "release.lock"])
    assert(!releaseRE.test(id));
});
test("native chart declarations bootstrap and package non-Nx and chart-only apps without an app descriptor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-native-"));
  try {
    for (const [fixture, chartName] of [
      ["delivery-static", "static"],
      ["delivery-chart-only", "config"],
    ]) {
      const root = path.join(dir, fixture);
      fs.cpSync("tests/fixtures/" + fixture, root, { recursive: true });
      const application = discoverLocal(root, {
        repository: producer.repository,
        pipelineRepository: d.pipelineRepository,
        branch: "main",
      });
      assert.equal(application.chartName, chartName);
      scaffold(root, d.pipelineRepository, "v1");
      assert.throws(() => scaffold(root, d.pipelineRepository, "v1"));
      assert.deepEqual(fs.readdirSync(path.join(root, ".github/workflows")), [
        "ci.yml",
      ]);
      assert(!fs.existsSync(path.join(root, ".delivery")));
      const images = Object.fromEntries(
        Object.keys(application.components).map((name) => [
          name,
          {
            reference: `ghcr.io/enterprise/orders-release/${name}@${digest}`,
            platforms: ["linux/amd64"],
            producer,
          },
        ]),
      );
      const out = path.join(dir, fixture + "-out");
      const manifest = prepare(application, root, out, producer, "release", {
        images,
        baseline: "fixture",
        overrides: {},
        reason: "Fixture selected images",
      });
      checkChart(
        unpackChart(
          path.join(out, "chart.tgz"),
          path.join(dir, fixture + "-unpacked"),
          chartName,
        ),
        application,
        manifest,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("ambiguous native charts require a chart choice, not a duplicated service descriptor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-charts-"));
  try {
    fs.cpSync("tests/fixtures/delivery-chart-only", dir, { recursive: true });
    fs.cpSync(
      "tests/fixtures/delivery-static/deploy/static",
      path.join(dir, "deploy/static"),
      { recursive: true },
    );
    const context = {
      repository: producer.repository,
      pipelineRepository: d.pipelineRepository,
      branch: "main",
    };
    assert.throws(() => discoverLocal(dir, context));
    assert.equal(
      discoverLocal(dir, { ...context, chart: "deploy/static" }).chartName,
      "static",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("manual dispatch cannot run from a branch other than the server-defined default branch", () => {
  const guard = path.resolve("tools/delivery/guard.mjs");
  assert.throws(
    () =>
      execFileSync(process.execPath, [guard, "unused"], {
        env: {
          ...process.env,
          CONTROL_BRANCH: "main",
          GITHUB_REF: "refs/heads/topic",
          GITHUB_EVENT_NAME: "workflow_dispatch",
        },
        stdio: "pipe",
      }),
    (e) => e.stderr.toString().includes("repository default branch"),
  );
});
test("application caller only defines native GitHub events/form and forwards them to shared execution", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-caller-"));
  try {
    scaffold(dir, d.pipelineRepository, "v1");
    const text = fs.readFileSync(
        path.join(dir, ".github/workflows/ci.yml"),
        "utf8",
      ),
      w = parse(text);
    assert(
      w.on.push &&
        w.on.pull_request &&
        w.on.merge_group &&
        w.on.workflow_dispatch,
    );
    assert.equal(w.jobs.publish.with.request, "${{ toJSON(inputs) }}");
    assert(
      !/certification|trustedPipeline|\.delivery|components|^\s+run:/m.test(
        text,
      ),
    );
    for (const job of Object.values(w.jobs)) assert(job.uses.endsWith("@v1"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("builds remain read-only and only promotion uses the native GitHub release approval", () => {
  const w = parse(fs.readFileSync(".github/workflows/package.yml", "utf8"));
  for (const n of ["guard", "build", "inspect"])
    assert.deepEqual(w.jobs[n].permissions, { contents: "read" });
  assert(!w.jobs.images.environment && !w.jobs.chart.environment);
  const p = parse(fs.readFileSync(".github/workflows/promote.yml", "utf8"));
  assert.equal(p.jobs.promote.environment, "release");
  assert(!p.on.workflow_call.secrets["certification-read-token"]);
  assert(
    !fs
      .readFileSync("tools/delivery/promote.mjs", "utf8")
      .includes("decisionsPath"),
  );
});
test("promotion uses a real successful QA run and creates a native GitHub release without rebuilding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-promotion-"));
  try {
    fs.writeFileSync(path.join(dir, "application.json"), JSON.stringify(d));
    fs.writeFileSync(path.join(dir, "composer.json"), JSON.stringify(producer));
    const qaRun = "https://github.com/enterprise/qa/actions/runs/123",
      candidate = `ghcr.io/enterprise/orders-release-packages/orders@${digest}`;
    fs.writeFileSync(
      path.join(dir, "fixture.json"),
      JSON.stringify({ d, pkg, producer }),
    );
    const gh = path.join(dir, "gh");
    fs.writeFileSync(
      gh,
      `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),f=JSON.parse(fs.readFileSync(process.env.FIXTURE));
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
let out={};
if(a[0]==='attestation'){
 const type=a[a.indexOf('--predicate-type')+1],ref=a[2].slice(6),name=ref.includes('/api@')?'api':'web';
 const image=f.pkg.images[name];let predicate=type.endsWith('/package/v2')?f.pkg:type.endsWith('/image/v2')?{source:f.producer.source,reference:image.reference,producer:f.producer}:{};
 out=[{verificationResult:{statement:{predicateType:type,subject:[{digest:{sha256:ref.split('@sha256:')[1]}}],predicate}}}];
}else if(a.includes('repos/enterprise/pipelines')) out={default_branch:'main'};
else if(a.some(x=>x.includes('/compare/'))) out={status:'ahead'};
else if(a.some(x=>x.includes('/actions/runs/'))) out={status:'completed',conclusion:process.env.QA_RESULT||'success'};
else if(a.some(x=>x.includes('/releases/tags/'))) process.exit(1);
else if(a.includes('repos/enterprise/orders/git/tags')) out={sha:'tag-object'};
console.log(JSON.stringify(out));
`,
    );
    fs.chmodSync(gh, 0o755);
    const env = {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      FIXTURE: path.join(dir, "fixture.json"),
      CALLS: path.join(dir, "calls"),
      CANDIDATE: candidate,
      RELEASE_ID: "v1.2.3",
      QA_RUN: qaRun,
      GITHUB_ACTOR: "release-owner",
      GITHUB_OUTPUT: path.join(dir, "output"),
    };
    const script = path.resolve("tools/delivery/promote.mjs");
    execFileSync(
      process.execPath,
      [
        script,
        path.join(dir, "application.json"),
        path.join(dir, "composer.json"),
        path.join(dir, "release"),
      ],
      { env, stdio: "pipe" },
    );
    const release = JSON.parse(
      fs.readFileSync(path.join(dir, "release/release.json")),
    );
    assert.equal(release.candidate, candidate);
    assert.equal(release.qaRun, qaRun);
    assert(!("certification" in release));
    const calls = fs.readFileSync(env.CALLS, "utf8");
    assert(calls.includes("repos/enterprise/orders/releases"));
    assert(!calls.includes("docker"));
    fs.writeFileSync(env.CALLS, "");
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          script,
          path.join(dir, "application.json"),
          path.join(dir, "composer.json"),
          path.join(dir, "failed"),
        ],
        { env: { ...env, QA_RESULT: "failure" }, stdio: "pipe" },
      ),
    );
    assert(
      !fs
        .readFileSync(env.CALLS, "utf8")
        .includes("repos/enterprise/orders/git/tags"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
