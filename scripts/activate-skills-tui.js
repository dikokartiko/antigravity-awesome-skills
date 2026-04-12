#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const readlinePromises = require("readline/promises");
const { execSync } = require("child_process");
const { stdin, stdout } = require("process");

const { findProjectRoot } = require("../tools/lib/project-root");
const {
  copyRecursiveSync,
  pruneRemovedEntries,
  readInstallManifest,
  writeInstallManifest,
} = require("../tools/bin/install.js");

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const PROJECT_ROOT = findProjectRoot(__dirname);
const DEFAULT_BUNDLES_PATH = path.join(
  PROJECT_ROOT,
  "data",
  "editorial-bundles.json",
);
const DEFAULT_SKILLS_INDEX_PATH = path.join(
  PROJECT_ROOT,
  "data",
  "skills_index.json",
);
const DEFAULT_SKILLS_SOURCE_DIR = path.join(PROJECT_ROOT, "skills");
const SKILL_ID_PATTERN =
  /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_SKILL_RESULTS = 30;

const INSTALL_MODES = [
  {
    id: "skill",
    label: "Skill satuan",
    note: "Cari dan pilih skill individual dari katalog.",
  },
  {
    id: "bundle",
    label: "Category / bundle",
    note: "Pilih category lalu bundle untuk install beberapa skill sekaligus.",
  },
];

const PATH_PATTERNS = [
  {
    id: "agents",
    label:
      "General path support Github Copilot / Codex / OpenCode project local",
    pattern: ".agents/skills",
    note: "Recommended for per-project installs.",
  },
  {
    id: "skills",
    label: "Plain skills folder",
    pattern: "skills",
    note: "Installs directly into <base>/skills.",
  },
  {
    id: "codex",
    label: "Codex-style folder under base",
    pattern: ".codex/skills",
    note: "Useful when you want a repo-local Codex layout.",
  },
  {
    id: "claude",
    label: "Claude-style folder under base",
    pattern: ".claude/skills",
    note: "Useful for repo-local Claude layouts.",
  },
  {
    id: "cursor",
    label: "Cursor-style folder under base",
    pattern: ".cursor/skills",
    note: "Useful for repo-local Cursor layouts.",
  },
  {
    id: "gemini",
    label: "Gemini-style folder under base",
    pattern: ".gemini/skills",
    note: "Useful for repo-local Gemini layouts.",
  },
  {
    id: "antigravity",
    label: "Antigravity-style folder under base",
    pattern: ".gemini/antigravity/skills",
    note: "Useful for repo-local Antigravity layouts.",
  },
  {
    id: "custom-relative",
    label: "Custom relative pattern",
    pattern: null,
    note: "You will type a custom relative suffix.",
  },
  {
    id: "exact-path",
    label: "Exact target path",
    pattern: null,
    note: "You will type the full final install path.",
  },
];

function expandHome(input) {
  if (!input) {
    return input;
  }
  if (!HOME) {
    return input;
  }
  return input.replace(/^~(?=$|\/)/, HOME);
}

