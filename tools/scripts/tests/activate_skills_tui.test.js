const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tuiInstaller = require(path.resolve(__dirname, "..", "..", "..", "scripts", "activate-skills-tui.js"));

function makeSkill(sourceRoot, skillId) {
  const skillDir = path.join(sourceRoot, skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${skillId}\n`, "utf8");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "activate-skills-tui-"));

try {
  const sourceSkillsDir = path.join(root, "repo-skills");
  const targetDir = path.join(root, "workspace", ".agents", "skills");
  fs.mkdirSync(sourceSkillsDir, { recursive: true });

  makeSkill(sourceSkillsDir, "concise-planning");
  makeSkill(sourceSkillsDir, "lint-and-validate");

  const searchResults = tuiInstaller.searchSkillCatalog(
    [
      {
        id: "concise-planning",
        name: "concise-planning",
        category: "planning",
        description: "Plan work clearly.",
      },
      {
        id: "lint-and-validate",
        name: "lint-and-validate",
        category: "quality",
        description: "Run validation tasks.",
      },
    ],
    "lint",
  );
  assert.deepStrictEqual(
    searchResults.map((skill) => skill.id),
    ["lint-and-validate"],
    "single-skill mode should support keyword search before selection",
  );

  assert.strictEqual(
    tuiInstaller.resolveInstallTarget({
      baseDir: path.join(root, "workspace"),
      patternChoice: tuiInstaller.PATH_PATTERNS[0],
      customPattern: "",
      exactPath: "",
    }),
    targetDir,
    "project-local .agents/skills pattern should resolve under the chosen base folder",
  );

  tuiInstaller.installSelectedSkills({
    sourceSkillsDir,
    targetPath: targetDir,
    skillIds: ["concise-planning", "lint-and-validate"],
    manifestSelection: {
      mode: "bundle",
      categories: ["Essentials & Core"],
      bundles: [
        {
          id: "essentials",
          name: "Essentials",
          group: "Essentials & Core",
        },
      ],
    },
    pruneManagedEntries: true,
  });

  assert.ok(fs.existsSync(path.join(targetDir, "concise-planning", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(targetDir, "lint-and-validate", "SKILL.md")));

  tuiInstaller.installSelectedSkills({
    sourceSkillsDir,
    targetPath: targetDir,
    skillIds: ["concise-planning"],
    manifestSelection: {
      mode: "skill",
      categories: ["planning"],
      bundles: [],
    },
    pruneManagedEntries: true,
  });

  assert.ok(fs.existsSync(path.join(targetDir, "concise-planning", "SKILL.md")));
  assert.strictEqual(
    fs.existsSync(path.join(targetDir, "lint-and-validate")),
    false,
    "sync mode should prune stale managed skills from previous TUI installs",
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(targetDir, ".antigravity-install-manifest.json"), "utf8"),
  );
  assert.deepStrictEqual(manifest.entries, ["concise-planning"]);
  assert.deepStrictEqual(manifest.selection, {
    mode: "skill",
    categories: ["planning"],
    bundles: [],
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
