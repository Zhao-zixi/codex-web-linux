# /release - Publish a new version to npm, and the iOS and Mac apps when they changed

## Description
Bump the package version, push to GitHub, and create a release with a structured changelog that triggers the npm publish workflow. Then check `ios/` and `macos/` for changes since their last release, and ship each one that changed: iOS as the next TestFlight build, Mac as a notarized DMG on kanna.sh.

The three releases are independent. Ship each one that has changes and skip each one that doesn't. If only the iOS app changed, ship only the iOS app.

## Instructions

### Step 0: Find what changed

Run all three checks before you release anything. Then tell the user in one short message which of npm, iOS and Mac you will ship.

**npm (kanna-code).** Commits since the last `v*` tag, not counting `macos/`, which ships separately:

```bash
git log $(git describe --tags --abbrev=0 --match 'v*')..HEAD --oneline -- . ':!macos'
```

**iOS (`ios/`).** `ios/` is its own git repository (github.com/jakemor/kanna-ios), and the parent repo ignores it. Each TestFlight build is tagged `v<version>-build.<N>` on its build-number bump commit, for example `v0.1-build.20`. Builds up to 19 used `v0.1-19`, and the pattern below matches both:

```bash
cd /Users/jake/Projects/kanna/ios
LAST=$(git tag --list 'v*-*' --sort=-creatordate | head -1)
git log "$LAST"..HEAD --oneline
```

Bump commits don't count as changes. If nothing else is new, skip iOS.

**Mac (`macos/`).** Each Mac release is tagged `mac-v<version>` in this repo, on its release commit ("Kanna for Mac 2.0.1"):

```bash
cd /Users/jake/Projects/kanna
LAST=$(git tag --list 'mac-v*' --sort=-creatordate | head -1)
git log "$LAST"..HEAD --oneline -- macos
```

**Uncommitted work.** Only committed changes count. The iOS archive and the Mac build both build from the working tree, and other agents may be editing it. If `git status --porcelain` shows changes in `ios/` or `macos/`, ask the user before you ship that app. Don't commit another agent's work yourself.

### Step 1: Analyze changes and recommend a version bump

Skip Steps 1–4 if Step 0 found no npm changes.

Before prompting the user, do the following:

1. Read the current version from `package.json`.
2. Use the npm commit list from Step 0.
3. Based on the changes, decide your recommended version bump:
   - **patch** — bug fixes, typos, small tweaks
   - **minor** — new features, non-breaking enhancements
   - **major** — breaking changes, API changes, large rewrites
4. Calculate what the new version number would be for each option (patch, minor, major).

If the user passed an explicit version as an argument (e.g. `/release 0.27.0`), use that version directly — skip the recommendation logic and confirmation. That version applies to npm only.

Otherwise, for **patch** and **minor** bumps, proceed automatically with your best recommendation — do NOT ask for confirmation. Just tell the user what you chose and why in a brief message before bumping.

For **major** bumps only, use the `AskUserQuestion` tool to confirm with the user before proceeding, since major versions indicate breaking changes.

### Step 2: Bump version and push

1. Run `npm version <patch|minor|major>` to bump `package.json` and create a git tag.
2. Run `git push && git push --tags` to push the commit and tag.

### Step 3: Build the changelog

Before creating the GitHub release, generate a structured changelog:

1. Read the last 2–3 releases with `gh release view <tag>` to understand existing style.
2. Get the commits in this release: `git log <previous-tag>..<new-tag> --oneline -- . ':!macos'`.
3. For each commit, check if it's associated with a merged PR:
   - Use `gh pr list --search "<sha>" --state merged --json number,title,author` or the GitHub API.
   - If a PR exists, use its number, title, and author. Prefer linking to the PR.
   - If no PR exists, link to the commit and use the commit author.
4. If multiple commits belong to the same PR, group them into a single entry.
5. Categorize each change into one of the sections below.
6. Write each entry from the **user's perspective** — what changed, not how it was built.

### Changelog detail level

**Keep it short: every entry — feature, improvement, or under the hood — is at most 15 words** (title excluded). One clause, no code examples, no multi-paragraph write-ups, no composition essays.

### Changelog format

Use these sections **in order**, omitting any that have no entries:

1. `## New Features` — New user-facing functionality
2. `## Improvements` — Enhancements, bug fixes, and polish to existing features
3. `## Under the Hood` — Non-user-facing changes (infra, refactors, performance, internal tooling)

Each entry is a bold title, a ≤15-word description, and an author link:

```
**Bold Title** — Description in fifteen words or fewer. [author](PR-or-commit-url)
```

Example:

```markdown
## New Features
**Password Protection (`--password`)** — Lock your instance behind a password with secure, memory-only sessions. [jake](https://github.com/jakemor/kanna/commit/6e83973)

## Improvements
**Sidebar Toggle Fix** — Sidebar visibility no longer glitches when toggling. [jake](https://github.com/jakemor/kanna/commit/187fba5)

## Under the Hood
**Modular ChatPage** — Split ChatPage into smaller components. [jake](https://github.com/jakemor/kanna/commit/def456)
```

If there are no changes at all, use: `No changes this release.`

### Step 4: Create the GitHub release

```bash
gh release create "v<new-version>" \
  --title "v<new-version>" \
  --notes "<changelog content>"
```

The GitHub Release triggers `.github/workflows/publish.yml`, which builds and publishes to npm via Trusted Publishing.

### Step 5: iOS → TestFlight (only if `ios/` changed)

Follow the `/testflight` skill (`~/.claude/skills/testflight/SKILL.md`) for the app in `ios/`, with these Kanna specifics:

- **Keep the version. Bump only the build.** Leave `MARKETING_VERSION` in `ios/project.yml` as it is, even when npm got a new version. Add 1 to `CURRENT_PROJECT_VERSION`, taking the higher of that and the highest build on ASC for this version. A new build of a version TestFlight already approved clears beta review in about a minute. A new version goes through full review again.
- Bundle ID `com.jakemor.kanna`, team `QK9365HKRK`. The ASC API key for signing is in `ios/.env.speedflight` (`ASC_KEY_ID`, `ASC_ISSUER_ID`, and the key at `~/private_keys/AuthKey_<ASC_KEY_ID>.p8`). Pass these to `xcodebuild` with the `-authenticationKey*` flags.
- Commit the bump **in `ios/`**, not in the parent repo, as `Bump the build number to <N> for the next TestFlight upload`. Then tag it `v<version>-build.<N>` (e.g. `v0.1-build.20`), and push both the branch and the tag: `git push origin main && git push origin v<version>-build.<N>`. The tag is how the next `/release` finds what changed.
- Run the archive, the upload and the processing polls in the background, and tell the user what is running.

### Step 6: Mac → kanna.sh (only if `macos/` changed)

`macos/` is Kanna for Mac, an Electron app: the window only. The server inside it is the npm package, so a Mac release is needed only when `macos/` itself changed.

1. Bump the patch number of `"version"` in `macos/package.json` (for example `2.0.0` → `2.0.1`). Bump the minor number instead for a new user-facing feature. Installed apps update only to a higher version, and the build number is the commit count (`build.sh`), so commit before you build.
2. Commit only that file as `Kanna for Mac <version>` and push.
3. Build, notarize and publish in the background. The `asc` profile is `jake@superwall.com`:
   ```bash
   cd /Users/jake/Projects/kanna/macos && ASC_PROFILE=jake@superwall.com ./build.sh --publish
   ```
   It notarizes twice (the app, then the DMG), which takes a few minutes each. Then it uploads `Kanna-<version>.dmg`, `Kanna-<version>-mac.zip`, `Kanna.dmg` and `latest-mac.yml` to R2. The kanna.sh homepage's Download for Mac button and every installed app's update check (`macos/src/updates.ts`) see them at once.
4. After it publishes, tag the release commit and push the tag: `git tag mac-v<version> && git push origin mac-v<version>`. No workflow runs on this tag; the next `/release` uses it to find what changed.
5. If the build fails on signing or notarization, report the exact error and stop. Never create, revoke or delete certificates.

### Step 7: Report

Tell the user, for each release that shipped:

- **npm:** the new version, and a link to the GitHub release.
- **iOS:** the version and build number, the build ID, and the beta review state.
- **Mac:** the version, and https://kanna.sh/downloads/mac/Kanna.dmg.

Also name each release you skipped because nothing had changed.