function pickFolder(title = "Select folder") {
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const result = execSync(
        `osascript -e 'POSIX path of (choose folder with prompt "${escaped}")'`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      return result || null;
    }

    if (platform === "linux") {
      const escaped = title.replace(/"/g, '\\"');
      try {
        const result = execSync(
          `zenity --file-selection --directory --title="${escaped}" 2>/dev/null`,
          {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        ).trim();
        return result || null;
      } catch {
        try {
          const result = execSync(
            `kdialog --getexistingdirectory "${HOME}" --title "${escaped}" 2>/dev/null`,
            {
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"],
            },
          ).trim();
          return result || null;
        } catch {
          return null;
        }
      }
    }

    if (platform === "win32") {
      const escaped = title.replace(/'/g, "''");
      const psScript = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$d.Description = '${escaped}'`,
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }",
      ].join(";");
      const result = execSync(
        `powershell -NoProfile -NonInteractive -Command "${psScript}"`,
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ).trim();
      return result || null;
    }
  } catch {
    return null;
  }

  return null;
}

async function promptFolderPicker(
  rl,
  label,
  { fallbackDefault = process.cwd(), allowEmpty = false } = {},
) {
  stdout.write(`\n${label}\n`);
  stdout.write("  Opening folder explorer...\n");

  const picked = pickFolder(label);
  if (picked) {
    stdout.write(`  Selected: ${picked}\n`);
    return picked;
  }

  if (allowEmpty) {
    const answer = await rl.question(
      `  Explorer unavailable or canceled. Type path (blank for "${fallbackDefault}"): `,
    );
    return answer.trim();
  }

  return promptWithRetry(
    rl,
    "  Explorer unavailable or canceled. Type path manually: ",
    (answer) => {
      const trimmed = answer.trim();
      if (!trimmed) {
        throw new Error("Path is required.");
      }
      return trimmed;
    },
  );
}

function resolveUserPath(input, fallbackPath = process.cwd()) {
  const raw = (input || "").trim();
  if (!raw) {
    return path.resolve(fallbackPath);
  }
  return path.resolve(expandHome(raw));
}

function loadEditorialBundles(bundlesPath = DEFAULT_BUNDLES_PATH) {
  const payload = JSON.parse(fs.readFileSync(bundlesPath, "utf8"));
  if (!payload || !Array.isArray(payload.bundles)) {
    throw new Error(`Invalid bundle manifest: ${bundlesPath}`);
  }

  return payload.bundles
    .filter((bundle) => bundle && typeof bundle === "object")
    .map((bundle) => ({
      id: String(bundle.id || "").trim(),
      name: String(bundle.name || bundle.id || "").trim(),
      group: String(bundle.group || "Other").trim(),
      description: String(bundle.description || bundle.tagline || "").trim(),
      skills: Array.isArray(bundle.skills) ? bundle.skills : [],
    }))
    .filter((bundle) => bundle.id && bundle.name);
}

function loadSkillCatalog({
  skillsIndexPath = DEFAULT_SKILLS_INDEX_PATH,
  sourceSkillsDir = DEFAULT_SKILLS_SOURCE_DIR,
} = {}) {
  const payload = JSON.parse(fs.readFileSync(skillsIndexPath, "utf8"));
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid skills index: ${skillsIndexPath}`);
  }

  return payload
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || "").trim(),
      name: String(item.name || item.id || "").trim(),
      category: String(item.category || "uncategorized").trim(),
      description: String(item.description || "").trim(),
    }))
    .filter((item) => item.id && SKILL_ID_PATTERN.test(item.id))
    .filter((item) => fs.existsSync(path.join(sourceSkillsDir, item.id)))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function buildBundleGroups(bundles) {
  const groups = [];
  const byName = new Map();

  for (const bundle of bundles) {
    const groupName = bundle.group || "Other";
    if (!byName.has(groupName)) {
      const group = { name: groupName, bundles: [] };
      groups.push(group);
      byName.set(groupName, group);
    }
    byName.get(groupName).bundles.push(bundle);
  }

  return groups;
}

function normalizeSkillId(skill) {
  if (typeof skill === "string") {
    return skill.trim();
  }
  if (skill && typeof skill === "object" && typeof skill.id === "string") {
    return skill.id.trim();
  }
  return "";
}

function extractSkillIds(selectedBundles) {
  const skillIds = new Set();

  for (const bundle of selectedBundles) {
    for (const skill of bundle.skills) {
      const skillId = normalizeSkillId(skill);
      if (SKILL_ID_PATTERN.test(skillId)) {
        skillIds.add(skillId);
      }
    }
  }

  return Array.from(skillIds).sort();
}

function tokenizeQuery(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function scoreSkillMatch(skill, tokens) {
  const haystack = [skill.id, skill.name, skill.category, skill.description]
    .join(" ")
    .toLowerCase();
  let score = 0;

  for (const token of tokens) {
    if (!haystack.includes(token)) {
      return -1;
    }
    if (skill.id.toLowerCase() === token) {
      score += 100;
    } else if (skill.id.toLowerCase().startsWith(token)) {
      score += 50;
    } else if (skill.id.toLowerCase().includes(token)) {
      score += 25;
    } else if (skill.name.toLowerCase().includes(token)) {
      score += 15;
    } else if (skill.category.toLowerCase().includes(token)) {
      score += 10;
    } else {
      score += 5;
    }
  }

  return score;
}

function searchSkillCatalog(skillCatalog, query, limit = MAX_SKILL_RESULTS) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) {
    return skillCatalog.slice(0, limit);
  }

  return skillCatalog
    .map((skill) => ({ skill, score: scoreSkillMatch(skill, tokens) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.skill.id.localeCompare(right.skill.id),
    )
    .slice(0, limit)
    .map((entry) => entry.skill);
}

function formatCount(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function wrapText(
  text,
  {
    indent = "    ",
    width = Math.max(40, (stdout.columns || 100) - indent.length - 2),
  } = {},
) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [];
  }

  const words = normalized.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width && current) {
      lines.push(`${indent}${current}`);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) {
    lines.push(`${indent}${current}`);
  }

  return lines;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toggleIndex(selectedIndexes, index, allowMultiple) {
  const next = new Set(selectedIndexes);
  if (!allowMultiple) {
    next.clear();
    next.add(index);
    return next;
  }

  if (next.has(index)) {
    next.delete(index);
  } else {
    next.add(index);
  }
  return next;
}

