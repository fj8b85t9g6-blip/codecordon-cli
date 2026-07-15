import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const DEFAULT_URL = "https://codecordon.up.railway.app";
const CLI_VERSION = "0.1.1";
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 5000;
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const SCANNABLE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".dart", ".ex", ".exs", ".fs", ".fsx",
  ".go", ".gradle", ".graphql", ".h", ".hcl", ".hpp", ".html", ".java",
  ".js", ".json", ".jsx", ".kt", ".kts", ".lua", ".mjs", ".php", ".pl",
  ".prisma", ".properties", ".py", ".rb", ".rs", ".scala", ".sh", ".sql",
  ".svelte", ".swift", ".tf", ".toml", ".ts", ".tsx", ".vue", ".xml",
  ".yaml", ".yml",
]);
const IGNORED_DIRS = new Set([
  ".git", ".next", ".turbo", ".venv", "DerivedData", "Pods", "__pycache__",
  "build", "coverage", "dist", "node_modules", "out", "target", "vendor", "venv",
]);

export function parseArgs(argv) {
  const options = {
    target: ".",
    apiKey: process.env.CODECORDON_API_KEY ?? "",
    baseUrl: process.env.CODECORDON_URL ?? DEFAULT_URL,
    name: "",
    format: "pretty",
    failOn: "critical",
    minScore: null,
    help: false,
    version: false,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--json") options.format = "json";
    else if (arg === "--api-key") options.apiKey = requiredValue(argv, ++i, arg);
    else if (arg === "--url") options.baseUrl = requiredValue(argv, ++i, arg);
    else if (arg === "--name") options.name = requiredValue(argv, ++i, arg);
    else if (arg === "--format") options.format = requiredValue(argv, ++i, arg);
    else if (arg === "--fail-on") options.failOn = requiredValue(argv, ++i, arg);
    else if (arg === "--min-score") options.minScore = Number(requiredValue(argv, ++i, arg));
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }

  if (positionals.length > 1) throw new Error("Provide one local path or public GitHub URL.");
  if (positionals[0]) options.target = positionals[0];
  if (!new Set(["pretty", "json"]).has(options.format)) throw new Error("--format must be pretty or json.");
  if (![...SEVERITY_ORDER, "none"].includes(options.failOn)) {
    throw new Error("--fail-on must be critical, high, medium, low, or none.");
  }
  if (options.minScore !== null && (!Number.isFinite(options.minScore) || options.minScore < 0 || options.minScore > 100)) {
    throw new Error("--min-score must be between 0 and 100.");
  }
  return options;
}

export function buildArchive(target) {
  const root = path.resolve(target);
  const stat = lstatSync(root);
  if (!stat.isDirectory()) throw new Error("Local scan target must be a directory.");

  const zip = new AdmZip();
  const state = { files: 0, bytes: 0 };
  addDirectory(zip, root, root, state);
  if (state.files === 0) throw new Error("No scannable source files found.");
  const buffer = zip.toBuffer();
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error("Compressed source archive exceeds 50MB.");
  return { buffer, files: state.files };
}

export function gateReport(report, { failOn, minScore }) {
  const reasons = [];
  if (failOn !== "none") {
    const cutoff = SEVERITY_ORDER.indexOf(failOn);
    const failing = SEVERITY_ORDER.slice(0, cutoff + 1).filter((severity) => Number(report.summary?.[severity] ?? 0) > 0);
    if (failing.length > 0) reasons.push(`found ${failing.join("/")} severity issues`);
  }
  if (minScore !== null && Number(report.score) < minScore) reasons.push(`score ${report.score} is below ${minScore}`);
  return { passed: reasons.length === 0, reasons };
}

export function formatReport(report, gate) {
  const counts = report.summary ?? {};
  const lines = [
    `CodeCordon: ${report.project ?? "project"}`,
    `Grade ${report.grade} | ${report.score}/100 | ${report.filesScanned} files`,
    `${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.medium ?? 0} medium, ${counts.low ?? 0} low`,
  ];
  for (const finding of (report.findings ?? []).slice(0, 20)) {
    lines.push(`[${String(finding.severity).toUpperCase()}] ${finding.ruleId} ${finding.file}:${finding.line} - ${finding.title}`);
  }
  if ((report.findings?.length ?? 0) > 20) lines.push(`...and ${report.findings.length - 20} more findings`);
  lines.push(gate.passed ? "Gate: PASS" : `Gate: FAIL (${gate.reasons.join("; ")})`);
  lines.push("A passing scan means no configured known-pattern gate failed; it is not a security certification.");
  return lines.join("\n");
}

