// Print the CHANGELOG.md section for one version (used by the release workflow
// as the GitHub Release body). Usage: node scripts/changelog-section.mjs 0.6.0

import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: changelog-section.mjs <version>");
  process.exit(2);
}
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const start = changelog.indexOf(`## [${version}]`);
if (start === -1) {
  console.error(`no "## [${version}]" section in CHANGELOG.md`);
  process.exit(1);
}
const rest = changelog.slice(start);
const next = rest.indexOf("\n## [", 1);
process.stdout.write(`${(next === -1 ? rest : rest.slice(0, next)).trim()}\n`);
