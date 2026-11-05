#!/usr/bin/env node
/*
 * Restore the pristine DeepSeek Harness app.asar saved by tools/install.mjs.
 * The first backup (app.asar.bak-fast-<ts>) is the stock archive; it is kept on
 * disk after a restore so re-installing does not need a new 222 MB copy.
 *
 * Usage: node tools/uninstall.mjs [--app <DeepSeekChan-Harness.app>]
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./asar-pack.mjs";

const DEFAULT_APP = process.env.DSH_APP ?? "/Applications/DeepSeekChan-Harness.app";
const argv = process.argv.slice(2);
let app = DEFAULT_APP;
for (let at = 0; at < argv.length; at += 1) {
  if (argv[at] === "--app") app = argv[++at];
  else throw new Error("unknown option " + argv[at]);
}

const asarPath = join(app, "Contents", "Resources", "app.asar");
const resources = dirname(asarPath);
if (!existsSync(resources)) throw new Error("resources dir not found: " + resources);
const backups = readdirSync(resources).filter((name) => name.startsWith("app.asar.bak-fast-")).sort();
if (backups.length === 0) throw new Error("no app.asar.bak-fast-* backup found; cannot restore");
const backupPath = join(resources, backups[0]);
const sidecar = backupPath + ".sha256";
if (existsSync(sidecar)) {
  const expected = readFileSync(sidecar, "utf8").trim().split(/\s+/u)[0];
  const actual = sha256(readFileSync(backupPath));
  if (expected !== actual) throw new Error("backup checksum mismatch: " + backupPath);
  console.log("backup checksum: OK (" + actual.slice(0, 16) + "...)");
} else {
  console.log("backup checksum: no sidecar, skipping verification");
}
const before = sha256(readFileSync(asarPath));
copyFileSync(backupPath, asarPath);
const restored = sha256(readFileSync(asarPath));
const backupSha = sha256(readFileSync(backupPath));
console.log("restored: " + asarPath + " (" + statSync(asarPath).size + " bytes)");
console.log("restore verified: " + (restored === backupSha) + " (replaced " + before.slice(0, 16) + "..., now " + restored.slice(0, 16) + "...)");