export async function main(argv, dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run codecordon --help for usage.");
    return 2;
  }

  if (options.help) {
    console.log(helpText());
    return 0;
  }
  if (options.version) {
    console.log(CLI_VERSION);
    return 0;
  }
  if (!options.apiKey) {
    console.error("Set CODECORDON_API_KEY or pass --api-key. Create an API key in CodeCordon Settings.");
    return 2;
  }

  const githubUrl = parseGithubTarget(options.target);
  const projectName = options.name || inferProjectName(options.target, githubUrl);
  const form = new FormData();
  form.set("name", projectName);
  if (githubUrl) {
    form.set("github_url", githubUrl);
  } else {
    let archive;
    try {
      archive = buildArchive(options.target);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
    form.set("zip", new Blob([archive.buffer], { type: "application/zip" }), `${projectName}.zip`);
  }

  const fetchImpl = dependencies.fetch ?? fetch;
  let response;
  try {
    response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/api/v1/scans`, {
      method: "POST",
      headers: {
        "X-Api-Key": options.apiKey,
        "X-CodeCordon-Client": `cli/${CLI_VERSION}`,
        "X-CodeCordon-Channel": process.env.CODECORDON_CHANNEL === "github_action" || process.env.GITHUB_ACTIONS === "true"
          ? "github_action"
          : "cli",
      },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.error(`Could not reach CodeCordon: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    console.error(`CodeCordon API error (${response.status}): ${payload.error ?? "request failed"}`);
    return 2;
  }
  const gate = gateReport(payload, options);
  console.log(options.format === "json" ? JSON.stringify({ ...payload, gate }, null, 2) : formatReport(payload, gate));
  return gate.passed ? 0 : 1;
}

function addDirectory(zip, root, current, state) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      addDirectory(zip, root, fullPath, state);
      continue;
    }
    if (!entry.isFile() || !isScannable(entry.name)) continue;
    const data = readFileSync(fullPath);
    if (data.length > 512 * 1024) continue;
    state.files += 1;
    state.bytes += data.length;
    if (state.files > MAX_FILES || state.bytes > MAX_ARCHIVE_BYTES) throw new Error("Source exceeds the 5,000-file or 50MB scan limit.");
    zip.addFile(path.relative(root, fullPath).split(path.sep).join("/"), data);
  }
}

function isScannable(filename) {
  const lower = filename.toLowerCase();
  if (lower === ".gitignore" || lower === "dockerfile" || lower.endsWith(".rules")) return true;
  if (lower === ".env" || lower.startsWith(".env.")) return !lower.includes("example");
  if (lower.endsWith(".lock") || lower.endsWith(".min.js")) return false;
  return SCANNABLE_EXTENSIONS.has(path.extname(lower));
}

function parseGithubTarget(target) {
  return /^(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?(?:\/tree\/[\w./-]+)?\/?$/i.test(target) ? target : null;
}

function inferProjectName(target, githubUrl) {
  if (githubUrl) return githubUrl.replace(/\/$/, "").split("/").at(-1).replace(/\.git$/, "");
  return path.basename(path.resolve(target));
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
  return value;
}

function helpText() {
  return `CodeCordon CLI\n\nUsage:\n  codecordon [path|github-url] [options]\n\nOptions:\n  --name <name>             Project name shown in CodeCordon\n  --api-key <key>           API key (prefer CODECORDON_API_KEY)\n  --url <url>               API base URL (default: ${DEFAULT_URL})\n  --fail-on <severity>      critical, high, medium, low, or none\n  --min-score <0-100>       Also fail below this score\n  --format <pretty|json>    Output format\n  --json                    Shortcut for --format json\n  -h, --help                Show help\n  -v, --version             Show version\n\nExamples:\n  CODECORDON_API_KEY=cc_live_... npx codecordon .\n  npx codecordon https://github.com/owner/repo --fail-on high\n  npx codecordon . --json --min-score 80`;
}
