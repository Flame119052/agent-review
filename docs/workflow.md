# Review rules

## Choosing a reviewer

Plans only. The agent decides; the job only checks and runs the provider and model in the tag. Nothing is substituted when the chosen model is disallowed, too weak for a sensitive change, out of quota, or from the author’s provider. Antigravity runs on the GitHub-hosted path.

## Per-repository settings

The hub reads `.github/review.json` from the target’s default branch. Without that file it tries `.github/agents.json`, then uses the hub catalog and generic defaults.

| Setting | Effect |
| --- | --- |
| `sensitivePaths` | Adds exact paths, directory prefixes, and globs such as `packages/*/credentials/**`. The hub also treats workflows and common security, auth, infrastructure, and signing paths as sensitive. |
| `docsOnlyExtensions` | Replaces the default list of `.md`, `.mdx`, `.rst`, and `.adoc`. |
| `requireCi` | Defaults to `true`. The latest `check.yml` pull request run on the head must pass where that workflow exists on the default branch. Otherwise the latest pull request run of each workflow reported for the exact head must pass, with at least one run. Set `false` only for a repository without a CI requirement. Docs-only changes then use a reviewer too. |
| `models` or `agents` | Restricts the built-in catalog. Use `models.allowed` or `agents.allowed` with provider keys and model lists. Existing top-level `allowed`, `strong`, and `efforts` work too. |
| `caps` | Overrides the matching fields in the hub catalog. |
| `omitDiffPaths` | Adds generated or vendored paths to omit from the inline diff. Sensitive matches get a bounded excerpt and a notice to inspect the original file in the copy. |

## How to update this configuration

Open [the built-in catalog](../.github/agents.json) for supported providers, model names, and effort values. Set project-specific rules in the target repository and update its default branch before requesting a review.

Every review has a hard cap on elapsed time. Hosted reviews have a 600 s wall clock by default, with provider-specific limits in the catalog. Local watchers apply a wait limit and drop the review if the thread has no verdict by then. Provider turn and token limits vary by CLI.

### Change what one review may spend

Use the target’s `caps` settings for time and usage limits. The OpenCode agent policy sets its hosted step limit. The watcher passes effort through T3’s model options and relies on the installed provider to support that option.

## Hosted isolation

The hosted runner accepts public targets. It unpacks a stripped copy, removes agent settings and links, and launches with bubblewrap. The hosted workflow probes user namespaces before starting the reviewer. Claude and Codex reach their plan endpoints through a per-review proxy. OpenCode receives only its selected connector key, with no key for Zen free. Antigravity receives a short-lived access token. The reviewer process never receives the GitHub token. Verdicts pass a token filter before posting.

The gate on GitHub reads target metadata, comments, CI and configuration for routing. It publishes no private target identifiers, body text, changed paths, or errors in hub job output. Private reviews run on the selected watcher and send their input to the chosen provider. Check the provider’s policy before sending confidential code. In particular, use a different route if your project prohibits a free provider from retaining inputs.
