# Agent Review

Tag a pull request or an issue to get a read-only AI review. The hub reads the request from GitHub, checks who asked and what commit passed CI, then posts the result back to the same conversation.

```text
@review pr provider=codex model=gpt-6.1-sol effort=high author=none
@review approach provider=claude model=claude-opus-5-5 author=codex
```

Use `pr` to review a change or `approach` to review a plan. Put the request on its own line. Set `author=none` for a human author or name the provider that wrote the change. You can add `prompt="Check the rollback path"`. Existing `@tess-review` tags work too.

## Where it runs

- Public repositories default to a GitHub-hosted runner. Set `machine=mac`, `machine=omarchy`, or `machine=vps` to use a watcher.
- Private repositories use a watcher. With `machine=auto` or no machine specified, the hub picks the first machine reporting within 30 minutes in this order. It tries Mac, then Omarchy, then VPS. A request is refused if all three are offline. An explicit machine request queues for that machine.
- A queued comment tells you which machine received the request. The watcher opens a T3 thread and posts the checked verdict back to GitHub. Keep your provider’s data policy in mind for any private review. The chosen provider still receives the review input.

Connect a repository or migrate Tess with the [setup guide](SETUP.md). See [review rules](docs/workflow.md) for model and CI settings.

## Run the checks

Use Node.js 22 or newer with Git, Bash, and GitHub CLI.

```sh
bash -n tools/agent-gate.sh
node --test tools/test-*.mjs
```

The review tools were adapted from Tess Music under the [MIT license](LICENSE).

## Quick reference for agent skills and calling repos

Once a repository has `.github/workflows/agent-review.yml` (copied from `connector/agent-review-caller.yml`) and the `AGENT_REVIEW_DISPATCH_TOKEN` secret, any allowlisted account or agent posting under it can request a review by commenting on a pull request or issue:

```text
@review pr provider=opencode model=zai-coding-plan/glm-5.4 effort=high author=codex
GLM-5.4 on Z.ai; change written by Codex.
```

- **Public repositories** run automatically on GitHub's free unlimited `ubuntu-latest` VM inside `bubblewrap`.
- **Private repositories** never run on public GitHub runners; the hub automatically queues them for the highest-priority online local machine (`mac` → `omarchy` → `vps`) based on live usage snapshots.
- `@tess-review` is also accepted as an alias for `@review`.
