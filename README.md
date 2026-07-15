# CodeCordon CLI

Run CodeCordon's deterministic security scanner from a terminal or CI pipeline. You need Node.js 20 or newer and a CodeCordon Pro API key.

## First scan

1. Create an account at [codecordon.up.railway.app](https://codecordon.up.railway.app/register).
2. Upgrade to Pro in **Settings**. API access is a Pro feature.
3. In **Settings → API keys**, create a key and copy it immediately. CodeCordon never stores the readable key.
4. Open a terminal in the project you want to scan.
5. Put the key in an environment variable and run the CLI:

macOS or Linux:

```bash
export CODECORDON_API_KEY="cc_live_your_key_here"
npx --yes codecordon@0.1.0 .
```

PowerShell:

```powershell
$env:CODECORDON_API_KEY="cc_live_your_key_here"
npx --yes codecordon@0.1.0 .
```

`npx` downloads and runs the published package; a global install is not required. Prefer the environment variable over `--api-key` so the key is less likely to enter shell history.

Scan a public GitHub repository without cloning it:

```bash
npx --yes codecordon@0.1.0 https://github.com/owner/repo --fail-on high
```

The default gate fails when a critical finding is present. Use `--fail-on high`,
`--min-score 80`, or `--json` to fit the command into your pipeline. Local source
is compressed in memory; dependencies, build output, lockfiles, binaries, and
files larger than 512KB are excluded.

An API key and CodeCordon Pro plan are required for CI scans. A passing command
means the configured known-pattern gate passed. It is not a security certification.

## Exit codes and troubleshooting

- `0`: the configured gate passed.
- `1`: the scan ran, but a severity or score threshold failed.
- `2`: the scan could not run. Read the error directly above it.

If you see `invalid or missing X-Api-Key`, recreate or recopy the key in Settings. If you see `The CI API requires a Pro plan`, confirm the same account is on Pro. The CLI skips dependencies, build output, lockfiles, binaries, symlinks, files over 512 KB, and archives over 50 MB.

For pull-request setup, use the [reusable GitHub Actions workflow](https://github.com/fj8b85t9g6-blip/codecordon/blob/main/docs/github-actions.md).
