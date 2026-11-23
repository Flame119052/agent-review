# Set up Agent Review

Run these commands with GitHub CLI signed in as an administrator of `Flame119052/agent-review`. Commands headed by `gh secret set` ask you for the value. Paste the value into the prompt or send a credential file on standard input.

## 1. Prepare GitHub access

Create three fine-grained GitHub tokens. Give each the smallest repository selection it needs.

| Token | Repository selection | Permissions |
| --- | --- | --- |
| `REVIEW_TARGET_TOKEN` | Agent Review and the repositories you want it to review | Contents read, Actions read, Issues write, Pull requests write |
| `CODEX_SECRET_ROTATOR_TOKEN` | Agent Review only | Secrets read and write |
| `AGENT_REVIEW_DISPATCH_TOKEN` | Agent Review only | Contents write, required by GitHub’s dispatch endpoint |

Use a separate identity for the dispatch token with no bypass for branch protection. Protect `main` and restrict updates to trusted maintainers before sharing the token. Contents write can otherwise change the code that handles the hub’s secrets. A fine-grained token is tied to one resource owner. For repositories under a different owner, arrange approved access for the hub identity before connecting them. [GitHub token permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)

Create the `codex-refresh` environment under **Settings → Environments**. Set its deployment branches to `main`. Turn on device-code login in your ChatGPT security settings before registering the Codex login.

```sh
cd "$HOME/Developer/agent-review"
hub=Flame119052/agent-review
gh secret set REVIEW_TARGET_TOKEN -R "$hub"
gh secret set CODEX_SECRET_ROTATOR_TOKEN -R "$hub" --env codex-refresh
gh variable set AGENT_ALLOWLIST -R "$hub" --body 'Flame119052'
```

Use a comma-separated list in `AGENT_ALLOWLIST` if more GitHub accounts may request reviews.

## 2. Load the seven provider logins

1. Run `claude setup-token` in a private terminal and paste the plan token into the first prompt below.
2. Run the Codex login command below to sign in with your ChatGPT plan. The command uploads `CODEX_AUTH_JSON` from a separate login folder.
3. On the Dell, clone this repository and run the Antigravity commands over SSH so `agy` writes the Google plan login to a file. Copy its file into the hub secret using standard input.
4. Paste the OpenCode Go, Z.ai coding plan, Nvidia NIM, and Sarvam credentials into their named prompts.

```sh
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$hub"
AGENT_REVIEW_REPO="$hub" node tools/codex-ci-login.mjs
gh secret set OPENCODE_API_KEY -R "$hub"
gh secret set ZHIPU_API_KEY -R "$hub"
gh secret set NVIDIA_API_KEY -R "$hub"
gh secret set SARVAM_API_KEY -R "$hub"
```

Run the Antigravity commands from the hub checkout on the Dell.

```sh
hub=Flame119052/agent-review
node tools/agy-ci-login.mjs --login
node tools/agy-ci-login.mjs --check
gh secret set AGY_OAUTH_TOKEN -R "$hub" < "$HOME/.config/agent-review-agy-ci/.gemini/antigravity-cli/antigravity-oauth-token"
```

Use **Actions → codex refresh → Run workflow** to verify upload and rotation. Let the hub manage that login from then on. For a recovery login, pause the refresh workflow and check for a running refresh before uploading a replacement. Use a fresh device login for the hub when migrating from Tess so the two schedules do not rotate the same token.

## 3. Connect a repository

From the target repo’s checkout, run the commands below. Substitute the actual owner and repo. Put the workflow on the target’s default branch with your usual commit or pull request process.

```sh
target=OWNER/REPO
hub_checkout="$HOME/Developer/agent-review"
mkdir -p .github/workflows
cp "$hub_checkout/connector/agent-review-caller.yml" .github/workflows/agent-review.yml
gh secret set AGENT_REVIEW_DISPATCH_TOKEN -R "$target"
git add .github/workflows/agent-review.yml
git commit -m "Connect Agent Review"
```

