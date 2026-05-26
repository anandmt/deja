#!/usr/bin/env node
"use strict";

const { execSync, execFileSync, spawn } = require("child_process");
const { existsSync } = require("fs");
const { join } = require("path");

const MIN_VER = [1, 3, 6];

function meetsMinVersion(str) {
  const m = str.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const parts = [+m[1], +m[2], +m[3]];
  for (let i = 0; i < 3; i++) {
    if (parts[i] > MIN_VER[i]) return true;
    if (parts[i] < MIN_VER[i]) return false;
  }
  return true;
}

function tryBun(cmd, args) {
  try {
    const ver = (args
      ? execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 })
      : execSync(cmd, { encoding: "utf8", timeout: 5000 })
    ).trim();
    return meetsMinVersion(ver) ? cmd : null;
  } catch {
    return null;
  }
}

function findBun() {
  const fromPath = tryBun("bun --version");
  if (fromPath) return "bun";

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const homeBun = join(home, ".bun", "bin", "bun");
  if (existsSync(homeBun)) {
    const found = tryBun(homeBun, ["--version"]);
    if (found) return homeBun;
  }

  return null;
}

function installBun() {
  if (process.platform === "win32") {
    console.error(
      "deja requires Bun >= 1.3.6\n" +
      "Install it: https://bun.sh/docs/installation"
    );
    process.exit(1);
  }

  console.log("deja requires Bun runtime. Installing...\n");
  try {
    execSync("curl -fsSL https://bun.sh/install | bash", {
      stdio: "inherit",
      timeout: 120000,
    });
    console.log();
  } catch {
    console.error("Failed to install Bun. Install manually: https://bun.sh");
    process.exit(1);
  }
}

function main() {
  let bunPath = findBun();

  if (!bunPath) {
    installBun();
    const home = process.env.HOME || "";
    const homeBun = join(home, ".bun", "bin", "bun");
    if (existsSync(homeBun)) {
      bunPath = homeBun;
    } else {
      bunPath = tryBun("bun --version") ? "bun" : null;
    }
    if (!bunPath) {
      console.error("Bun installed but not found. Restart your shell and try again.");
      process.exit(1);
    }
  }

  const cliMain = join(__dirname, "..", "dist", "cli", "main.js");
  const home = process.env.HOME || "";
  const bunBinDir = join(home, ".bun", "bin");

  const child = spawn(bunPath, ["run", cliMain, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: bunBinDir + ":" + (process.env.PATH || ""),
    },
  });

  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", (err) => {
    console.error("Failed to run deja:", err.message);
    process.exit(1);
  });
}

main();
