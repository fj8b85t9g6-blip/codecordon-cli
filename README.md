# CodeCordon CLI

Run CodeCordon's deterministic security scanner from a terminal or CI pipeline. You need Node.js 20 or newer. Interactive scans of public GitHub repositories include a free 24-hour preview; local-folder CLI scans and CI require CodeCordon Pro. Free accounts can still save scans created in the web app.

## First scan

Paste one command from any folder:

```bash
npx --yes codecordon@latest scan https://github.com/owner/repo
```

Until npm `0.3.0` publication is complete, the same signed-off package can be
run from its public GitHub release:

```bash
npx --yes --package=https://github.com/fj8b85t9g6-blip/codecordon-cli/releases/download/v0.3.0/codecordon-0.3.0.tgz codecordon scan https://github.com/owner/repo
```

For a public GitHub URL, CodeCordon runs without an account and returns a preview that expires after 24 hours. Free previews are limited to three per hour and are available only in an interactive terminal.

For a local project, CodeCordon:

1. Opens Settings so you can sign in, upgrade to Pro, and create an API key.
2. Asks you to paste the key into a hidden prompt, then saves it in a user-only config file.
3. Uses the current project folder. If you ran the command somewhere else, it asks you to drag the project folder into Terminal—no `cd` command or path construction required.

Future scans use the saved login. Run `npx --yes codecordon@latest logout` to remove it or `npx --yes codecordon@latest login` to replace it. In CI, continue to use the `CODECORDON_API_KEY` environment variable; interactive setup never runs there.

Scan a local project after signing into Pro:

```bash
npx --yes codecordon@latest scan /path/to/project --fail-on high
```

The default gate fails when a critical finding is present. Use `--fail-on high`,
`--min-score 80`, or `--json` to fit the command into your pipeline. Local source
is compressed in memory; dependencies, build output, lockfiles, binaries, and
files larger than 512KB are excluded.

Readable free-scan output links to the 24-hour preview. Pro output links to the saved web report so you can verify a live deployment and create ShipBond launch evidence. `--json` remains machine-readable and does not include display-only conversion copy.

An API key and CodeCordon Pro plan are required for local and CI scans. A passing command
means the configured known-pattern gate passed. It is not a security certification.

## Exit codes and troubleshooting

- `0`: the configured gate passed.
- `1`: the scan ran, but a severity or score threshold failed.
- `2`: the scan could not run. Read the error directly above it.

If you see `invalid or missing X-Api-Key`, run `npx --yes codecordon@latest login` and paste a new key. If you see `The CI API requires a Pro plan`, confirm the same account is on Pro. The CLI skips dependencies, build output, lockfiles, binaries, symlinks, files over 512 KB, and archives over 50 MB.

For pull-request setup, use the public [CodeCordon Security Gate Action](https://github.com/fj8b85t9g6-blip/codecordon-action).
