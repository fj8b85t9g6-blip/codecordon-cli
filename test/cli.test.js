import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  buildArchive,
  formatReport,
  gateReport,
  loadApiKey,
  main,
  normalizeTargetInput,
  parseArgs,
  saveApiKey,
} from "../src/cli.js";

describe("arguments", () => {
  it("uses environment defaults and validates gates", () => {
    const parsed = parseArgs(["scan", ".", "--fail-on", "high", "--min-score", "80", "--json"]);
    assert.equal(parsed.command, "scan");
    assert.equal(parsed.target, ".");
    assert.equal(parsed.targetProvided, true);
    assert.equal(parsed.failOn, "high");
    assert.equal(parsed.minScore, 80);
    assert.equal(parsed.format, "json");
    assert.throws(() => parseArgs(["--fail-on", "urgent"]), /must be/);
  });

  it("keeps the old path-first syntax and accepts drag-and-drop paths", () => {
    assert.equal(parseArgs(["."]).command, "scan");
    assert.equal(normalizeTargetInput("'/tmp/My Project'"), "/tmp/My Project");
    assert.equal(normalizeTargetInput("/tmp/My\\ Project"), "/tmp/My Project");
  });
});

describe("first-time setup", () => {
  it("stores the API key in a private config for later scans", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codecordon-config-"));
    const configPath = path.join(root, "config.json");
    saveApiKey("cc_testkey123", configPath);
    assert.equal(loadApiKey(configPath), "cc_testkey123");
  });

  it("finishes setup and scans from one command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codecordon-first-scan-"));
    const configPath = path.join(root, "config.json");
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(path.join(root, "app.js"), "export const ok = true;");
    const response = {
      ok: true,
      status: 201,
      json: async () => ({
        project: "first-scan",
        grade: "A",
        score: 100,
        filesScanned: 2,
        summary: { critical: 0, high: 0, medium: 0, low: 0 },
        findings: [],
      }),
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      const exitCode = await main(["scan", root], {
        env: {},
        interactive: true,
        configPath,
        openUrl: async () => {},
        promptApiKey: async () => "cc_firstscan123",
        fetch: async () => response,
      });
      assert.equal(exitCode, 0);
      assert.equal(loadApiKey(configPath), "cc_firstscan123");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("archive", () => {
  it("includes source and excludes dependencies, builds, and binary assets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codecordon-cli-"));
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "node_modules"));
    writeFileSync(path.join(root, "src", "app.ts"), "export const ok = true;");
    writeFileSync(path.join(root, ".env"), "TOKEN=real-looking-value");
    writeFileSync(path.join(root, "node_modules", "bad.js"), "eval(userInput)");
    writeFileSync(path.join(root, "photo.png"), Buffer.from([0, 1, 2]));

    const { buffer, files } = buildArchive(root);
    const entries = new AdmZip(buffer).getEntries().map((entry) => entry.entryName).sort();
    assert.equal(files, 2);
    assert.deepEqual(entries, [".env", "src/app.ts"]);
  });
});

describe("gate", () => {
  const report = {
    project: "demo",
    grade: "C",
    score: 64,
    filesScanned: 12,
    summary: { critical: 0, high: 2, medium: 1, low: 0 },
    findings: [{ severity: "high", ruleId: "AUTH001", file: "api.ts", line: 4, title: "Missing auth" }],
  };

  it("fails at the configured severity and score", () => {
    assert.equal(gateReport(report, { failOn: "critical", minScore: null }).passed, true);
    assert.equal(gateReport(report, { failOn: "high", minScore: null }).passed, false);
    assert.equal(gateReport(report, { failOn: "none", minScore: 80 }).passed, false);
  });

  it("prints an honest readable summary", () => {
    const output = formatReport(report, gateReport(report, { failOn: "high", minScore: null }));
    assert.match(output, /Grade C/);
    assert.match(output, /AUTH001 api\.ts:4/);
    assert.match(output, /not a security certification/);
  });
});

describe("acquisition attribution", () => {
  it("marks successful GitHub Actions scans without exposing the key", async () => {
    const previous = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "true";
    let capturedHeaders;
    const response = {
      ok: true,
      status: 201,
      json: async () => ({
        project: "demo",
        grade: "A",
        score: 100,
        filesScanned: 1,
        summary: { critical: 0, high: 0, medium: 0, low: 0 },
        findings: [],
      }),
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      const exitCode = await main(
        ["https://github.com/owner/repo", "--api-key", "test-key"],
        { fetch: async (_url, init) => { capturedHeaders = init.headers; return response; } }
      );
      assert.equal(exitCode, 0);
      assert.equal(capturedHeaders["X-CodeCordon-Channel"], "github_action");
      assert.match(capturedHeaders["X-CodeCordon-Client"], /^cli\//);
    } finally {
      console.log = originalLog;
      if (previous === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = previous;
    }
  });
});
