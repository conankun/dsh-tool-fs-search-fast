#!/usr/bin/env node
/*
 * Install this fork into the DeepSeek Harness app bundle.
 *
 * The plugin lives inside app.asar, so installing means rewriting that archive:
 *  1. keep the first backup of the pristine archive (app.asar.bak-fast-<ts> + .sha256)
 *  2. build a new archive at <app.asar>.fast.tmp with our lib/index.js swapped in
 *  3. validate it structurally (entry count, replaced bytes, untouched spot hashes)
 *  4. atomic rename over the live archive
 *  5. prove Electron can import the plugin from the new archive; roll back on failure
 *
 * Usage:
 *   node tools/install.mjs [--app <DeepSeekChan-Harness.app>] [--dry-run]
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countEntries, entryBuffer, findEntry, loadArchive, replaceEntries, sha256, walkEntries } from "./asar-pack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const ENTRY = "dsh/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js";
const DEFAULT_APP = process.env.DSH_APP ?? "/Applications/DeepSeekChan-Harness.app";

function parseArgs(argv) {
  const options = { app: DEFAULT_APP, dryRun: false, skipProbe: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === "--app") options.app = argv[++at];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-probe") options.skipProbe = true;
    else throw new Error("unknown option " + arg);
  }
  return options;
}

function electronExecutable(appPath) {
  const macOSDir = join(appPath, "Contents", "MacOS");
  const names = readdirSync(macOSDir);
  if (names.length === 1) return join(macOSDir, names[0]);
  const plist = readFileSync(join(appPath, "Contents", "Info.plist"), "utf8");
  const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/u);
  if (match === null) throw new Error("cannot resolve the app executable");
  return join(macOSDir, match[1]);
}

function importProbe(appPath, asarPath) {
  const executable = electronExecutable(appPath);
  const target = "file://" + asarPath + "/" + ENTRY;
  const code = "import(" + JSON.stringify(target) + ").then(function (m) { console.log(\"EXPORTS=\" + Object.keys(m).length + \" TOOL=\" + m.name); }).catch(function (e) { console.error(\"IMPORT_FAIL \" + (e && e.message)); process.exit(1); });";
  try {
    const stdout = execFileSync(executable, ["-e", code], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    return { ok: false, output: String(error.stderr ?? error.message).trim() };
  }
}

function spotChecks(before, after, replacedPath) {
  const samples = [];
  walkEntries(before.header, "", (path, entry) => {
    if (path === replacedPath) return;
    if (typeof entry.offset !== "string") return;
    if (samples.length < 3) samples.push(path);
  });
  if (samples.length < 2) {
    walkEntries(before.header, "", (path, entry) => {
      if (path !== replacedPath && typeof entry.offset === "string" && !samples.includes(path)) samples.push(path);
    });
  }
  const checked = [];
  for (const path of samples.slice(0, 3)) {
    const a = sha256(entryBuffer(before, path));
    const b = sha256(entryBuffer(after, path));
    if (a !== b) throw new Error("validation: untouched entry changed: " + path);
    checked.push(path);
  }
  return checked;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const asarPath = join(options.app, "Contents", "Resources", "app.asar");
  if (!existsSync(asarPath)) throw new Error("app.asar not found: " + asarPath);
  const replacement = readFileSync(join(REPO, "lib", "index.js"));
  // Always build from the pristine backup when one exists, so re-installing is
  // idempotent and the header keeps the ORIGINAL byte length (stable dataStart).
  const pristine = existsSync(join(dirname(asarPath), readdirSync(dirname(asarPath)).filter((name) => name.startsWith("app.asar.bak-fast-")).sort()[0] ?? ""))
    ? join(dirname(asarPath), readdirSync(dirname(asarPath)).filter((name) => name.startsWith("app.asar.bak-fast-")).sort()[0])
    : asarPath;
  const before = loadArchive(pristine);

  const resources = dirname(asarPath);
  const backups = readdirSync(resources).filter((name) => name.startsWith("app.asar.bak-fast-")).sort();
  let backupPath = backups.length > 0 ? join(resources, backups[0]) : null;
  if (backupPath === null) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    backupPath = join(resources, "app.asar.bak-fast-" + stamp);
    if (options.dryRun) {
      console.log("[dry-run] would back up " + asarPath + " -> " + backupPath);
    } else {
      copyFileSync(asarPath, backupPath);
      writeFileSync(backupPath + ".sha256", sha256(readFileSync(asarPath)) + "  app.asar\n");
      console.log("backup: " + backupPath);
    }
  } else {
    console.log("backup: reusing " + backupPath);
  }

  if (entryBuffer(before, ENTRY).equals(replacement) && existsSync(asarPath) && entryBuffer(loadArchive(asarPath), ENTRY).equals(replacement)) {
    console.log("already installed: plugin bytes match " + asarPath);
    return;
  }
  const tempPath = asarPath + ".fast.tmp";
  const next = replaceEntries(before, [[ENTRY, replacement]]);
  if (options.dryRun) {
    console.log("[dry-run] built " + next.length + " bytes (+" + (next.length - before.buf.length) + "), would swap into " + asarPath);
    return;
  }
  writeFileSync(tempPath, next);
  const after = loadArchive(tempPath);
  if (countEntries(after.header) !== countEntries(before.header)) throw new Error("validation: entry count changed");
  if (!entryBuffer(after, ENTRY).equals(replacement)) throw new Error("validation: replacement bytes not applied");
  const expectedDelta = next.length - before.buf.length;
  if (statSync(tempPath).size !== next.length) throw new Error("validation: temp size mismatch");
  const checked = spotChecks(before, after, ENTRY);
  console.log("validation: entries=" + countEntries(after.header) + " delta=+" + expectedDelta + " dataStart=" + after.dataStart + " (pristine " + before.dataStart + ") spot-ok=" + checked.length);
  if (after.dataStart !== before.dataStart) console.warn("warning: dataStart moved - a running DSH instance should be restarted");

  renameSync(tempPath, asarPath);
  console.log("installed: " + asarPath + " (" + statSync(asarPath).size + " bytes)");

  if (options.skipProbe) {
    console.log("electron probe: skipped (--skip-probe)");
    console.log("rollback: node tools/uninstall.mjs --app " + options.app);
    return;
  }
  const probe = importProbe(options.app, asarPath);
  if (!probe.ok) {
    console.error("electron import probe FAILED: " + probe.output);
    console.error("rolling back to " + backupPath);
    copyFileSync(backupPath, asarPath);
    process.exitCode = 1;
    return;
  }
  console.log("electron probe: " + probe.output);
  console.log("rollback: node tools/uninstall.mjs --app " + options.app);
}

main();
