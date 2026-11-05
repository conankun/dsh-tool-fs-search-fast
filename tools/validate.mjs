#!/usr/bin/env node
/*
 * Inspect an app.asar and prove the forked plugin is importable from it.
 *
 * Usage: node tools/validate.mjs [--app <app>] [--asar <path>]
 */
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { countEntries, entryBuffer, loadArchive, sha256 } from "./asar-pack.mjs";

const ENTRY = "dsh/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js";
const DEFAULT_APP = process.env.DSH_APP ?? "/Applications/DeepSeekChan-Harness.app";
const argv = process.argv.slice(2);
let app = DEFAULT_APP;
let asarPath = null;
for (let at = 0; at < argv.length; at += 1) {
  if (argv[at] === "--app") app = argv[++at];
  else if (argv[at] === "--asar") asarPath = argv[++at];
  else throw new Error("unknown option " + argv[at]);
}
if (asarPath === null) asarPath = join(app, "Contents", "Resources", "app.asar");

const archive = loadArchive(asarPath);
const pluginBytes = entryBuffer(archive, ENTRY);
console.log("asar: " + asarPath);
console.log("entries: " + countEntries(archive.header) + " dataStart: " + archive.dataStart + " bytes: " + archive.buf.length);
console.log("plugin entry: " + pluginBytes.length + " bytes sha256 " + sha256(pluginBytes).slice(0, 16) + "...");

const macOSDir = join(app, "Contents", "MacOS");
const executable = join(macOSDir, readdirSync(macOSDir)[0]);
const code = "import(" + JSON.stringify("file://" + asarPath + "/" + ENTRY) + ").then(function (m) { console.log(\"exports=\" + Object.keys(m).length + \" name=\" + m.name + \" hidden=\" + (m.GLOB_EXCLUDE_DIRS ? m.GLOB_EXCLUDE_DIRS.length : 0)); }).catch(function (e) { console.error(\"import failed: \" + (e && e.message)); process.exit(1); });";
try {
  const stdout = execFileSync(executable, ["-e", code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  console.log("electron import: " + stdout.trim());
} catch (error) {
  console.error("electron import: FAILED");
  console.error(String(error.stderr ?? error.message));
  process.exitCode = 1;
}
