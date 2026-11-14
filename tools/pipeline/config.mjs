import fs from "node:fs";
const config = JSON.parse(
  fs.readFileSync(new URL("./config.json", import.meta.url)),
);
for (const [key, value] of Object.entries(config)) {
  if (typeof value !== "string" || /[\r\n]/.test(value))
    throw Error(`Invalid configuration: ${key}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
