import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Skill metadata enables implicit routing with explicit local and CodeGraph gates", () => {
  const skill = readFileSync("SKILL.md", "utf8");
  const metadata = readFileSync("agents/openai.yaml", "utf8");
  assert.match(metadata, /allow_implicit_invocation: true/);
  assert.doesNotMatch(metadata, /\$fast-context/);
  assert.match(skill, /known files, literals,\n   configuration, logs, and realtime content/);
  assert.match(skill, /CodeGraph for known symbols, callers\/callees, structure, relationships/);
  assert.match(skill, /Do not trigger this Skill merely because a request is written in natural\nlanguage/);
  assert.match(skill, /Do not run CodeGraph and Fast Context automatically in parallel/);
  assert.match(skill, /do not treat one CodeGraph miss as a mechanical external fallback/);
  assert.match(skill, /external documentation, ordinary conversation, and requests that only need/);
  assert.match(skill, /do not write it to Trellis, OpenViking,\nCodeGraph, or context-mode persistent indexes/);
});