After the connector lands, comment on a same-repo PR whose CI is green. Use a test change you are comfortable sending to the selected provider. For a private target, set up at least one watcher first. The commenter must be on `AGENT_ALLOWLIST`. If the connector is temporarily disabled, dispatch the existing comment manually.

```sh
gh workflow run agent-review.yml -R Flame119052/agent-review \
  -f repository=OWNER/REPO -f issue_number=123 -f comment_id=456789
```

## 4. Switch the usage publishers

Run these steps on Mac, Omarchy, and VPS from each machine’s hub checkout. Leave the existing `tess-usage` command installed. The publisher reads its quota summary and writes only numbers and timestamps to the hub. The GitHub account running it needs Variables write on the hub.

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 tools/usage-publish/publish.mjs "$HOME/.local/bin/tess-usage-publish"
```

Run the line for that machine to publish once. An existing timer that calls this installed file now defaults to Agent Review. If the timer passes `--repo` or sets `AGENT_REVIEW_REPO`, update that destination too.

```sh
"$HOME/.local/bin/tess-usage-publish" --machine mac --repo Flame119052/agent-review
"$HOME/.local/bin/tess-usage-publish" --machine omarchy --repo Flame119052/agent-review
"$HOME/.local/bin/tess-usage-publish" --machine vps --repo Flame119052/agent-review
```

Keep one timer on each machine and confirm its variable is updating. The [publisher guide](tools/usage-publish/README.md) covers a fresh timer install. Follow the [watcher guide](tools/review-watch/README.md) to receive private reviews.

## 5. Migrate Tess Music

1. Copy the connector into Tess as in step 3. If you want the old path rules, add `.github/review.json` with the sensitive paths and omitted generated artifacts below. The hub can read the existing Tess `.github/agents.json` when `review.json` is absent. To preserve both, copy the existing agents fields into the new config and add these keys.
2. Add Tess to each watcher’s `repos.txt`. Stop each old Tess watcher before starting the new watcher for the same repository, so both cannot pick up an explicit machine tag.
3. Verify one public `@tess-review` on a green Tess PR. Check that the hub workflow ran and the verdict names the right commit. Verify a watcher queue and verdict separately if you use machine tags.
4. Once the hub refresh succeeds with its own login and the Tess connector works, disable the Tess refresh workflow. Check that the hub workflow stays enabled.

```json
{
  "sensitivePaths": ["installer/", "inbox/", "patcher/", "support/", "mini/", "tools/release.mjs", "tools/promote.mjs", "tools/rescue.mjs", "tools/check-safety.sh"],
  "omitDiffPaths": ["patcher/prebuilt/", "theme/Tess/theme.js", "theme/Tess/user.css"]
}
```

```sh
gh workflow disable codex-refresh.yml -R Flame119052/tess-music
gh workflow view codex-refresh.yml -R Flame119052/agent-review
```

## 6. Secret source & rotation guide

Keep this table handy when rotating any credential so you know which local tools share a key and what stops working if you revoke it. No secret values or personal paths are stored here.

| Secret in `agent-review` | Where it came from | Shared with local tools? | How to rotate cleanly |
| --- | --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Generated via `claude setup-token` (~1-year headless OAuth token) | **Separate token** from your interactive Claude Code login, same Claude subscription | Run `claude setup-token` and upload with `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R Flame119052/agent-review`. Revoking old token only affects CI reviews. |
| `CODEX_AUTH_JSON` | Dedicated device-code login via `tools/codex-ci-login.mjs` (separate from `~/.codex`) | **Dedicated CI login** (never shares `~/.codex/auth.json`). Auto-rotated every 4 days by `codex-refresh.yml`. | Do not touch while `codex-refresh.yml` is healthy. If broken: disable `codex-refresh.yml`, re-run `AGENT_REVIEW_REPO=Flame119052/agent-review node tools/codex-ci-login.mjs`, then re-enable `codex-refresh.yml`. |
| `AGY_OAUTH_TOKEN` | Dedicated Linux file-based OAuth login via `tools/agy-ci-login.mjs --login` (under `~/.config/*-agy-ci/`) | **Dedicated CI login** (separate from macOS keychain), same Google plan. | Re-run `node tools/agy-ci-login.mjs --login` + `--check` on Linux, then upload with `gh secret set AGY_OAUTH_TOKEN -R Flame119052/agent-review < ...`. Revoking in Google Account stops CI Gemini reviews until re-logged-in. |
| `OPENCODE_API_KEY` | Copied from local OpenCode credential store (`~/.local/share/opencode/opencode.db`, `opencode-go`) | **Shared** with OpenCode Go on your local machines (and any Cloudflare Worker using the same Go key). | Rotating this key in the OpenCode console requires updating both your local OpenCode login and `gh secret set OPENCODE_API_KEY -R Flame119052/agent-review` (plus any Worker using it). |
| `ZHIPU_API_KEY` | Copied from local OpenCode credential store (`~/.local/share/opencode/opencode.db`, `zai-coding-plan`) | **Shared** with Z.ai Coding Plan in local OpenCode / ZCode. | Rotating in the Z.ai console requires updating both local OpenCode and `gh secret set ZHIPU_API_KEY -R Flame119052/agent-review`. |
| `NVIDIA_API_KEY` | Copied from local OpenCode credential store (`~/.local/share/opencode/opencode.db`, `nvidia`) | **Shared** with Nvidia NIM in local OpenCode. | Rotating in the Nvidia console requires updating both local OpenCode and `gh secret set NVIDIA_API_KEY -R Flame119052/agent-review`. |
| `SARVAM_API_KEY` | Copied from local OpenCode config (`~/.config/opencode/opencode.jsonc`, `sarvam`) | **Shared** with Sarvam in local OpenCode. | Rotating in the Sarvam console requires updating both `~/.config/opencode/opencode.jsonc` and `gh secret set SARVAM_API_KEY -R Flame119052/agent-review`. |
| `REVIEW_TARGET_TOKEN` | Fine-grained GitHub PAT (all repos: Actions/Contents read; Issues/PRs read-write) | **Hub-only** | Regenerate/replace in GitHub Developer Settings, then `gh secret set REVIEW_TARGET_TOKEN -R Flame119052/agent-review`. |
| `CODEX_SECRET_ROTATOR_TOKEN` | Fine-grained GitHub PAT (`agent-review` only: Actions read, Secrets read-write; stored in `main`-only `codex-refresh` env) | **Hub-only** | Regenerate/replace in GitHub Developer Settings, then `gh secret set CODEX_SECRET_ROTATOR_TOKEN -R Flame119052/agent-review --env codex-refresh`. |
| `AGENT_REVIEW_DISPATCH_TOKEN` | Fine-grained GitHub PAT (`agent-review` only: Contents read-write; stored in each **calling** repo) | **Shared across calling repos** | Regenerate/replace, then update `AGENT_REVIEW_DISPATCH_TOKEN` in each connected calling repo. |

## 7. Security checklist for `Flame119052/agent-review`

Verify these repository settings on GitHub so the public hub stays locked down:

1. **Protect `main` (Settings → Rules → Rulesets):** block force-pushes, branch deletions, and direct pushes from non-admin tokens (important because `AGENT_REVIEW_DISPATCH_TOKEN` carries Contents write for `repository_dispatch`).
2. **Approve outside fork workflows (Settings → Actions → General → Fork pull request workflows):** select *Require approval for all outside collaborators*.
3. **Keep `codex-refresh` environment restricted to `main` only** (so `CODEX_SECRET_ROTATOR_TOKEN` can never be read by PRs or feature branches).
4. **Never add secrets to `tess-music` or other calling repos** once migrated — only `AGENT_REVIEW_DISPATCH_TOKEN` belongs in a calling repo.
5. **Private repos never run on GitHub's public runners** — the gate refuses `machine=github` for private repos and routes them only to your local watchers (`mac` → `omarchy` → `vps`).