function buildSelectorDetailLines(item) {
  const lines = [];
  if (item.description) {
    lines.push(...wrapText(item.description, { indent: "  " }));
  }
  if (Array.isArray(item.details)) {
    for (const detail of item.details) {
      lines.push(...wrapText(detail, { indent: "  " }));
    }
  }
  return lines;
}

function renderSelectorScreen({
  title,
  instructions,
  items,
  cursor,
  selectedIndexes,
  allowMultiple,
  statusMessage,
}) {
  const currentItem = items[cursor];
  const detailLines = currentItem ? buildSelectorDetailLines(currentItem) : [];
  const reservedLines = 8 + detailLines.length;
  const visibleCount = Math.max(4, (stdout.rows || 24) - reservedLines);
  const offset = clamp(
    cursor - Math.floor(visibleCount / 2),
    0,
    Math.max(0, items.length - visibleCount),
  );
  const end = Math.min(items.length, offset + visibleCount);

  stdout.write("\x1b[2J\x1b[H\x1b[?25l");
  stdout.write(`${title}\n`);
  stdout.write(`${instructions}\n\n`);

  for (let index = offset; index < end; index += 1) {
    const item = items[index];
    const active = index === cursor;
    const marker = allowMultiple
      ? `[${selectedIndexes.has(index) ? "x" : " "}]`
      : `(${selectedIndexes.has(index) ? "x" : " "})`;
    const pointer = active ? ">" : " ";
    stdout.write(`${pointer} ${marker} ${item.label}\n`);
  }

  if (end < items.length) {
    stdout.write(`  ... ${items.length - end} more items\n`);
  }

  stdout.write("\n");
  if (currentItem) {
    stdout.write("Details\n");
    if (detailLines.length > 0) {
      detailLines.forEach((line) => stdout.write(`${line}\n`));
    } else {
      stdout.write("  No extra details.\n");
    }
  }

  stdout.write("\n");
  stdout.write(`Selected: ${selectedIndexes.size}\n`);
  stdout.write(`${statusMessage || ""}\n`);
}

async function runCheckboxSelector(
  rl,
  {
    title,
    instructions,
    items,
    allowMultiple = true,
    defaultSelectedIndexes = [],
  },
) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No items available for selection.");
  }

  rl.pause();
  readline.emitKeypressEvents(stdin);

  const canUseRawMode = typeof stdin.setRawMode === "function";
  const previousRawMode = canUseRawMode ? stdin.isRaw : false;
  if (canUseRawMode) {
    stdin.setRawMode(true);
  }
  stdin.resume();

  let cursor = clamp(defaultSelectedIndexes[0] ?? 0, 0, items.length - 1);
  let selectedIndexes = new Set(
    defaultSelectedIndexes.filter(
      (index) => index >= 0 && index < items.length,
    ),
  );
  if (!allowMultiple && selectedIndexes.size === 0) {
    selectedIndexes.add(cursor);
  }
  let statusMessage = allowMultiple
    ? "Keys: ↑/↓ move, space toggle, a toggle all, enter confirm, q cancel"
    : "Keys: ↑/↓ move, space select, enter confirm, q cancel";

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off("keypress", onKeypress);
      if (canUseRawMode) {
        stdin.setRawMode(previousRawMode);
      }
      stdout.write("\x1b[?25h\x1b[2J\x1b[H");
      rl.resume();
    };

    const finish = (value) => {
      cleanup();
      resolve(value);
    };

    const fail = (error) => {
      cleanup();
      reject(error);
    };

    const rerender = () => {
      renderSelectorScreen({
        title,
        instructions,
        items,
        cursor,
        selectedIndexes,
        allowMultiple,
        statusMessage,
      });
    };

    const onKeypress = (_str, key = {}) => {
      if (key.ctrl && key.name === "c") {
        fail(new Error("Selection canceled."));
        return;
      }

      if (key.name === "q" || key.name === "escape") {
        fail(new Error("Selection canceled."));
        return;
      }

      if (key.name === "up" || key.name === "k") {
        cursor = clamp(cursor - 1, 0, items.length - 1);
        rerender();
        return;
      }

      if (key.name === "down" || key.name === "j") {
        cursor = clamp(cursor + 1, 0, items.length - 1);
        rerender();
        return;
      }

      if (key.name === "home") {
        cursor = 0;
        rerender();
        return;
      }

      if (key.name === "end") {
        cursor = items.length - 1;
        rerender();
        return;
      }

      if (key.name === "space") {
        selectedIndexes = toggleIndex(selectedIndexes, cursor, allowMultiple);
        if (!allowMultiple && selectedIndexes.size === 0) {
          selectedIndexes.add(cursor);
        }
        statusMessage = allowMultiple
          ? `Selected ${selectedIndexes.size} item(s)`
          : `Selected ${items[cursor].label}`;
        rerender();
        return;
      }

      if (allowMultiple && key.name === "a") {
        selectedIndexes =
          selectedIndexes.size === items.length
            ? new Set()
            : new Set(items.map((_item, index) => index));
        statusMessage = `Selected ${selectedIndexes.size} item(s)`;
        rerender();
        return;
      }

      if (key.name === "return") {
        if (selectedIndexes.size === 0) {
          statusMessage = "Select at least one item before continuing.";
          rerender();
          return;
        }
        finish(Array.from(selectedIndexes).sort((left, right) => left - right));
      }
    };

    stdin.on("keypress", onKeypress);
    rerender();
  });
}

