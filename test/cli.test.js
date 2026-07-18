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

  it("hands an interactive result to the saved scan and ShipBond workflow", () => {
    const output = formatReport(
      { ...report, scanId: 42 },
      gateReport(report, { failOn: "high", minScore: null }),
      { baseUrl: "https://codecordon.example/" },
    );
    assert.match(output, /create ShipBond launch evidence/);
    assert.match(
      output,
      /https:\/\/codecordon\.example\/scans\/42\?utm_source=codecordon_cli&utm_medium=product&utm_campaign=scan_to_shipbond/,
    );
  });

  it("hands a free result to its 24-hour preview", () => {
    const previewUrl = "https://codecordon.example/preview/token?utm_source=codecordon_cli";
    const output = formatReport(
      { ...report, previewUrl },
      gateReport(report, { failOn: "high", minScore: null }),
    );
    assert.match(output, /inspect the 24-hour preview/);
    assert.match(output, /create an account to save scans and build ShipBond evidence/);
    assert.match(output, new RegExp(previewUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("free public GitHub preview", () => {
  it("scans interactively without login or an API key", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codecordon-free-preview-"));
    const configPath = path.join(root, "config.json");
    const previewUrl = "https://codecordon.example/preview/token?utm_source=codecordon_cli";
    let request;
    let opened = 0;
    let prompted = 0;
    const output = [];
    const response = {
      ok: true,
      status: 201,
      json: async () => ({
        project: "owner/repo",
        previewUrl,
        grade: "A",
        score: 100,
        filesScanned: 1,
        summary: { critical: 0, high: 0, medium: 0, low: 0 },
        findings: [],
      }),
    };
    const originalLog = console.log;
    console.log = (value) => output.push(value);
    try {
      const exitCode = await main(["scan", "https://github.com/owner/repo"], {
        env: {},
        interactive: true,
        configPath,
        openUrl: async () => { opened += 1; },
        promptApiKey: async () => { prompted += 1; return ""; },
        fetch: async (url, init) => { request = { url, init }; return response; },
      });
      assert.equal(exitCode, 0);
      assert.equal(opened, 0);
      assert.equal(prompted, 0);
      assert.match(request.url, /\/api\/v1\/public-scans$/);
      assert.equal(request.init.headers["X-Api-Key"], undefined);
      assert.equal(request.init.headers["X-CodeCordon-Client"], "cli/0.3.0");
      assert.equal(request.init.headers["X-CodeCordon-Channel"], "cli");
      assert.equal(request.init.body.get("github_url"), "https://github.com/owner/repo");
      assert.match(output.join("\n"), /preview\/token/);
    } finally {
      console.log = originalLog;
    }
  });

  it("keeps keyless non-interactive scans blocked", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codecordon-no-key-"));
    const configPath = path.join(root, "config.json");
    let fetched = false;
    const errors = [];
    const originalError = console.error;
    console.error = (value) => errors.push(value);
    try {
      const exitCode = await main(["scan", "https://github.com/owner/repo"], {
        env: { CI: "true" },
        interactive: false,
        configPath,
        fetch: async () => { fetched = true; throw new Error("should not fetch"); },
      });
      assert.equal(exitCode, 2);
      assert.equal(fetched, false);
      assert.match(errors.join("\n"), /Pro API key for local and non-interactive scans/);
    } finally {
      console.error = originalError;
    }
  });

  it("does not treat an injected interactive CI run as a free preview", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codecordon-ci-no-key-"));
    const errors = [];
    const originalError = console.error;
    console.error = (value) => errors.push(value);
    try {
      const exitCode = await main(["scan", "https://github.com/owner/repo"], {
        env: { CI: "true", GITHUB_ACTIONS: "true" },
        interactive: true,
        configPath: path.join(root, "config.json"),
        fetch: async () => { throw new Error("should not fetch"); },
      });
      assert.equal(exitCode, 2);
      assert.match(errors.join("\n"), /Pro API key/);
    } finally {
      console.error = originalError;
    }
  });

  it("uses the paid endpoint when a GitHub scan has a stored key", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codecordon-stored-key-"));
    const configPath = path.join(root, "config.json");
    saveApiKey("cc_storedkey123", configPath);
    let request;
    const response = {
      ok: true,
      status: 201,
      json: async () => ({
        scanId: 11,
        project: "owner/repo",
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
      const exitCode = await main(["scan", "https://github.com/owner/repo"], {
        env: {},
        interactive: true,
        configPath,
        fetch: async (url, init) => { request = { url, init }; return response; },
      });
      assert.equal(exitCode, 0);
      assert.match(request.url, /\/api\/v1\/scans$/);
      assert.equal(request.init.headers["X-Api-Key"], "cc_storedkey123");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("machine-readable output", () => {
  it("does not add conversion copy to JSON output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codecordon-json-"));
    writeFileSync(path.join(root, "package.json"), "{}");
    const response = {
      ok: true,
      status: 201,
      json: async () => ({
        scanId: 42,
        project: "json-scan",
        grade: "A",
        score: 100,
        filesScanned: 1,
        summary: { critical: 0, high: 0, medium: 0, low: 0 },
        findings: [],
      }),
    };
    const output = [];
    const originalLog = console.log;
    console.log = (value) => output.push(value);
    try {
      const exitCode = await main(["scan", root, "--api-key", "test-key", "--json"], {
        fetch: async () => response,
      });
      assert.equal(exitCode, 0);
      assert.equal(output.length, 1);
      const parsed = JSON.parse(output[0]);
      assert.equal(parsed.scanId, 42);
      assert.doesNotMatch(output[0], /ShipBond|utm_campaign/);
    } finally {
      console.log = originalLog;
    }
  });
});

describe("acquisition attribution", () => {
  it("marks successful GitHub Actions scans without exposing the key", async () => {
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
        { env: { GITHUB_ACTIONS: "true" }, fetch: async (_url, init) => { capturedHeaders = init.headers; return response; } }
      );
      assert.equal(exitCode, 0);
      assert.equal(capturedHeaders["X-CodeCordon-Channel"], "github_action");
      assert.match(capturedHeaders["X-CodeCordon-Client"], /^cli\//);
    } finally {
      console.log = originalLog;
    }
  });
});
