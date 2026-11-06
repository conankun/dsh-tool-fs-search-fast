#!/usr/bin/env node
// Run through Electron-as-node so the app.asar is readable:
//   ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/DeepSeekChan-Harness" test/run.mjs [asarPath]
// Usage:
//   node test/run.mjs                                   # live app.asar (after install)
//   node test/run.mjs file:///tmp/x/pkg/lib/index.js    # sandbox with stub peers
//   ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/DeepSeekChan-Harness test/run.mjs <asarPath>
import { mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_ASAR = process.env.DSH_ASAR ?? "/Applications/DeepSeekChan-Harness.app/Contents/Resources/app.asar";
const target = process.argv[2];
const entry = target === void 0
	? `${DEFAULT_ASAR}/dsh/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js`
	: target.startsWith("file:") ? target : `${target}/dsh/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js`;

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("PASS " + name);
  } else {
    failures += 1;
    console.log("FAIL " + name + (detail === void 0 ? "" : " :: " + detail));
  }
};

const entryUrl = entry.startsWith("file:") ? entry : `file://${entry}`;
const mod = await import(entryUrl);

check("module loads", typeof mod.apply === "function");
check("tool name unchanged", mod.name === "tool-fs-search");
for (const exported of ["buildGlobCommand", "buildGrepCommand", "sortPathsByMtime", "runRipgrepStreaming", "isInsideExcludedDir", "GLOB_EXCLUDE_DIRS", "Config"]) {
  check("exports " + exported, mod[exported] !== void 0);
}

const argv = mod.buildGlobCommand({ pattern: "**/*.ts" });
check("glob argv has no --sort=modified", !argv.includes("--sort=modified"), JSON.stringify(argv));
check("glob argv parallel threads", argv.includes("--threads=0"));
const patternAt = argv.indexOf("--glob=**/*.ts");
const pruneAt = argv.findIndex((a) => a.startsWith("--glob=!**/node_modules"));
check("pruning glob comes after the pattern (last-match-wins)", patternAt !== -1 && pruneAt > patternAt, `pattern@${patternAt} prune@${pruneAt}`);
check("vcs exclude kept", argv.includes("--glob=!**/.git"));

const noPrune = mod.buildGlobCommand({ pattern: "**/*" }, []);
check("empty excludeDirs disables pruning", !noPrune.some((a) => a.includes("node_modules")));

// upstream 0.2.2-rc.1 delta: literal directory prefixes prune unrelated subtrees.
const prefixed = mod.buildGlobCommand({ pattern: "src/lib/*.ts" });
check("literal prefix pruning adds exclude-all + directory glob", prefixed.includes("--glob=!**") && prefixed.includes("--glob={src,lib}/"), JSON.stringify(prefixed));
check("literal prefix pruning precedes the pattern (last-match-wins)", prefixed.indexOf("--glob={src,lib}/") < prefixed.indexOf("--glob=src/lib/*.ts"));
const wildcardPrefix = mod.buildGlobCommand({ pattern: "src/**/*.ts" });
check("wildcard directory disables prefix pruning", !wildcardPrefix.includes("--glob=!**"));
const withPath = mod.buildGlobCommand({ pattern: "src/lib/*.ts", path: "src" });
check("explicit path disables prefix pruning", !withPath.includes("--glob=!**"));

check("isInsideExcludedDir node_modules", mod.isInsideExcludedDir("a/node_modules/b", ["node_modules"]) === true);
check("isInsideExcludedDir negative", mod.isInsideExcludedDir("src/lib", ["node_modules"]) === false);
check("isInsideExcludedDir absolute", mod.isInsideExcludedDir("/x/node_modules", ["node_modules"]) === true);

// upstream 0.2.2-rc.1 delta: an exact empty `include` is treated as omitted.
check("empty include treated as omitted", mod.parseGrepArgs({ pattern: "x", include: "" }).include === void 0);
check("non-empty include preserved", mod.parseGrepArgs({ pattern: "x", include: "*.ts" }).include === "*.ts");
const emptyIncludeCard = mod.presentGrepCall({ pattern: "x", include: "" });
check("empty include adds no filter to card title", emptyIncludeCard.title === "Grep x", String(emptyIncludeCard.title));
const whitespaceIncludeRejected = (() => {
  try {
    mod.parseGrepArgs({ pattern: "x", include: "   " });
    return false;
  } catch {
    return true;
  }
})();
check("whitespace-only include still rejected", whitespaceIncludeRejected);

const cfg = mod.Config({ sampleOverCapGlobResults: false });
check("Config default globExcludeDirs", Array.isArray(cfg.globExcludeDirs) && cfg.globExcludeDirs.includes("node_modules"), JSON.stringify(cfg.globExcludeDirs));
check("Config keeps 250 grep matches", cfg.grepMaxMatches === 250);
check("Config accepts custom globExcludeDirs", JSON.stringify(mod.Config({ sampleOverCapGlobResults: false, globExcludeDirs: [] }).globExcludeDirs) === "[]");

const dir = await mkdtemp(join(tmpdir(), "fastfstest-"));
const files = ["old.ts", "mid.ts", "new.ts"];
for (const [index, name] of files.entries()) {
  await writeFile(join(dir, name), "export const x = import_\n".repeat(3));
  const timestamp = 1_600_000_000 + index * 1000;
  await utimes(join(dir, name), timestamp, timestamp);
}
const ordered = await mod.sortPathsByMtime(files.map((f) => join(dir, f)).reverse(), dir);
check("sortPathsByMtime ascending", ordered.map((p) => p.split("/").pop()).join(",") === "old.ts,mid.ts,new.ts", ordered.join(","));

// Worker-thread stat fan-out: same order as the inline path, forced through the
// worker lane by lowering the path threshold for this check only.
const previousThreshold = process.env.DSH_FS_SEARCH_MTIME_WORKERS_MIN;
process.env.DSH_FS_SEARCH_MTIME_WORKERS_MIN = "2";
const workerOrdered = await mod.sortPathsByMtime(files.map((f) => join(dir, f)).reverse(), dir);
if (previousThreshold === void 0) delete process.env.DSH_FS_SEARCH_MTIME_WORKERS_MIN;
else process.env.DSH_FS_SEARCH_MTIME_WORKERS_MIN = previousThreshold;
check("sortPathsByMtime ascending (worker fan-out)", workerOrdered.map((p) => p.split("/").pop()).join(",") === "old.ts,mid.ts,new.ts", workerOrdered.join(","));

const signal = new AbortController().signal;
const ctx = { workingDirectory: { ensure: async () => process.cwd() } };
const exec = { agent: void 0, signal };
const bigFile = join(dir, "many.txt");
await writeFile(bigFile, "import a\n".repeat(500));
const capped = await mod.runRipgrepStreaming(ctx, exec, "grep", ["--json", `--regexp=import`, "--", dir], 5, 65536);
const cappedMatches = capped.stdout.split("\n").filter((line) => line.startsWith('{"type":"match"')).length;
check("streaming grep stops at the cap", cappedMatches === 5, String(cappedMatches));
check("streaming grep output is complete NDJSON", capped.stdout.endsWith("\n"));
check("streaming grep reports results (not noMatches)", capped.noMatches === false);

const zero = await mod.runRipgrepStreaming(ctx, exec, "grep", ["--json", "--regexp=zzz_no_such_token", "--", dir], 5, 65536);
check("streaming grep no-match exit flag", zero.noMatches === true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