function resolveInstallTarget({
  baseDir,
  patternChoice,
  customPattern,
  exactPath,
}) {
  if (patternChoice.id === "exact-path") {
    return resolveUserPath(exactPath, baseDir);
  }

  const resolvedBaseDir = resolveUserPath(baseDir);
  const pattern =
    patternChoice.id === "custom-relative"
      ? customPattern
      : patternChoice.pattern;
  if (!pattern || !pattern.trim()) {
    throw new Error("Pattern must not be empty.");
  }

  const normalizedPattern = pattern.trim();
  if (path.isAbsolute(expandHome(normalizedPattern))) {
    return path.resolve(expandHome(normalizedPattern));
  }

  return path.resolve(resolvedBaseDir, normalizedPattern);
}

function ensureTargetIsDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const stats = fs.lstatSync(targetPath);
  if (stats.isDirectory()) {
    return;
  }

  if (stats.isSymbolicLink()) {
    try {
      if (fs.statSync(targetPath).isDirectory()) {
        return;
      }
    } catch (error) {
      // Fall through to the error below.
    }
  }

  throw new Error(`Install path exists but is not a directory: ${targetPath}`);
}

function assertTargetSafe(targetPath, sourceSkillsDir) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedSource = path.resolve(sourceSkillsDir);
  const relative = path.relative(resolvedSource, resolvedTarget);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    throw new Error(
      `Refusing to install into ${resolvedTarget} because it is inside the repository source skills directory.`,
    );
  }
}

function installSelectedSkills({
  sourceSkillsDir = DEFAULT_SKILLS_SOURCE_DIR,
  targetPath,
  skillIds,
  manifestSelection = null,
  pruneManagedEntries = true,
}) {
  if (!Array.isArray(skillIds) || skillIds.length === 0) {
    throw new Error("No skills selected for installation.");
  }

  assertTargetSafe(targetPath, sourceSkillsDir);

  const missingSkills = skillIds.filter(
    (skillId) => !fs.existsSync(path.join(sourceSkillsDir, skillId)),
  );
  if (missingSkills.length > 0) {
    throw new Error(
      `Selected skills missing from local repo: ${missingSkills.join(", ")}`,
    );
  }

  ensureTargetIsDirectory(targetPath);
  fs.mkdirSync(targetPath, { recursive: true });

  const previousEntries = readInstallManifest(targetPath);
  if (pruneManagedEntries) {
    pruneRemovedEntries(targetPath, previousEntries, skillIds);
  }

  for (const skillId of skillIds) {
    const src = path.join(sourceSkillsDir, skillId);
    const dest = path.join(targetPath, skillId);
    copyRecursiveSync(src, dest, sourceSkillsDir);
  }

  writeInstallManifest(targetPath, skillIds, {
    selection: manifestSelection,
  });
}

