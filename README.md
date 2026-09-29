# gitea-github-cron

GitHub Actions that back up every GitHub repo I own (personal and org) to a self-hosted Gitea as pull mirrors.

**Gitea version: 1.27.\***

## Workflows

| Workflow | Schedule (UTC) | Script | Does |
| --- | --- | --- | --- |
| Mirror to Gitea | every 4h at :00 | `mirror.js` | Creates missing orgs and pull mirrors, syncs repo/org visibility and org avatars |
| Sync releases to Gitea | every 4h at :30 | `sync-releases.js` | Copies GitHub releases (title, notes, assets) onto the mirrors |
| Rename deleted GitHub mirrors | daily 08:00 | `rename-gone-mirrors.js` | Renames mirrors whose GitHub repo was deleted or moved to `<name>-goneN` and freezes them |

All three can also be run by hand from the Actions tab. Each run posts a summary to ntfy through `notify.js`.

## Releases on mirrors

Gitea's migrate API drops `releases: true` for pull mirrors, so a mirror only gets bare tag entries. `sync-releases.js` fills in the real releases:

- Matches releases by tag, creates missing ones, updates changed title/notes/prerelease, uploads missing assets by name.
- Skips GitHub drafts.
- Skips a release until its tag has reached Gitea through a mirror sync. Otherwise Gitea would create the tag on the default branch.
- Streams each asset from GitHub straight into Gitea. Uploads are capped by `[repository.release] FILE_MAX_SIZE` (default 2048 MB, which matches GitHub's 2 GiB per-file limit) and need `[attachment] ENABLED`.
- Skips frozen mirrors (sync interval 0).
- Never deletes anything on Gitea.

This relies on Gitea ≥ 1.21.5, where a mirror sync only touches tag-only entries and keeps real releases ([go-gitea/gitea#28817](https://github.com/go-gitea/gitea/pull/28817)).

## Secrets

| Secret | Used for |
| --- | --- |
| `GH_PAT` | Classic GitHub token with `repo` scope |
| `GITEA_TOKEN` | Gitea token for the account that owns the mirrors |
| `GITEA_URL` | Gitea host, with or without `https://` |
| `NTFY_TOPIC_URL` | ntfy topic that gets run summaries |
