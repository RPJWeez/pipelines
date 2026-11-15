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
  certification,
  reference,
  existingDesignation,
} from "../tools/delivery/contracts.mjs";
import { bind, inspectOCI } from "../tools/delivery/package.mjs";
const sha = "a".repeat(40),
  digest = "sha256:" + "b".repeat(64);
const d = {
  schemaVersion: 1,
  application: "orders",
  releaseBranch: "main",
  chart: "deploy/orders",
  chartName: "orders",
  configCompatibility: "v1",
  components: {
    api: { compatibility: "api-v1", workloads: ["api"] },
    web: { compatibility: "web-v1", workloads: ["web"] },
  },
  policy: {
    environment: "delivery-release",
    pipelineRepository: "enterprise/pipelines",
    trustedPipelineRevisions: [sha],
    certification: {
      repository: "enterprise/qa",
      workflow: "enterprise/qa/.github/workflows/certify.yml",
      revision: sha,
      predicateType: "https://example.test/cert/v1",
      policyVersion: "v1",
      maxAgeHours: 24,
      decisionsPath: ".delivery/certifications.json",
    },
  },
};
const producer = {
  repository: "enterprise/orders",
  source: sha,
  sourceRef: "refs/heads/main",
  controlSource: sha,
  workflow:
    "enterprise/orders/.github/workflows/create-release-candidate.yml@refs/heads/main",
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
  configCompatibility: "v1",
  composer: producer,
  images: Object.fromEntries(
    Object.entries(d.components).map(([name, c]) => [
      name,
      {
        reference: `ghcr.io/enterprise/orders-release/${name}@${digest}`,
        compatibility: c.compatibility,
        platforms: ["linux/amd64"],
        producer,
      },
    ]),
  ),
};
test("portable contract accepts complete inventory and rejects cross-app, dev and incomplete reuse", () => {
  assert.doesNotThrow(() => validatePackage(pkg, d, "enterprise/orders"));
  for (const mutate of [
    (p) => (p.trust = "dev"),
    (p) => delete p.images.api,
    (p) =>
      (p.images.api.reference = `ghcr.io/enterprise/other-release/api@${digest}`),
    (p) => (p.images.api.producer.sourceRef = "refs/heads/topic"),
    (p) => (p.composer.pipelineRevision = "c".repeat(40)),
    (p) => (p.configCompatibility = "v2"),
  ]) {
    const copy = structuredClone(pkg);
    mutate(copy);
    assert.throws(() => validatePackage(copy, d, "enterprise/orders"));
  }
  assert.throws(() => reference("ghcr.io/enterprise/orders:latest"));
  assert.throws(() => descriptor({ ...d, chart: "../../escape" }));
});
test("older component composition preserves producer and rejects incompatible selections", () => {
  const older = structuredClone(pkg);
  older.images.api.producer = { ...producer, source: "c".repeat(40), run: "2" };
  const result = compose(
    d,
    pkg,
    { api: { manifest: older } },
    "enterprise/orders",
    { ...producer, run: "3" },
    "Hold API pending migration",
  );
  assert.equal(result.images.api.producer.run, "2");
  assert.equal(result.composer.run, "3");
  older.images.api.compatibility = "breaking-v2";
  assert.throws(() =>
    compose(
      d,
      pkg,
      { api: { manifest: older } },
      "enterprise/orders",
      producer,
      "Hold API pending migration",
    ),
  );
  assert.throws(() =>
    compose(
      d,
      pkg,
      { typo: { manifest: pkg } },
      "enterprise/orders",
      producer,
      "Hold API pending migration",
    ),
  );
});
test("chart binding rejects undeclared workloads and manual image substitution", () => {
  const values = {
    application: {
      workloads: {
        api: { image: "BUILD_OUTPUT" },
        web: { image: "BUILD_OUTPUT:web" },
      },
    },
  };
  const bound = bind(d, values, pkg.images);
  assert.equal(bound.application.workloads.api.image, pkg.images.api.reference);
  const extra = structuredClone(values);
  extra.application.workloads.rogue = { image: "BUILD_OUTPUT" };
  assert.throws(() => bind(d, extra, pkg.images));
  values.application.workloads.api.image = "ghcr.io/evil/api:latest";
  assert.throws(() => bind(d, values, pkg.images));
});
test("promotion requires exact current unexpired nonrevoked certification and QA", () => {
  const candidate = `ghcr.io/enterprise/orders-release-packages/orders@${digest}`,
    now = Date.now();
  const proof = {
    candidate,
    status: "certified",
    policyVersion: "v1",
    revoked: false,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 10000).toISOString(),
    qa: { status: "passed", candidate },
  };
  assert.doesNotThrow(() =>
    certification(proof, candidate, d.policy.certification, now),
  );
  for (const mutate of [
    (p) => (p.revoked = true),
    (p) => (p.policyVersion = "old"),
    (p) => (p.qa.candidate = "other"),
    (p) => (p.expiresAt = new Date(now - 1).toISOString()),
    (p) => (p.issuedAt = new Date(now - 25 * 3600000).toISOString()),
  ]) {
    const copy = structuredClone(proof);
    mutate(copy);
    assert.throws(() =>
      certification(copy, candidate, d.policy.certification, now),
    );
  }
});
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
test("workflow trust boundaries: readonly builds, exact artifact IDs, guarded publication and isolated caches", () => {
  const w = parse(fs.readFileSync(".github/workflows/package.yml", "utf8"));
  for (const n of ["guard", "build"])
    assert.deepEqual(w.jobs[n].permissions, { contents: "read" });
  assert.equal(w.jobs.validate.with.full, true);
  assert(w.jobs.images.environment.includes("needs.guard.outputs.environment"));
  assert(
    w.jobs.images.steps.some(
      (s) =>
        s.with?.["artifact-ids"] === "${{ needs.inspect.outputs.artifact }}",
    ),
  );
  assert(
    !w.jobs.images.steps.some(
      (s) => s.uses?.startsWith("actions/checkout") && !s.with.repository,
    ),
  );
  const v = parse(fs.readFileSync(".github/workflows/validate.yml", "utf8"));
  for (const job of Object.values(v.jobs)) {
    assert(!Object.values(job.permissions || {}).includes("write"));
    for (const step of job.steps || []) {
      if (step.uses === "./.work/delivery/.github/actions/setup")
        assert.equal(step.with["cache-enabled"], "false");
      if (step.uses?.startsWith("docker/bake"))
        assert.equal(step.with.push, false);
    }
  }
  assert(
    !fs
      .readFileSync("tools/delivery/package.mjs", "utf8")
      .includes("cache-from=type=gha"),
  );
});
test("bootstrap and package adapters work for non-Nx and zero-image applications, and refuse overwrites", async () => {
  const { scaffold } = await import("../tools/delivery/bootstrap.mjs");
  const { prepare, unpackChart, checkChart } = await import(
    "../tools/delivery/package.mjs"
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-bootstrap-"));
  try {
    for (const [fixture, chartName, components] of [
      [
        "delivery-static",
        "static",
        { site: { compatibility: "v1", workloads: ["public-site"] } },
      ],
      ["delivery-chart-only", "config", {}],
    ]) {
      const root = path.join(dir, fixture);
      fs.cpSync("tests/fixtures/" + fixture, root, { recursive: true });
      const desc = {
        ...structuredClone(d),
        application: chartName,
        chart: "deploy/" + chartName,
        chartName,
        components,
      };
      scaffold(root, desc, sha, [
        { name: "chart", command: `helm lint deploy/${chartName}` },
      ]);
      execFileSync(
        process.execPath,
        [path.resolve("tools/delivery/doctor.mjs"), root],
        { stdio: "pipe" },
      );
      assert.throws(() => scaffold(root, desc, sha));
      const images = Object.fromEntries(
        Object.entries(components).map(([name, c]) => [
          name,
          {
            reference: `ghcr.io/enterprise/orders-release/${name}@${digest}`,
            compatibility: c.compatibility,
            platforms: ["linux/amd64"],
            producer,
          },
        ]),
      );
      const selected = {
        images,
        reason: "Portable fixture selection",
        baseline: `ghcr.io/enterprise/orders-release-packages/${chartName}@${digest}`,
        overrides: {},
      };
      const output = path.join(dir, fixture + "-output");
      const manifest = prepare(
        desc,
        root,
        output,
        producer,
        "release",
        selected,
      );
      const chart = unpackChart(
        path.join(output, "chart.tgz"),
        path.join(dir, fixture + "-unpacked"),
        chartName,
      );
      checkChart(chart, desc, manifest);
      // Upgrade pins through a fresh generation directory; avoid overwriting app-owned files.
      const next = "c".repeat(40),
        upgrade = {
          ...desc,
          policy: { ...desc.policy, trustedPipelineRevisions: [sha, next] },
        };
      scaffold(path.join(dir, fixture + "-upgrade"), upgrade, next);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("release allocation retries preserve the original record and reject identifier conflicts", () => {
  const original = {
    schemaVersion: 1,
    kind: "release",
    application: "orders",
    candidate: `ghcr.io/enterprise/orders-release-packages/orders@${digest}`,
    releaseId: "r1",
    policyVersion: "v1",
    promotedBy: producer,
  };
  const retry = { ...original, promotedBy: { ...producer, run: "2" } };
  assert.deepEqual(existingDesignation(original, retry), original);
  assert.throws(() =>
    existingDesignation(original, {
      ...retry,
      candidate: `ghcr.io/enterprise/orders-release-packages/orders@sha256:${"c".repeat(64)}`,
    }),
  );
  assert.throws(() =>
    existingDesignation(original, { ...retry, releaseId: "r2" }),
  );
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
test("a protected feature branch cannot redefine itself as the delivery control branch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-control-"));
  try {
    const desc = { ...structuredClone(d), releaseBranch: "protected-feature" };
    fs.writeFileSync(path.join(dir, "application.json"), JSON.stringify(desc));
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            path.resolve("tools/delivery/guard.mjs"),
            path.join(dir, "application.json"),
            path.join(dir, "output"),
          ],
          {
            env: {
              ...process.env,
              CONTROL_BRANCH: "main",
              GITHUB_REF: "refs/heads/protected-feature",
              GITHUB_REF_PROTECTED: "true",
              GITHUB_EVENT_NAME: "workflow_dispatch",
              OPERATION: "release",
            },
            stdio: "pipe",
          },
        ),
      (e) => e.stderr.toString().includes("repository default branch"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
