#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_REPO = "https://github.com/Vertias3u/PassControl";
const CANONICAL_SITE = "https://passcontrol.vertias.eu";

export function checkReleaseIntegrity(root = repoRoot) {
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const docs = ["README.md", "PUBLIC_README.md", "DOCUMENTATION.md", "TUTORIAL.md"].filter(
    (file) => fs.existsSync(path.join(root, file))
  );

  for (const file of docs) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    if (/github\.com\/(?:<[^>]+>|your[-_ ]?(?:name|org|user))/i.test(source)) {
      problems.push(`${file} contains a placeholder GitHub repository URL.`);
    }
  }

  // The private source carries PUBLIC_README.md; curate-public renames it to
  // README.md. The same gate must work before curation and inside the mirror.
  const publicReadmeFile = fs.existsSync(path.join(root, "PUBLIC_README.md"))
    ? "PUBLIC_README.md"
    : "README.md";
  const publicReadme = fs.readFileSync(path.join(root, publicReadmeFile), "utf8");
  if (/hosted demo (?:predates|does not have)/i.test(publicReadme)) {
    problems.push(`${publicReadmeFile} still says the hosted receipt verifier is unavailable.`);
  }
  if (!publicReadme.includes(`${CANONICAL_SITE}/verify/receipt`)) {
    problems.push(`${publicReadmeFile} does not link to the live hosted receipt verifier.`);
  }

  if (manifest.homepage !== CANONICAL_SITE) {
    problems.push(`package.json homepage must be ${CANONICAL_SITE}.`);
  }
  if (manifest.repository?.url !== `git+${CANONICAL_REPO}.git`) {
    problems.push(`package.json repository must be git+${CANONICAL_REPO}.git.`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
    problems.push("package.json version is not a publishable semantic version.");
  }
  if (!manifest.scripts?.["check:npm-pack"]?.includes("check:release")) {
    problems.push("The npm package gate does not run the release-integrity check.");
  }

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkReleaseIntegrity();
  if (problems.length) {
    console.error(problems.map((problem) => `✗ ${problem}`).join("\n"));
    process.exit(1);
  }
  console.log("✓ release integrity verified — canonical URLs, package metadata, and public claims agree");
}