async function promptWithRetry(rl, message, parser) {
  while (true) {
    const answer = await rl.question(message);
    try {
      return parser(answer);
    } catch (error) {
      stdout.write(`  ! ${error.message}\n`);
    }
  }
}

async function promptInstallMode(rl) {
  const selectedIndexes = await runCheckboxSelector(rl, {
    title: "Install Modes",
    instructions: "Choose one install mode.",
    items: INSTALL_MODES.map((mode) => ({
      label: mode.label,
      description: mode.note,
    })),
    allowMultiple: false,
    defaultSelectedIndexes: [0],
  });
  return INSTALL_MODES[selectedIndexes[0]];
}

async function promptBundleSelection(rl) {
  const bundles = loadEditorialBundles();
  const groups = buildBundleGroups(bundles);
  const defaultGroupIndex = Math.max(
    groups.findIndex((group) =>
      group.name.toLowerCase().includes("essentials"),
    ),
    0,
  );

  const selectedGroupIndexes = await runCheckboxSelector(rl, {
    title: "Categories",
    instructions: "Select one or more categories.",
    items: groups.map((group) => ({
      label: `${group.name} (${formatCount(group.bundles.length, "bundle")})`,
      description: `Bundles available: ${group.bundles.map((bundle) => bundle.name).join(", ")}`,
    })),
    allowMultiple: true,
    defaultSelectedIndexes: [defaultGroupIndex],
  });

  const candidateBundles = selectedGroupIndexes.flatMap(
    (index) => groups[index].bundles,
  );
  const defaultBundleIndex = Math.max(
    candidateBundles.findIndex(
      (bundle) => bundle.name.toLowerCase() === "essentials",
    ),
    0,
  );

  const selectedBundleIndexes = await runCheckboxSelector(rl, {
    title: "Bundles",
    instructions:
      "Select one or more bundles. Details show the skills inside the highlighted bundle.",
    items: candidateBundles.map((bundle) => ({
      label: `${bundle.name} [${bundle.group}] (${formatCount(extractSkillIds([bundle]).length, "skill")})`,
      description: bundle.description,
      details: [`skills: ${extractSkillIds([bundle]).join(", ")}`],
    })),
    allowMultiple: true,
    defaultSelectedIndexes: [defaultBundleIndex],
  });

  const selectedBundles = selectedBundleIndexes.map(
    (index) => candidateBundles[index],
  );
  const skillIds = extractSkillIds(selectedBundles);
  if (skillIds.length === 0) {
    throw new Error(
      "The selected bundles did not resolve to any installable skills.",
    );
  }

  stdout.write("\nSelected bundle skills\n");
  selectedBundles.forEach((bundle) => {
    stdout.write(`  ${bundle.name}\n`);
    stdout.write(`    ${extractSkillIds([bundle]).join(", ")}\n`);
  });

  return {
    selectionLabel: `Bundles : ${selectedBundles.map((bundle) => bundle.name).join(", ")}`,
    manifestSelection: {
      mode: "bundle",
      categories: selectedGroupIndexes.map((index) => groups[index].name),
      bundles: selectedBundles.map((bundle) => ({
        id: bundle.id,
        name: bundle.name,
        group: bundle.group,
      })),
    },
    skillIds,
  };
}

async function promptSingleSkillSelection(rl) {
  const skillCatalog = loadSkillCatalog();

  while (true) {
    const query = await rl.question(
      `\nSearch skill by id/name/category (blank = first ${MAX_SKILL_RESULTS} skills): `,
    );
    const results = searchSkillCatalog(skillCatalog, query, MAX_SKILL_RESULTS);
    if (results.length === 0) {
      stdout.write("  ! No matching skills. Try another keyword.\n");
      continue;
    }

    const selectedIndexes = await runCheckboxSelector(rl, {
      title: "Skills",
      instructions: "Select one or more skills from the current search result.",
      items: results.map((skill) => ({
        label: `${skill.id} [${skill.category}]`,
        description: skill.description || `Skill id: ${skill.id}`,
      })),
      allowMultiple: true,
      defaultSelectedIndexes: [0],
    });

    const selectedSkills = selectedIndexes.map((index) => results[index]);
    return {
      selectionLabel: `Skills  : ${selectedSkills.map((skill) => skill.id).join(", ")}`,
      manifestSelection: {
        mode: "skill",
        categories: Array.from(
          new Set(selectedSkills.map((skill) => skill.category)),
        ).sort(),
        bundles: [],
      },
      skillIds: Array.from(
        new Set(selectedSkills.map((skill) => skill.id)),
      ).sort(),
    };
  }
}

