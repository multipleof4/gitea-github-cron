# gitea-github-cron

GitHub Actions that back up every GitHub repo I own (personal and org) to a self-hosted Gitea as pull mirrors.

**Gitea version: 1.27.\***

## Workflows

| Workflow | Schedule (UTC) | Script | Does |
| --- | --- | --- | --- |
| Rename deleted GitHub mirrors | 03:30 (10:30 PM CDT) | `rename-gone-mirrors.js` | Renames mirrors whose GitHub repo was deleted or moved to `<name>-goneN` and freezes them |
| Mirror to Gitea | 05:00 (12 AM CDT) | `mirror.js` | Creates missing orgs and pull mirrors, syncs repo/org visibility, descriptions and org avatars |
| Sync releases to Gitea | 06:30 (1:30 AM CDT) | `sync-releases.js` | Copies GitHub releases (title, notes, assets) onto the mirrors |
| Sync issues to Gitea | 08:00 (3 AM CDT) | `sync-issues.js` | Copies GitHub issues and their comments onto the mirrors |

Each runs once a day, 1.5 hours apart, so each one starts with a fresh hourly GitHub API budget. Renames go first so gone mirrors are already frozen (and skipped) when the syncs run, and the syncs come after the mirror run so they cover mirrors made that night. All can also be run by hand from the Actions tab. Each run posts a summary to ntfy through `notify.js`. `gitea-mirrors.js` holds the API helpers the two sync scripts share.

## Releases on mirrors

Gitea's migrate API drops `releases: true` for pull mirrors, so a mirror only gets bare tag entries. `sync-releases.js` fills in the real releases:

- Matches releases by tag, creates missing ones, updates changed title/notes/prerelease, uploads missing assets by name.
- Skips GitHub drafts.
- Skips a release until its tag has reached Gitea through a mirror sync. Otherwise Gitea would create the tag on the default branch.
- Streams each asset from GitHub straight into Gitea. Uploads are capped by `[repository.release] FILE_MAX_SIZE` (default 2048 MB, which matches GitHub's 2 GiB per-file limit) and need `[attachment] ENABLED`.
- Skips frozen mirrors (sync interval 0).
- Never deletes anything on Gitea.

This relies on Gitea ≥ 1.21.5, where a mirror sync only touches tag-only entries and keeps real releases ([go-gitea/gitea#28817](https://github.com/go-gitea/gitea/pull/28817)).

## Issues on mirrors

Gitea drops issues for pull mirrors too, but the API still lets you create them. `sync-issues.js` copies them over through the API:

- Gitea issue numbers always match GitHub's, so `#N` in commits and comments points at the right thing:
  - PRs aren't copied, since mirrors have no pull requests. Their numbers stay gaps on Gitea.
  - Numbers that aren't issues on GitHub (deleted, transferred, or used by a discussion) stay gaps too. Gitea never reuses a deleted issue's number, so an issue that lands on a gap is deleted and made again until it gets GitHub's number.
  - If Gitea's counter is already past a GitHub number, or `#N` on Gitea wasn't made by the sync, that repo stops with a failure instead of guessing.
- Everything is posted as the Gitea token user. Each issue and comment opens with a quoted line naming the GitHub author, the date, and a link back. The link is how comments are matched on later runs, so don't edit it away.
- Title, body, open/closed state, labels and comment edits follow GitHub. Nothing is deleted on Gitea.
- Images uploaded to GitHub stay as links to GitHub.

## Secrets

| Secret | Used for |
| --- | --- |
| `GH_PAT` | Classic GitHub token with `repo` scope |
| `GITEA_TOKEN` | Gitea token for the account that owns the mirrors |
| `GITEA_URL` | Gitea host, with or without `https://` |
| `NTFY_TOPIC_URL` | ntfy topic that gets run summaries |
