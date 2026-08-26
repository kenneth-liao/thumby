---
trigger: always_on
---

<!-- Context Module: versioning-and-changelogs -->
# Versioning & Changelogs

Projects use [Semantic Versioning](https://semver.org/). The version lives in the project's manifest file (`package.json`, `plugin.json`, `pyproject.toml`, etc. — check the project's own docs for the exact path; a repo with multiple sub-packages may version each independently).

## Rules

- **Every functional commit** (`feat:`, `fix:`, `refactor:`, `perf:`) MUST bump the version in the relevant manifest AND add an entry to `CHANGELOG.md`
- **Non-functional commits** (`docs:`, `chore:`, `test:`) do NOT require a version bump
- `feat:` bumps **minor** (0.x.0)
- `fix:`, `refactor:`, `perf:` bump **patch** (0.0.x)
- Breaking changes bump **major** (x.0.0) — annotate with `BREAKING:` in the commit message
- The `[Unreleased]` section in `CHANGELOG.md` collects changes until deploy/release
- **Git tags** (`v0.1.0`, etc.) are created at deploy time, not per commit

## Changelog Format

Use [Keep a Changelog](https://keepachangelog.com/) sections under `[Unreleased]`:
- **Added** for new features
- **Changed** for changes to existing functionality
- **Fixed** for bug fixes
- **Removed** for removed features

**Keep entries to what changed + the issue/PR ref** (one or two lines). Deep root-cause analysis and rejected alternatives belong in the **commit body** or an **ADR** (`docs/adr/`), not the changelog — putting them here is a second home for the "why" that bloats the file and drifts from the canonical record. Link out instead of restating.
<!-- End Context Module: versioning-and-changelogs -->
