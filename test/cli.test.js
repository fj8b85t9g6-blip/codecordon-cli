import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { buildArchive, formatReport, gateReport, parseArgs } from "../src/cli.js";

describe("arguments", () => {
  it("uses environment defaults and validates gates", () => {
    const parsed = parseArgs([".", "--fail-on", "high", "--min-score", "80", "--json"]);
    assert.equal(parsed.target, ".");
    assert.equal(parsed.failOn, "high");
    assert.equal(parsed.minScore, 80);
    assert.equal(parsed.format, "json");
    assert.throws(() => parseArgs(["--fail-on", "urgent"]), /must be/);
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
