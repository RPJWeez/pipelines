import assert from "node:assert/strict";
import fs from "node:fs";
import {
  descriptor,
  read,
  write,
  certification,
  predicates,
  nameRE,
  existingDesignation,
  reference,
} from "./contracts.mjs";
import { loadPackage, verifyImages, verified, run } from "./registry.mjs";
const [dPath, composerPath, output] = process.argv.slice(2);
const d = descriptor(read(dPath)),
  composer = read(composerPath);
const candidate = process.env.CANDIDATE,
  releaseId = process.env.RELEASE_ID;
assert.match(releaseId, nameRE);
const p = loadPackage(candidate, d, composer.repository);
verifyImages(p, d, composer.repository);
const policy = d.policy.certification;
let releaseDecisionRevision;
const proofs = verified(
  candidate,
  {
    repository: policy.repository,
    token: process.env.CERTIFICATION_READ_TOKEN,
    revision: policy.revision,
    ref: `refs/heads/${d.releaseBranch}`,
  },
  policy.workflow,
  policy.predicateType,
);
const proof = proofs.sort(
  (a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt),
)[0];
certification(proof, candidate, policy);
const branch = JSON.parse(
  run("gh", ["api", `repos/${policy.repository}/branches/${d.releaseBranch}`], {
    env: {
      ...process.env,
      GH_TOKEN: process.env.CERTIFICATION_READ_TOKEN || process.env.GH_TOKEN,
    },
  }),
);
assert.equal(
  branch.protected,
  true,
  "certification decision branch must be protected",
);
const decisionFile = JSON.parse(
  run(
    "gh",
    [
      "api",
      `repos/${policy.repository}/contents/${policy.decisionsPath}?ref=${branch.commit.sha}`,
    ],
    {
      env: {
        ...process.env,
        GH_TOKEN: process.env.CERTIFICATION_READ_TOKEN || process.env.GH_TOKEN,
      },
    },
  ),
);
const decisions = JSON.parse(
  Buffer.from(decisionFile.content, "base64").toString("utf8"),
);
assert.equal(decisions.schemaVersion, 1);
assert.equal(
  decisions.candidates?.[candidate]?.status,
  "eligible",
  "candidate absent or revoked in current decision ledger",
);
assert.equal(
  decisions.candidates[candidate].policyVersion,
  policy.policyVersion,
);
assert(
  Date.parse(decisions.candidates[candidate].expiresAt) > Date.now(),
  "eligibility decision expired",
);
releaseDecisionRevision = branch.commit.sha;
// Fetch the current policy revision's decision every run. Fail closed on outage/revocation.
// Organization policy must pin/roll forward certification revision as policy changes.
let release = {
  schemaVersion: 1,
  kind: "release",
  application: d.application,
  candidate,
  releaseId,
  certification: proof,
  releaseDecisionRevision,
  policyVersion: policy.policyVersion,
  promotedBy: composer,
  actor: process.env.GITHUB_ACTOR,
};
fs.mkdirSync(output, { recursive: true });
write(`${output}/release.json`, release);
// Git refs provide atomic create-if-absent. A release ID is never overwritten or recycled.
const tag = `delivery-release/${releaseId}`;
const endpoint = `repos/${composer.repository}/git/refs`;
const tagObject = JSON.parse(
  run("gh", [
    "api",
    "--method",
    "POST",
    `repos/${composer.repository}/git/tags`,
    "-f",
    `tag=${tag}`,
    "-f",
    `message=${JSON.stringify(release)}`,
    "-f",
    `object=${composer.controlSource}`,
    "-f",
    "type=commit",
  ]),
);
try {
  run("gh", [
    "api",
    "--method",
    "POST",
    endpoint,
    "-f",
    `ref=refs/tags/${tag}`,
    "-f",
    `sha=${tagObject.sha}`,
  ]);
} catch {
  const existingRef = JSON.parse(
    run("gh", ["api", `repos/${composer.repository}/git/ref/tags/${tag}`]),
  );
  assert.equal(existingRef.object.type, "tag");
  const existing = JSON.parse(
    run("gh", [
      "api",
      `repos/${composer.repository}/git/tags/${existingRef.object.sha}`,
    ]),
  );
  const previous = JSON.parse(existing.message);
  // Current eligibility was rechecked above; retain the original immutable record.
  release = existingDesignation(previous, release);
  write(`${output}/release.json`, release);
}
const subject = reference(candidate);
fs.appendFileSync(
  process.env.GITHUB_OUTPUT,
  `name=${subject.name}\ndigest=${subject.digest}\n`,
);
fs.writeFileSync(
  `${output}/summary.md`,
  `## Release designated\n\nRelease: \`${releaseId}\`\n\nCandidate: \`${candidate}\`\n\nNo rebuild, repackaging or deployment. Successful release attestation is required to consume this designation.\n`,
);
