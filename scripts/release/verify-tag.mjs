#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function verifyTag({ tag, revision = "HEAD", gitRunner = git, packagePath = "package.json" }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || "")) throw new Error("tag must be v<semver>");
  if (gitRunner(["cat-file", "-t", tag]) !== "tag") throw new Error("tag must be annotated");
  if (gitRunner(["rev-parse", `${tag}^{}`]) !== gitRunner(["rev-parse", revision])) throw new Error("tag target mismatch");
  if (gitRunner(["status", "--porcelain"])) throw new Error("worktree is not clean");
  const version = JSON.parse(readFileSync(resolve(packagePath), "utf8")).version;
  if (`v${version}` !== tag) throw new Error("tag version mismatch");
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    verifyTag({ tag: process.env.GITHUB_REF_NAME || process.argv[2] });
    process.stdout.write("tag ok\n");
  } catch {
    process.stderr.write("tag verification failed\n");
    process.exitCode = 1;
  }
}
