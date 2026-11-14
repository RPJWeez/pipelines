import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const [directory, planPath] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath));
const expected = plan.selected.images;
const metadata = {};
let bake;
for (const name of fs.readdirSync(directory)) {
  const root = path.join(directory, name);
  if (!fs.statSync(root).isDirectory()) continue;
  const current = JSON.parse(fs.readFileSync(path.join(root, "bake.json")));
  if (bake)
    assert.deepEqual(
      current,
      bake,
      "matrix jobs resolved different native inventories",
    );
  else bake = current;
  const part = JSON.parse(fs.readFileSync(path.join(root, "metadata.json")));
  assert.equal(
    Object.keys(part).length,
    1,
    "one native output per image job required",
  );
  for (const [target, result] of Object.entries(part)) {
    assert(
      expected.includes(target) && !metadata[target],
      "unexpected or duplicate native image output",
    );
    assert.match(result["containerimage.digest"], /^sha256:[a-f0-9]{64}$/);
    metadata[target] = result;
  }
}
assert.deepEqual(
  Object.keys(metadata).sort(),
  [...expected].sort(),
  "complete image set required",
);
assert.deepEqual(
  bake.group.application.targets,
  expected,
  "build inventory differs from plan",
);
fs.writeFileSync(".work/bake.json", JSON.stringify(bake));
fs.writeFileSync(".work/metadata.json", JSON.stringify(metadata));
