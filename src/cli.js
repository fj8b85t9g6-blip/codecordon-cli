import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import AdmZip from "adm-zip";

const DEFAULT_URL = "https://codecordon.up.railway.app";
const CLI_VERSION = "0.2.1";
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

const COMMANDS = new Set(["scan", "login", "logout"]);
const PROJECT_MARKERS = new Set([
  ".git", "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml",
  "go.mod", "Package.swift", "Gemfile", "composer.json", "pom.xml", "build.gradle",
]);

export function parseArgs(argv, env = process.env) {
  const args = [...argv];
  const command = COMMANDS.has(args[0]) ? args.shift() : "scan";
  const options = {
    command,
    target: ".",
    targetProvided: false,
    apiKey: env.CODECORDON_API_KEY ?? "",
    baseUrl: env.CODECORDON_URL ?? DEFAULT_URL,
    name: "",
    format: "pretty",
    failOn: "critical",
    minScore: null,
    help: false,
    version: false,
  };
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--json") options.format = "json";
    else if (arg === "--api-key") options.apiKey = requiredValue(args, ++i, arg);
    else if (arg === "--url") options.baseUrl = requiredValue(args, ++i, arg);
    else if (arg === "--name") options.name = requiredValue(args, ++i, arg);
    else if (arg === "--format") options.format = requiredValue(args, ++i, arg);
    else if (arg === "--fail-on") options.failOn = requiredValue(args, ++i, arg);
    else if (arg === "--min-score") options.minScore = Number(requiredValue(args, ++i, arg));
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }

  if (command !== "scan" && positionals.length > 0) throw new Error(`${command} does not accept a scan target.`);
  if (positionals.length > 1) throw new Error("Provide one local path or public GitHub URL.");
  if (positionals[0]) {
    options.target = normalizeTargetInput(positionals[0]);
    options.targetProvided = true;
  }
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

export function formatReport(report, gate, { baseUrl = DEFAULT_URL } = {}) {
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
  if (Number.isSafeInteger(Number(report.scanId)) && Number(report.scanId) > 0) {
    const scanUrl = `${baseUrl.replace(/\/$/, "")}/scans/${Number(report.scanId)}?utm_source=codecordon_cli&utm_medium=product&utm_campaign=scan_to_shipbond`;
    lines.push("Next: open the saved scan, verify the live deployment, and create ShipBond launch evidence:");
    lines.push(scanUrl);
  }
  return lines.join("\n");
}

export async function main(argv, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  let options;
  try {
    options = parseArgs(argv, env);
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

  const configPath = dependencies.configPath ?? getConfigPath(env);
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.CI);

  if (options.command === "logout") {
    removeStoredApiKey(configPath);
    console.log("CodeCordon login removed from this computer.");
    return 0;
  }

  if (options.command === "login") {
    const apiKey = options.apiKey || await runFirstTimeLogin(options, { ...dependencies, configPath, interactive });
    if (!apiKey) return 2;
    if (options.apiKey) saveApiKey(apiKey, configPath);
    console.log("CodeCordon is ready. Run: npx --yes codecordon@latest scan");
    return 0;
  }

  if (!options.targetProvided && interactive && !looksLikeProject(process.cwd())) {
    const promptTarget = dependencies.promptTarget ?? promptForTarget;
    const answer = normalizeTargetInput(await promptTarget());
    if (answer) options.target = answer;
  }

  if (!options.apiKey) options.apiKey = loadApiKey(configPath);
  if (!options.apiKey && interactive) {
    options.apiKey = await runFirstTimeLogin(options, { ...dependencies, configPath, interactive });
  }
  if (!options.apiKey) {
    console.error("CodeCordon needs a Pro API key. Run `npx --yes codecordon@latest login` once, or set CODECORDON_API_KEY in CI.");
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
    if (response.status === 401) {
      console.error("Run `npx --yes codecordon@latest login` to replace the saved key.");
    }
    return 2;
  }
  const gate = gateReport(payload, options);
  console.log(options.format === "json"
    ? JSON.stringify({ ...payload, gate }, null, 2)
    : formatReport(payload, gate, { baseUrl: options.baseUrl }));
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

export function getConfigPath(env = process.env, home = homedir()) {
  const configRoot = env.CODECORDON_CONFIG_DIR || env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configRoot, "codecordon", "config.json");
}