async function runTui() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("This script needs an interactive terminal.");
  }

  const rl = readlinePromises.createInterface({ input: stdin, output: stdout });

  try {
    stdout.write("\nAntigravity Skills TUI\n");
    stdout.write(
      "Select install mode, target folder, and path pattern for installation.\n\n",
    );

    const installMode = await promptInstallMode(rl);
    const selection =
      installMode.id === "skill"
        ? await promptSingleSkillSelection(rl)
        : await promptBundleSelection(rl);
    const { selectionLabel, skillIds, manifestSelection } = selection;

    const baseDir = await promptFolderPicker(
      rl,
      "Base folder for pattern resolution",
      {
        fallbackDefault: process.cwd(),
        allowEmpty: true,
      },
    );

    const patternIndexes = await runCheckboxSelector(rl, {
      title: "Path Patterns",
      instructions: "Choose target path pattern(s).",
      items: PATH_PATTERNS.map((patternChoice) => ({
        label: patternChoice.pattern
          ? `${patternChoice.label} -> ${patternChoice.pattern}`
          : patternChoice.label,
        description: patternChoice.note,
      })),
      allowMultiple: true,
      defaultSelectedIndexes: [0],
    });

    const targetPaths = [];
    for (const idx of patternIndexes) {
      const patternChoice = PATH_PATTERNS[idx];
      let customPattern = "";
      let exactPath = "";

      if (patternChoice.id === "custom-relative") {
        customPattern = await promptWithRetry(
          rl,
          `Custom relative pattern for "${patternChoice.label}" (example: .agents/skills): `,
          (answer) => {
            const trimmed = answer.trim();
            if (!trimmed) {
              throw new Error("Pattern is required.");
            }
            return trimmed;
          },
        );
      } else if (patternChoice.id === "exact-path") {
        exactPath = await promptFolderPicker(rl, `Exact target path for "${patternChoice.label}"`, {
          fallbackDefault: process.cwd(),
          allowEmpty: false,
        });
      }

      targetPaths.push(
        resolveInstallTarget({ baseDir, patternChoice, customPattern, exactPath }),
      );
    }

    const pruneManagedEntries = await promptWithRetry(
      rl,
      "\nSync only the selected skills and prune stale managed entries? [Y/n]: ",
      (answer) => {
        const normalized = answer.trim().toLowerCase();
        if (!normalized || normalized === "y" || normalized === "yes") {
          return true;
        }
        if (normalized === "n" || normalized === "no") {
          return false;
        }
        throw new Error('Answer with "y" or "n".');
      },
    );

    stdout.write("\nSummary\n");
    stdout.write(`  Mode    : ${installMode.label}\n`);
    stdout.write(`  ${selectionLabel}\n`);
    stdout.write(`  Skills  : ${skillIds.length}\n`);
    stdout.write(`  Base    : ${resolveUserPath(baseDir)}\n`);
    for (const tp of targetPaths) {
      stdout.write(`  Target  : ${tp}\n`);
    }
    stdout.write(
      `  Sync    : ${pruneManagedEntries ? "sync selected skills" : "append without pruning"}\n`,
    );

    const confirmed = await promptWithRetry(
      rl,
      "\nProceed with installation? [Y/n]: ",
      (answer) => {
        const normalized = answer.trim().toLowerCase();
        if (!normalized || normalized === "y" || normalized === "yes") {
          return true;
        }
        if (normalized === "n" || normalized === "no") {
          return false;
        }
        throw new Error('Answer with "y" or "n".');
      },
    );

    if (!confirmed) {
      stdout.write("\nInstallation canceled.\n");
      return;
    }

    for (const tp of targetPaths) {
      installSelectedSkills({
        targetPath: tp,
        skillIds,
        manifestSelection,
        pruneManagedEntries,
      });
      stdout.write(`\nInstalled ${skillIds.length} skills into ${tp}\n`);
    }
    stdout.write("Done.\n");
  } finally {
    rl.close();
  }
}

function main() {
  runTui().catch((error) => {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  INSTALL_MODES,
  PATH_PATTERNS,
  buildBundleGroups,
  extractSkillIds,
  installSelectedSkills,
  loadEditorialBundles,
  loadSkillCatalog,
  resolveInstallTarget,
  resolveUserPath,
  searchSkillCatalog,
};
