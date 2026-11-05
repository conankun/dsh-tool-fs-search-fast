#!/usr/bin/env node
/*
 * asar read-modify-write for the DeepSeek Harness app bundle.
 *
 * Chromium Pickle layout (proved byte-identical by --selftest against the live
 * 222 MB archive and two older backups):
 *   0   u32 LE  4                    size-pickle payload length
 *   4   u32 LE  headerPickleSize     8 + headerPickleSize = dataStart
 *   8   u32 LE  payloadSize          jsonLen + 4 + pad(0..3)
 *   12  u32 LE  jsonLen
 *   16  ...     JSON header, then 0..3 zero pad bytes
 *
 * Replacement strategy: leave the original data region untouched, APPEND the
 * new file bytes at its end and repoint that entry's offset/size relative to
 * dataStart. Header growth shifts the whole data region automatically, so
 * untouched entry offsets stay valid. The archive grows only by the replacement
 * size; dead original bytes are left in place on purpose (the live archive
 * already carries ~10 MB of such gaps from an earlier hand repack).
 *
 * Integrity is stripped only for replaced entries (their hash is stale);
 * untouched entries keep theirs.
 *
 * Usage:
 *   node tools/asar-pack.mjs --selftest [asarPath]
 *   node tools/asar-pack.mjs --replace <entryPath>=<localFile> [--in <asar>] [--out <asar>]
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

function parseArchive(buf) {
  if (buf.length < 16) throw new Error("asar: file too small");
  const sizeField = buf.readUInt32LE(0);
  if (sizeField !== 4) throw new Error("asar: unexpected size-pickle payload " + sizeField);
  const headerPickleSize = buf.readUInt32LE(4);
  const payloadSize = buf.readUInt32LE(8);
  const jsonLen = buf.readUInt32LE(12);
  const pad = (4 - (jsonLen % 4)) % 4;
  if (payloadSize !== jsonLen + 4 + pad) {
    throw new Error("asar: payload size " + payloadSize + " != jsonLen " + jsonLen + " + 4 + pad " + pad);
  }
  if (headerPickleSize !== payloadSize + 4) {
    throw new Error("asar: header pickle size " + headerPickleSize + " != payload + 4");
  }
  const dataStart = 8 + headerPickleSize;
  if (dataStart > buf.length) throw new Error("asar: dataStart beyond EOF");
  const jsonText = buf.subarray(16, 16 + jsonLen).toString("utf8");
  let header;
  try {
    header = JSON.parse(jsonText);
  } catch (error) {
    throw new Error("asar: header JSON parse failed: " + error.message);
  }
  return { header, headerPickleSize, payloadSize, jsonLen, jsonText, dataStart };
}

function buildArchive(header, data, jsonLengthTarget) {
  const text = JSON.stringify(header);
  const json = Buffer.from(
    jsonLengthTarget !== void 0 && jsonLengthTarget > text.length ? text + " ".repeat(jsonLengthTarget - text.length) : text,
    "utf8"
  );
  const pad = (4 - (json.length % 4)) % 4;
  const payloadSize = json.length + 4 + pad;
  const headerPickleSize = payloadSize + 4;
  const out = Buffer.alloc(8 + headerPickleSize + data.length);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerPickleSize, 4);
  out.writeUInt32LE(payloadSize, 8);
  out.writeUInt32LE(json.length, 12);
  json.copy(out, 16);
  data.copy(out, 8 + headerPickleSize);
  return out;
}

function walkFiles(node, prefix, visit) {
  for (const [name, value] of Object.entries(node.files)) {
    const path = prefix === "" ? name : prefix + "/" + name;
    if (value.files !== void 0) walkFiles(value, path, visit);
    else visit(path, value);
  }
}

function findEntry(header, entryPath) {
  let found = null;
  walkFiles(header, "", (path, entry) => {
    if (path === entryPath) found = entry;
  });
  if (found === null) throw new Error("asar: entry not found: " + entryPath);
  return found;
}

function countEntries(header) {
  let count = 0;
  walkFiles(header, "", () => {
    count += 1;
  });
  return count;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function loadArchive(path) {
  const buf = readFileSync(path);
  const parsed = parseArchive(buf);
  return { buf, ...parsed, data: buf.subarray(parsed.dataStart) };
}

function entryBuffer(archive, path) {
  const entry = findEntry(archive.header, path);
  if (typeof entry.offset !== "string") throw new Error("asar: entry has no offset (unpacked): " + path);
  const offset = Number(entry.offset);
  const size = Number(entry.size);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(size) || size < 0) {
    throw new Error("asar: bad offset/size for " + path);
  }
  if (offset + size > archive.data.length) throw new Error("asar: entry range outside data region: " + path);
  return archive.data.subarray(offset, offset + size);
}

function replaceEntries(archive, replacements, options) {
  const preserveHeaderSize = options === void 0 || options.preserveHeaderSize !== false;
  const header = JSON.parse(JSON.stringify(archive.header));
  const appended = [];
  let cursor = archive.data.length;
  for (const [path, content] of replacements) {
    const entry = findEntry(header, path);
    if (typeof entry.offset !== "string") throw new Error("asar: refusing to replace an unpacked entry: " + path);
    entry.size = content.length;
    entry.offset = String(cursor);
    delete entry.integrity;
    appended.push(content);
    cursor += content.length;
  }
  const data = Buffer.concat([archive.data, ...appended]);
  // Keeping the header EXACTLY the same byte length keeps dataStart stable, so
  // a DSH instance that is already running against the previous archive (and has
  // cached its header) still reads untouched entries at the same offsets.
  return buildArchive(header, data, preserveHeaderSize ? archive.jsonLen : void 0);
}

function selftest(asarPath) {
  const archive = loadArchive(asarPath);
  const rebuilt = buildArchive(archive.header, archive.data);
  const sizeEqual = rebuilt.length === archive.buf.length;
  const bytesEqual = sizeEqual && rebuilt.equals(archive.buf);
  const headerJsonStable = JSON.stringify(archive.header) === archive.jsonText;
  const inputSha = sha256(archive.buf);
  const outputSha = sha256(rebuilt);
  console.log("entries=" + countEntries(archive.header) + " dataStart=" + archive.dataStart + " dataLength=" + archive.data.length + " bytes=" + archive.buf.length);
  console.log("header JSON round-trip identical: " + headerJsonStable);
  console.log("output size equal: " + sizeEqual);
  console.log("output bytes identical: " + bytesEqual);
  console.log("output sha256 equal: " + (inputSha === outputSha) + " (" + inputSha.slice(0, 16) + "...)");
  let ok = headerJsonStable && bytesEqual && inputSha === outputSha;
  if (!bytesEqual) {
    const limit = Math.min(rebuilt.length, archive.buf.length);
    for (let at = 0; at < limit; at += 1) {
      if (rebuilt[at] !== archive.buf[at]) {
        console.log("first differing byte: " + at);
        break;
      }
    }
    ok = false;
  }
  if (!ok) process.exitCode = 1;
  return ok;
}

function parseArgs(argv) {
  const options = { replaces: [], inPath: null, outPath: null, selftest: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === "--selftest") options.selftest = true;
    else if (arg === "--no-preserve-header-size") options.noPreserveHeaderSize = true;
    else if (arg === "--in") options.inPath = argv[++at];
    else if (arg === "--out") options.outPath = argv[++at];
    else if (arg === "--replace") {
      const spec = argv[++at] ?? "";
      const split = spec.indexOf("=");
      if (split === -1) throw new Error("--replace expects <entryPath>=<localFile>");
      options.replaces.push([spec.slice(0, split), spec.slice(split + 1)]);
    } else if (arg.startsWith("--")) throw new Error("unknown option " + arg);
    else if (options.inPath === null) options.inPath = arg;
    else throw new Error("unexpected argument " + arg);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inPath = options.inPath ?? process.env.DSH_ASAR ?? "/Applications/DeepSeekChan-Harness.app/Contents/Resources/app.asar";
  if (options.selftest) {
    selftest(inPath);
    return;
  }
  if (options.replaces.length === 0) throw new Error("nothing to do: pass --replace or --selftest");
  const outPath = options.outPath ?? inPath.replace(/\.asar$/, ".fast.tmp.asar");
  const archive = loadArchive(inPath);
  const replacements = options.replaces.map(([path, file]) => [path, readFileSync(file)]);
  const out = replaceEntries(archive, replacements, { preserveHeaderSize: !options.noPreserveHeaderSize });
  writeFileSync(outPath, out);
  const verify = loadArchive(outPath);
  if (countEntries(verify.header) !== countEntries(archive.header)) throw new Error("verify: entry count changed");
  for (const [path, content] of replacements) {
    if (!entryBuffer(verify, path).equals(content)) throw new Error("verify: replacement mismatch: " + path);
  }
  console.log("wrote " + outPath + " bytes=" + statSync(outPath).size + " delta=+" + (out.length - archive.buf.length));
}

if (process.argv[1] !== void 0 && process.argv[1].endsWith("asar-pack.mjs")) main();

export { buildArchive, countEntries, entryBuffer, findEntry, loadArchive, parseArchive, replaceEntries, selftest, sha256, walkFiles as walkEntries };
