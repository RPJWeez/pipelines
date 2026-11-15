import assert from "node:assert/strict";
import fs from "node:fs";
import {
  descriptor,
  read,
  write,
  predicates,
  releaseRE,
  existingDesignation,
  reference,
} from "./contracts.mjs";
import { loadPackage, verifyImages, run } from "./registry.mjs";
const [dPath, composerPath, output] = process.argv.slice(2);
const d = descriptor(read(dPath)),
  composer = read(composerPath);
const candidate = process.env.CANDIDATE,
  releaseId = process.env.RELEASE_ID;
assert.match(releaseId, releaseRE);
const p = loadPackage(candidate, d, composer.repository);
verifyImages(p, d, composer.repository);
// QA stays in the existing QA/CD workflow. The release owner reviews its evidence
// for this candidate; an arbitrary green run does not prove compatibility.
const qaRun = process.env.QA_RUN;
const match =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([0-9]+)$/.exec(
    qaRun || "",
  );
assert(
  match,
  "Provide the successful QA run URL you reviewed for this candidate",
);
const qa = JSON.parse(
  run("gh", ["api", `repos/${match[1]}/actions/runs/${match[2]}`]),
);
assert.equal(qa.status, "completed", "QA run has not completed");
assert.equal(qa.conclusion, "success", "QA run did not pass");
let release = {
  schemaVersion: 1,
  kind: "release",
  application: d.application,
  candidate,
  releaseId,
  qaRun,
  approvedAt: new Date().toISOString(),
  promotedBy: composer,
  actor: process.env.GITHUB_ACTOR,
};
fs.mkdirSync(output, { recursive: true });
write(`${output}/release.json`, release);
// Git refs provide atomic create-if-absent. A release ID is never overwritten or recycled.
const tag = releaseId;
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
  // Keep the first release record; a retry must not change its candidate or QA reference.
  release = existingDesignation(previous, release);
  write(`${output}/release.json`, release);
}
// Publish a normal GitHub Release so operators use the repository's Releases page.
const notes = `Candidate: ${candidate}\nQA run reviewed: ${release.qaRun}\nRelease owner: ${release.actor}\n\nThis release selects existing artifacts. No rebuild or deployment.`;
try {
  run("gh", ["api", `repos/${composer.repository}/releases/tags/${tag}`]);
} catch {
  run("gh", [
    "api",
    "--method",
    "POST",
    `repos/${composer.repository}/releases`,
    "-f",
    `tag_name=${tag}`,
    "-f",
    `name=${releaseId}`,
    "-f",
    `body=${notes}`,
  ]);
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
