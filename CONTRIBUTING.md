# Contributing to Footlight

Thanks for your interest — contributions are welcome, and you do **not** need to
be a programmer to make a valuable one. Footlight has **two contribution
surfaces**, and both matter equally.

## Two ways to contribute

### 1. Code

The render engine, the CLI, and the desktop GUI (Tauri). Bug fixes, new flags,
performance work, packaging, and tests all live here.

### 2. The "framing brain" — `prompts/base.md`

Footlight encodes hard-won **framing domain knowledge** as prose in
`prompts/base.md`: the pillarbox traps, the "a one-man-band moves across the
frame" principle, the cut-aligned crop-schedule technique, "verify the pixels,"
the clean-export caption policy, and so on.

**This prose is a first-class contribution surface.** If you discover a new
framing gotcha (say, a previously unseen pillarboxing failure mode) or work out a
reliable crop recipe for a new source type (a particular venue's stream layout, a
common edited-video pattern), please **send it as a prose PR to
`prompts/base.md`** — you do not have to touch any code. New gotchas and
source-type recipes are exactly what keeps the framing brain useful, and we
actively want them.

## Dev setup

The repo is two npm packages: the root render engine + `footlight` CLI, and the
`app/` desktop GUI. Most workflows run through `make` (`make help` for the list):

```bash
make setup-system  # (macOS) install ffmpeg + yt-dlp via Homebrew
make setup         # install both packages (root engine + app/)
make doctor        # verify Node 26+, ffmpeg, ffprobe are on your PATH
make test          # run the engine test suite (vitest)
make gui           # run the GUI in a browser (no Rust needed)
make tauri-dev     # run the native window (needs the Rust toolchain)
```

Requires **Node 26+**, plus `ffmpeg` / `ffprobe` on your `PATH` for anything that
exercises the engine end to end — Footlight does not bundle them. On macOS,
`make setup-system` installs the system tools; elsewhere, `make doctor` prints
the right install command for your platform.

## Code style

- **TypeScript** (strict, ESM, `.js` extensions on relative imports). Keep it
  clean, readable, and well-typed.
- Mind the **pure / Node split**: browser-safe transforms go in `src/core.ts`;
  only fs/subprocess code goes in `src/engine.ts`. See `CLAUDE.md` for the full
  architecture conventions (SPDX headers, even-dimension crop math, the
  two-backend app split).
- Keep changes focused and tested.

## Pull request expectations

- **Engine / CLI changes need tests** that cover the new behavior.
- Describe what changed and why; reference any related issue.
- For framing-brain (`prompts/base.md`) PRs, explain the source trait you hit and
  the framing that solved it — concrete examples make the knowledge reusable.

## Commits & releases

Footlight uses **[Conventional Commits](https://www.conventionalcommits.org/)**
and **[release-please](https://github.com/googleapis/release-please)** for
automated versioning and changelogs. Format commit (and squash-merge PR titles)
as `type(scope): summary`:

```
feat(engine): add punch-in cropWindow support
fix(cli): resolve relative --outdir against the repo root
docs(readme): document JSON manifests
chore(deps): bump vitest
```

- Common types: `feat` (minor bump), `fix` (patch bump), plus `docs`, `refactor`,
  `test`, `chore`, `ci`, `build`, `perf` (no release on their own).
- A breaking change — `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer — triggers
  a major bump.
- On merge to `main`, release-please opens/updates a release PR that bumps the
  version and updates `CHANGELOG.md`; merging that PR tags the release.

### Merging — squash only

PRs are **squash-merged** (merge commits and rebase merging are disabled on the
repo). This keeps `main` at one commit per PR, which is what release-please reads:
one PR → one conventional commit → one clean changelog entry. Merge commits and
stacked branches duplicated entries, so the squash policy is deliberate.

- The squash commit message defaults to the **PR title**, so the **PR title must
  be a valid Conventional Commit** (`type(scope): summary`) — that line is what
  ships in the changelog.
- The release PR (release-please's own) is squash-merged too.
- Trade-off: the squash commit on `main` is **GitHub-verified** (signed by
  GitHub's web-flow key), not your personal key. Sign your branch commits as
  usual; the per-commit signatures live on the PR record.

## A couple of promises

- **No telemetry.** Footlight does not phone home; if usage stats are ever added
  they will be strictly opt-in.
- **Be welcoming.** Questions, first PRs, and prose-only contributions are all
  genuinely valued here.
