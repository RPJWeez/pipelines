import assert from "node:assert/strict";
import fs from "node:fs";
assert.equal(process.cwd(), "/workspace");
fs.writeFileSync("container-only-output", "verified");
assert.equal(fs.existsSync("/source/container-only-output"), false);
console.log("PASS: application-native hook, isolated writable copy");
