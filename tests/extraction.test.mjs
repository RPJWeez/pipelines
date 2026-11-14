import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "yaml";
const workflow = parse(
  fs.readFileSync(".github/workflows/application.yml", "utf8"),
);
test("each helper consumer checks out the exact reusable workflow source before execution", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const helper = job.steps.findIndex(
      (s) =>
        s.run?.includes("$DELIVERY_ROOT") ||
        s.uses?.startsWith("./.work/delivery/"),
    );
    if (helper < 0) continue;
    const checkout = job.steps.findIndex(
      (s) => s.name === "Check out exact shared pipeline implementation",
    );
    assert(checkout >= 0 && checkout < helper, name);
    assert.equal(
      job.steps[checkout].with.repository,
      "${{ job.workflow_repository }}",
    );
    assert.equal(job.steps[checkout].with.ref, "${{ job.workflow_sha }}");
    assert.equal(job.steps[checkout].with["persist-credentials"], false);
    assert(!JSON.stringify(job).includes("uses: ./.github/actions/"));
  }
});
test("reusable interface uses an app-native command and complete native image inventory", () => {
  assert(workflow.on.workflow_call);
  assert.equal(
    workflow.on.workflow_call.inputs["verify-command"].default,
    "npm run verify",
  );
  assert.equal(
    workflow.jobs.validate.strategy.matrix.include[0].command,
    "${{ inputs.verify-command }}",
  );
  const content = JSON.stringify(workflow);
  assert(!content.includes("fieldsignal"));
  assert(!content.includes("nx show"));
  assert(!content.includes("select-base.sh"));
  assert.equal(
    workflow.on.workflow_call.outputs.candidate.value,
    "${{ jobs.publish-chart.outputs.candidate }}",
  );
});
test("candidate verification pins both platform signer revision and caller source identity", () => {
  const bind = workflow.jobs["publish-chart"].steps.find(
    (s) => s.name === "Bind native outputs and verify trusted image evidence",
  );
  assert.equal(bind.env.DELIVERY_REVISION, "${{ job.workflow_sha }}");
  for (const line of bind.run
    .split("\n")
    .filter((s) => s.trim().startsWith("gh attestation verify"))) {
    assert(
      line.includes(
        '--signer-workflow "$DELIVERY_SIGNER" --signer-digest "$DELIVERY_REVISION"',
      ),
    );
    assert(
      line.includes(
        '--source-ref refs/heads/main --source-digest "$GITHUB_SHA"',
      ),
    );
    assert(line.includes('--repo "$GITHUB_REPOSITORY"'));
  }
});
