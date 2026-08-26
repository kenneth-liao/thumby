---
trigger: always_on
---

<!-- Context Module: development-workflow -->
# Development Workflow

## Git worktree hygiene

Per-issue worktrees live **inside the repo** at `.worktrees/<branch>` (gitignored) — never as a sibling dir in `~/projects/`. They are disposable; the PR stack is the source of truth.

- **Create:** `git worktree add .worktrees/<branch> <branch>` (or `-b <branch>` for a new branch). Make sure `.worktrees/` is in `.gitignore` (add it if missing). A branch with slashes (`fix/foo`) nests under `.worktrees/`, still ignored.

To avoid leaking resources:

- **Never commit `node_modules`.** A shared-deps worktree symlinks it to the main checkout; `.gitignore` must ignore both the directory *and* the symlink (the pattern is `node_modules`, not `node_modules/` — a trailing slash misses the symlink). A committed symlink holds an absolute path that breaks CI's `bun install --frozen-lockfile` with `ENOENT: could not open the "node_modules" directory`.
- **Before removing a worktree, stop its test/dev runtimes.** Deleting the directory while a runtime is running orphans the processes (e.g. `pkill -f 'workerd serve --binary'` for a Workers project — match the pattern to whatever the project's dev/test server actually is).
- **Remove cleanly:** `git worktree remove <path>` (not `rm -rf`), then `git worktree prune`. Delete the merged local branch (`git branch -d <branch>`); `gh pr merge --delete-branch` removes the remote branch only if no local worktree still holds it, so verify after with `git ls-remote --heads origin`.

## Local Tooling

- `bun` over `npm` for JavaScript/TypeScript projects
- `uv` over `pip` for Python projects
- `rg` over `grep` for improved performance

## Cross-repo sync check

*(Applies to projects that document a "Related Repos" table or equivalent — skip if a project has no sibling repos.)*

Sibling repos often share terminology, install commands, tool/schema names, or skill references. After a significant change in one repo (a rename, a changed schema, a new/removed tool or endpoint), scan the related repos for stale references before considering the change done — don't wait for a buyer/consumer repo to break silently.

Use whatever repo list and search method the project's own docs define (e.g. a "Related Repos" table in AGENTS.md); this rule doesn't hardcode a repo list or command, since that's project-specific.

## Database migration discipline

*(Applies to projects with a database/migration pipeline — skip if not relevant.)*

Migrations always run **before** the code deploy, and **staging before prod** — a schema/data migration is proven against a prod-shaped DB before it can touch a real record.

Follow **expand → contract**: a migration must be deployable one release ahead of the code that reads it (add nullable + dual-write first; flip reads and drop columns a release later). Rehearse any data migration on staging seeded from a prod snapshot before tagging.

Make every migration **idempotent** (`IF NOT EXISTS`, `DROP … IF EXISTS` before `CREATE`) so a replay against a built schema can't error. A CI `migrations` job that applies every migration to a clean Postgres is the gate that catches broken/non-idempotent migrations.
<!-- End Context Module: development-workflow -->