export function loadApiKey(configPath) {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof config.apiKey === "string" ? config.apiKey : "";
  } catch {
    return "";
  }
}

export function saveApiKey(apiKey, configPath) {
  if (!/^(?:cc|vg)_[a-zA-Z0-9]+$/.test(apiKey)) {
    throw new Error("That does not look like a CodeCordon API key.");
  }
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify({ apiKey }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

export function removeStoredApiKey(configPath) {
  rmSync(configPath, { force: true });
}

export function normalizeTargetInput(value) {
  let result = String(value ?? "").trim();
  if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'"))) {
    result = result.slice(1, -1);
  }
  result = result.replace(/\\ /g, " ");
  if (result === "~") return homedir();
  if (result.startsWith("~/")) return path.join(homedir(), result.slice(2));
  return result;
}

export function looksLikeProject(target) {
  try {
    if (!lstatSync(target).isDirectory()) return false;
    return readdirSync(target, { withFileTypes: true }).some((entry) =>
      PROJECT_MARKERS.has(entry.name) || entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace")
    );
  } catch {
    return false;
  }
}

async function runFirstTimeLogin(options, dependencies) {
  if (!dependencies.interactive) return "";
  const settingsUrl = `${options.baseUrl.replace(/\/$/, "")}/settings`;
  console.log("\nFirst-time CodeCordon setup");
  console.log("1. Sign in, upgrade to Pro, and create an API key in Settings.");
  console.log(`2. Copy the key, then return here.\n\n${settingsUrl}\n`);
  const openUrl = dependencies.openUrl ?? openExternal;
  await openUrl(settingsUrl).catch(() => {});
  const promptApiKey = dependencies.promptApiKey ?? promptForApiKey;
  const apiKey = String(await promptApiKey()).trim();
  try {
    saveApiKey(apiKey, dependencies.configPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return "";
  }
  console.log("Login saved privately for future scans.");
  return apiKey;
}

async function promptForTarget() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question("Drag your project folder here, then press Enter (or type its path): ");
  } finally {
    readline.close();
  }
}

async function promptForApiKey() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await readline.question("Paste your API key: ");
    } finally {
      readline.close();
    }
  }

  return await new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write("Paste your API key (hidden): ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (buffer) => {
      for (const character of buffer.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Login cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function openExternal(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function helpText() {
  return `CodeCordon CLI\n\nUsage:\n  codecordon scan [path|github-url] [options]\n  codecordon login\n  codecordon logout\n\nRun \`codecordon scan\` anywhere. If the current folder is not a project, CodeCordon asks you to drag in the project folder. First use opens Settings and saves your API key in a private user-only config file.\n\nOptions:\n  --name <name>             Project name shown in CodeCordon\n  --api-key <key>           API key (prefer login locally or CODECORDON_API_KEY in CI)\n  --url <url>               API base URL (default: ${DEFAULT_URL})\n  --fail-on <severity>      critical, high, medium, low, or none\n  --min-score <0-100>       Also fail below this score\n  --format <pretty|json>    Output format\n  --json                    Shortcut for --format json\n  -h, --help                Show help\n  -v, --version             Show version\n\nExamples:\n  npx --yes codecordon@latest scan\n  npx --yes codecordon@latest scan /path/to/project\n  npx --yes codecordon@latest scan https://github.com/owner/repo --fail-on high\n  CODECORDON_API_KEY=cc_... codecordon scan . --json --min-score 80`;
}
