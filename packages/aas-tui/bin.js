#!/usr/bin/env node

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO = "https://github.com/sickn33/antigravity-awesome-skills.git";
const CACHE_DIR = path.join(os.homedir(), ".aas-tui", "cache");
const REPO_DIR = path.join(CACHE_DIR, "antigravity-awesome-skills");

function ensureRepo() {
  if (fs.existsSync(path.join(REPO_DIR, ".git"))) {
    try {
      execSync("git pull --ff-only", { cwd: REPO_DIR, stdio: "pipe" });
    } catch {
      // offline or conflict — use cached version
    }
    return;
  }
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log("Cloning skill catalog (first run only)...");
  execSync(`git clone --depth 1 ${REPO} "${REPO_DIR}"`, { stdio: "inherit" });
}

function run() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("aas-tui requires an interactive terminal.");
    process.exit(1);
  }

  ensureRepo();

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_DIR, "scripts", "activate-skills-tui.js")],
    { stdio: "inherit", cwd: REPO_DIR },
  );
  process.exit(result.status ?? 1);
}

run();
