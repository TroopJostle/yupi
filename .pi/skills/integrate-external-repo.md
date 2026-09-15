---
name: integrate-external-repo
description: Required process for adding third-party code to Yupi — vendored extensions, bundled subagents or tools, dependencies taken from an upstream repo, or ported features. Use whenever reusing an external project. Audit upstream for malware and supply-chain issues first, fork with gh, integrate only the fork at a pinned revision.
---

# Integrating External Code into Yupi

Core rule: audit the upstream repo at a pinned revision, fork it with the GitHub CLI, and integrate only the fork. Never wire an upstream URL into the harness, its dependencies, or its docs. This keeps every line of external code reviewable under our control and gives us a place to patch without waiting on upstream.

Applies to: vendoring sources (`packages/coding-agent/vendor/<name>/`), bundling extensions/subagents/tools, taking a dependency from a specific upstream repo, and porting features. Ordinary npm registry deps follow the "Dependency and Install Security" rules in AGENTS.md; this skill adds the audit-and-fork requirement for code taken from a specific project.

Work the phases in order. Do not fork before the audit verdict, do not integrate before the fork exists.

## 1. Audit upstream (before forking)

Everything later must use exactly the revision audited here.

1. Record the target revision: commit SHA, plus tag/version if there is one.
2. Repo reputation (informational; not a pass/fail by itself):
   ```bash
   gh repo view <owner>/<repo> --json isArchived,pushedAt,stargazerCount,licenseInfo
   gh api repos/<owner>/<repo>/security-advisories   # published advisories; empty is fine
   gh search issues --repo <owner>/<repo> malware
   ```
3. Clone upstream read-only into /tmp and check out the recorded SHA:
   ```bash
   git clone https://github.com/<owner>/<repo> /tmp/audit/<repo>
   git -C /tmp/audit/<repo> checkout <sha>
   ```
4. Supply-chain checks. Investigate every hit before proceeding:
   - Install hooks: `grep -rnE '"(preinstall|install|postinstall|prepare)"' --include=package.json /tmp/audit/<repo>`
   - Dynamic execution / exfiltration patterns:
     ```bash
     grep -RInE 'child_process|execSync|spawnSync|[^a-zA-Z]eval\(|Function\(|curl [^|]*\| *(ba)?sh|wget |base64 (-d|--decode)|\.ssh|AWS_SECRET|GITHUB_TOKEN|process\.env' \
       --include='*.ts' --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.json' /tmp/audit/<repo>
     ```
   - Lockfile hygiene (if present): `grep '"resolved"' /tmp/audit/<repo>/package-lock.json | grep -v registry.npmjs.org`. Non-registry or git-URL tarballs need justification; dep names that look like typosquats need verification against the npm registry.
   - Binary blobs without source: `find /tmp/audit/<repo> -type f -not -path '*/.git/*' -exec file {} + | grep -v text`
   - Obfuscation: large base64/hex literals, minified files in a non-minified codebase.
   - Non-Node projects: equivalent hooks (setup.py, Makefile install targets, build.rs, gradle tasks).
5. License: permissive (MIT, Apache-2.0, BSD, ISC) and the license file must carry into the vendor tree. Anything else, ask the user.

Stop and ask before continuing if the audit finds: install scripts that fetch or execute remote content, credential or env access beyond documented need, obfuscated payloads, unexplainable binaries, or unpinned remote code fetches.

## 2. Fork

```bash
gh repo fork <owner>/<repo> --clone=false                  # forks to the authenticated Yupi account
gh api repos/<account>/<repo>/commits/<sha> --jq .sha     # confirm the audited revision is in the fork
```

If upstream's default branch moved past the audited SHA between audit and fork, integrate the audited SHA anyway; anything newer needs a re-audit of the diff first.

## 3. Integrate (fork only)

- Vendor sources at `packages/coding-agent/vendor/<name>/` from a clone of the fork checked out at the audited SHA. Existing reference: `vendor/pi-subagents/`.
- No runtime downloads: anything that loads by default ships as package assets.
- Strip or disable update checks and telemetry in the vendored copy; list every local adaptation.
- New runtime deps the vendored code needs: add exact-pinned versions to `packages/coding-agent/package.json`, install with `npm install --ignore-scripts`, then refresh root `package-lock.json`, `packages/coding-agent/npm-shrinkwrap.json` (`node scripts/generate-coding-agent-shrinkwrap.mjs`), and `install-lock/package-lock.json`. Lifecycle scripts require an explicit allowlist entry in that script.
- Wire it into the harness (extension loader / resource-loader) with an opt-out where it loads by default.
- Tests: loading and opt-out tests plus behavior tests via `test/suite/harness.ts` and the faux provider; update default-tools and resource-loader expectations.
- Changelog entry under `## [Unreleased]`.
- Provenance README at the vendor root (audited revision is the audited SHA, not the fork HEAD):
  ```markdown
  # <name>

  Vendored from [<account>/<repo>](https://github.com/<account>/<repo>),
  a fork of [<owner>/<repo>](https://github.com/<owner>/<repo>).
  Audited upstream revision: `<sha>` (<version>, <date>; findings: none | <list>).
  The upstream <license> license is preserved in `LICENSE`.

  Local adaptations: ...
  ```

## 4. Updates

Upstream changes flow fork-first: audit the diff (`git diff <old-sha>..<new-sha>` in the fork), merge into the fork, re-vendor at the new SHA, and update the provenance README. Never pull vendored code directly from upstream.
