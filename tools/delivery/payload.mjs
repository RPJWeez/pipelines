import assert from "node:assert/strict";
import fs from "node:fs";
// Bound JSON before parsing attacker-influenced downloaded metadata.
const [root] = process.argv.slice(2);
let total = 0;
for (const name of fs.readdirSync(root)) {
  const p = `${root}/${name}`,
    s = fs.lstatSync(p);
  assert(
    s.isFile() && !s.isSymbolicLink(),
    "only regular payload files permitted",
  );
  assert(/^(package\.json|chart\.tgz|[a-z0-9][a-z0-9-]*\.tar)$/.test(name));
  total += s.size;
  assert(
    total <= 4 * 1024 ** 3,
    "payload exceeds hosted 4 GiB transfer profile",
  );
  assert(
    s.size <= (name.endsWith(".json") ? 4 * 1024 ** 2 : 2 * 1024 ** 3),
    "oversized payload",
  );
}
