// Test stand-in for @vscode/ripgrep: point at a real ripgrep on this machine.
import { existsSync } from "node:fs";

const candidates = [
  process.env.RG_PATH,
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg"
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

export const rgPath = candidates.find((candidate) => existsSync(candidate)) ?? "/usr/bin/rg";
