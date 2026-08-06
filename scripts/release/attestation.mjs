#!/usr/bin/env node

import { createHash } from "node:crypto";

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const TAG_METADATA_KEYS = [
  "fast-context-release",
  "tag",
  "package",
  "source_commit",
  "evidence_commit",
  "parent_commit",
  "provenance_sha256",
  "package_manifest_sha256",
  "tarball_filename",
  "tarball_sha256",
  "canonical_attestation_sha256",
  "raw_attestation_sha256",
];

function cloneWithoutCanonicalDigest(value) {
  if (Array.isArray(value)) return value.map(cloneWithoutCanonicalDigest);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "canonical_attestation_sha256")
      .map(([key, entry]) => [key, cloneWithoutCanonicalDigest(entry)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(cloneWithoutCanonicalDigest(value));
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalAttestationSha256(document) {
  return sha256Bytes(canonicalJson(document));
}

export function tarballFilename(packageName, version) {
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(packageName) || !VERSION.test(version)) {
    throw new Error("invalid package coordinate for tarball filename");
  }
  return `${packageName.slice(1).replace("/", "-")}-${version}.tgz`;
}

function requireString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid attestation ${label}`);
  }
}

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid attestation ${label}`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`invalid attestation ${label} keys`);
  }
}

export function validateAttestation(document) {
  requireExactKeys(document, [
    "schema_version",
    "package",
    "source",
    "artifacts",
    "canonical_attestation_sha256",
  ], "root");
  if (![1, 2].includes(document.schema_version)) throw new Error("unsupported attestation schema");
  requireExactKeys(document.package, ["name", "version"], "package");
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(document.package.name)) {
    throw new Error("invalid attestation package name");
  }
  requireString(document.package.version, VERSION, "package version");
  requireExactKeys(document.source, ["commit"], "source");
  requireString(document.source.commit, COMMIT, "source commit");
  const artifactKeys = [
    "provenance_sha256",
    "package_manifest_sha256",
    "tarball_filename",
    "tarball_sha256",
  ];
  if (document.schema_version === 2) artifactKeys.push("consumer_manifest_sha256");
  requireExactKeys(document.artifacts, artifactKeys, "artifacts");
  for (const key of ["provenance_sha256", "package_manifest_sha256", "tarball_sha256"]) {
    requireString(document.artifacts[key], HEX_SHA256, `artifact ${key}`);
  }
  if (document.schema_version === 2) {
    requireString(document.artifacts.consumer_manifest_sha256, HEX_SHA256, "artifact consumer_manifest_sha256");
  }
  if (document.artifacts.tarball_filename !== tarballFilename(document.package.name, document.package.version)) {
    throw new Error("invalid attestation tarball filename");
  }
  requireString(document.canonical_attestation_sha256, HEX_SHA256, "canonical digest");
  if (canonicalAttestationSha256(document) !== document.canonical_attestation_sha256) {
    throw new Error("attestation canonical digest mismatch");
  }
  return document;
}

export function formatTagMetadata(metadata) {
  const values = {
    "fast-context-release": "1",
    ...metadata,
  };
  for (const key of TAG_METADATA_KEYS) {
    if (typeof values[key] !== "string" || values[key].length === 0 || /[\r\n]/.test(values[key])) {
      throw new Error(`invalid tag metadata ${key}`);
    }
  }
  return TAG_METADATA_KEYS.map((key) => `${key}=${values[key]}`).join("\n");
}

export function parseTagMetadata(message) {
  if (typeof message !== "string") throw new Error("tag message must be text");
  const lines = message.replace(/\n+$/, "").split("\n");
  if (lines.length !== TAG_METADATA_KEYS.length) throw new Error("tag metadata line count mismatch");
  const result = {};
  lines.forEach((line, index) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("malformed tag metadata");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key !== TAG_METADATA_KEYS[index] || !value || Object.hasOwn(result, key) || /[\r\n]/.test(value)) {
      throw new Error("invalid tag metadata ordering or duplicate");
    }
    result[key] = value;
  });
  return result;
}

export function validateTagMetadata(metadata) {
  if (metadata["fast-context-release"] !== "1") throw new Error("unsupported tag metadata schema");
  requireString(metadata.tag, /^v\d+\.\d+\.\d+$/, "tag metadata tag");
  const separator = metadata.package.lastIndexOf("@");
  if (separator <= 0) throw new Error("invalid tag metadata package");
  const packageDocument = {
    name: metadata.package.slice(0, separator),
    version: metadata.package.slice(separator + 1),
  };
  requireString(packageDocument.name, /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/, "tag metadata package name");
  requireString(packageDocument.version, VERSION, "tag metadata package version");
  for (const key of ["source_commit", "evidence_commit", "parent_commit"]) {
    requireString(metadata[key], COMMIT, `tag metadata ${key}`);
  }
  for (const key of [
    "provenance_sha256",
    "package_manifest_sha256",
    "tarball_sha256",
    "canonical_attestation_sha256",
    "raw_attestation_sha256",
  ]) {
    requireString(metadata[key], HEX_SHA256, `tag metadata ${key}`);
  }
  if (metadata.tarball_filename !== tarballFilename(packageDocument.name, packageDocument.version)) {
    throw new Error("invalid tag metadata tarball filename");
  }
  return metadata;
}

export { COMMIT, HEX_SHA256, TAG_METADATA_KEYS, VERSION };
