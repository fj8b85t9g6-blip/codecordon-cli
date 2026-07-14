# CodeCordon CLI

Run CodeCordon's deterministic security scanner from a terminal or CI pipeline.

```bash
export CODECORDON_API_KEY="cc_live_..."
npx codecordon .
```

Scan a public GitHub repository without cloning it:

```bash
npx codecordon https://github.com/owner/repo --fail-on high
```

The default gate fails when a critical finding is present. Use `--fail-on high`,
`--min-score 80`, or `--json` to fit the command into your pipeline. Local source
is compressed in memory; dependencies, build output, lockfiles, binaries, and
files larger than 512KB are excluded.

An API key and CodeCordon Pro plan are required for CI scans. A passing command
means the configured known-pattern gate passed. It is not a security certification.
