# Mingboard

One board for the pull requests you are shepherding through CI. Pin the PRs you care about and each one tells you, in plain words, where it stands and what it needs next — instead of a browser tab per PR. The usual maintainer actions (update branch, run or retry CI, labels, approve, merge) are buttons on the board.

<img width="1668" height="1027" alt="Screenshot 2026-10-08 at 12 57 06 PM" src="https://github.com/user-attachments/assets/458d4cbf-d81b-4962-937f-36c99a792ed9" />

Mingboard is a personal fork of [Pingboard](https://github.com/mgoin/pingboard). Its local dashboard and MCP server share one board, so changes made by an assistant appear in the browser automatically. It is tuned for [vllm-project/vllm](https://github.com/vllm-project/vllm) and works for any repository.

## Run locally

Requires Node.js 22 or newer. Use your existing authenticated GitHub CLI, or set `GITHUB_TOKEN` / `GH_TOKEN`, then run:

```bash
npm ci --prefix mcp
npm run web --prefix mcp
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). `MINGBOARD_PORT` selects a different port. The local server uses your GitHub credential in memory and proxies GitHub requests; the browser never receives the credential.

The board stays in `~/.pingboard/board.json`, retaining the existing Pingboard path and saved pins. Both the dashboard and MCP must use the same file. Set `MINGBOARD_STATE_FILE` to override it; the older `PINGBOARD_STATE_FILE` is also accepted.

The dashboard polls shared state while idle. Saves check the current board revision so an old browser snapshot cannot overwrite an intervening MCP change. If a save conflicts, Mingboard reloads the current board and asks you to retry the edit. Connection and save failures are shown rather than silently saving to a separate browser board.

## The board

Each row is one pull request with a status and, where there is an obvious next step, a button for it.

| Status | Meaning | Button |
| --- | --- | --- |
| **CI not started** | no build on the latest commit | Run CI, or Update branch & run CI when the branch is behind |
| **CI running** | jobs in progress, with any failures so far | — |
| **N failures to look at** | failing jobs not seen failing anywhere else | — |
| **N failures, likely unrelated** | every failing job also fails on the base branch or on other pinned PRs | Retry failed jobs |
| **CI passed · needs review** | green, waiting on a review | — |
| **Ready to merge** | green and approved | Merge… |
| **Merge conflicts** | the author has to resolve them | — |

The chips above the list filter by CI state (number keys `1`–`7`, including **Review requested**) and, separately, by owner: **Mine** shows the PRs you authored, **Others'** the ones you are shepherding for someone else. The selection is remembered. A PR that requests your review directly says **your review requested** (requests to a team you are on are not detected).

A blue dot marks a PR that changed since you last selected it, or that newly requests your review. Drag rows to reorder them or move them between groups, and drag the divider to resize the list. The sort menu orders each group by recently updated, recently pinned, newest PR or needs attention instead of by hand; Manual order brings your arrangement back.

Selecting a row opens the detail pane: the status with a one-line explanation, the failing and running jobs (each links to its Buildkite job), branch freshness, reviews, labels, and the latest comments — which is where the CI bot answers `/ci` commands.

**+ Add PRs** lists open pull requests in your default repository (yours, review requested, reviewed, involved, `ready`, all recent) and narrows as you type. Click to pin; pasting PR numbers or URLs works too. Type `@name` to see one author's PRs. To keep an eye on particular people, **Follow** them from a PR (or list them in Settings): their names are highlighted everywhere and Add PRs gets a **Following** list.

**Sync search** in a group's header keeps that group in step with a GitHub search such as `review-requested:@me` or `author:@me label:ready`. Every five minutes Mingboard pins new open PRs it finds into the group. A PR the search pinned is unpinned again once it stops matching while still open; PRs you pinned yourself or moved to another group stay put, and one you unpin is not pinned again. Searches without a `repo:`, `org:` or `user:` qualifier are scoped to your default repository. Clear the search to stop syncing.

Settings can also **unpin merged/closed PRs after a day** (off by default); **Clear merged / closed** does it at once.

## Related or unrelated failures

Mingboard does not read build logs. It sorts failing jobs using what GitHub already knows:

- **N/M on base** — the same job failed on N of the last M base-branch commits that ran CI.
- **also #123 #456** — the same job is failing on other PRs on your board.

A job with either kind of evidence is listed as "likely unrelated". Everything else is "to look at".

## Actions

Everything is done as you, with your token.

- **Comments** (`/ci run`, `/ci retry`, `/ci cancel`) and **branch updates** wait three seconds behind an Undo bar before they are sent.
- **Update branch & run CI** merges the base branch in, waits for the new commit, then posts `/ci run`.
- **Approve** and **Merge** ask for confirmation. **Labels** apply immediately.

Keyboard shortcuts exist for all of it; press `?` for the list.

## GitHub credentials

Local mode looks for `GITHUB_TOKEN`, then `GH_TOKEN`, then the GitHub CLI's current credential. A classic token needs the `repo` scope (`public_repo` is enough for public repositories). The credential stays in the server process and is sent only to `api.github.com`; it is never saved in board data or returned to the dashboard.

Settings has **Export board + settings** and **Import board + settings** for backups and transfers. Backups contain pins, groups and non-secret preferences. Local dashboard and MCP changes share the same file and do not need import/export to synchronize.

## Refresh and rate limits

Open PRs refresh every 60 seconds by default (configurable), background tabs five times slower, reading up to 10 PRs per GraphQL request. The base-branch baseline covers the last 30 commits and is re-read every 10 minutes. Group searches run every 5 minutes, one request each. Remaining API quota is shown in the top bar, and polling pauses if it runs low.

## Other repositories

`owner/repo#123` or a URL pins a PR from anywhere. The Settings button also lets you configure a repository's workflow directly in the browser: which checks count as CI, the gating pipeline, comment commands, quick labels, and merge method. Profiles are selectable from a dropdown and can be deleted; deleting a built-in profile override restores its built-in defaults. In local mode these overrides are saved with the shared board preferences. In static mode they are stored in `localStorage` per GitHub login. Built-in defaults live in `REPO_PROFILES` in `core.js`; repositories without a saved or built-in profile start with every check treated as CI and no CI commands.

## Static mode

Hosted dashboard: [soyr-redhat.github.io/mingboard](https://soyr-redhat.github.io/mingboard/).

The browser-only app can still run without Node:

```bash
python3 -m http.server 8080
```

Open `index.html` or the served folder and connect with a GitHub token. In this mode the token is sent directly from the browser to GitHub and stays in `sessionStorage`, or `localStorage` when **Keep token after closing this tab** is enabled. Board data is also stored in the browser per GitHub login and origin.

Static mode has a separate board from the local server. Use import/export to transfer snapshots. GitHub Pages serves this static mode; it cannot run the shared local backend or automatically read the local board file.

The GitHub Pages workflow deploys the browser-only dashboard on every push to `main` and can also be run manually. It publishes only the six client assets. Pins, preferences, and tokens stay in your browser and are never included in the deployment.

## MCP server

The optional [local MCP server](mcp/README.md) lets an assistant read and manage a board, find PRs requesting your review, compare CI failures, and run, retry or cancel CI. It also supports updating a branch before running CI. The server and browser share the same profiles and status logic in `core.js`.

Run the MCP entrypoint from this checkout with the same state-file setting as the local dashboard. MCP pins and preferences then appear in the dashboard automatically. Static sites, including the upstream Pingboard website, remain separate; import/export transfers snapshots to and from those sites.

## Tests

```bash
npm ci --prefix mcp
./tests/run
```

Runs browser compatibility and shared-state integration checks. It needs Node.js 22+, [Bun](https://bun.sh), and the MCP dependencies installed above. The runner installs Playwright and its Chromium browser.

For the MCP server, using Node.js 22 or newer:

```bash
npm ci --prefix mcp
npm test --prefix mcp
```

CI runs both suites. Tests use temporary board files and mocked GitHub responses; they never modify your board or perform live GitHub mutations.
