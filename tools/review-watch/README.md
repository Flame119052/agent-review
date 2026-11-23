# Receive reviews on a machine

Run one watcher per machine. It reads the repositories you list for queue notices from the hub, then starts a T3 thread from a stripped copy of the checked commit. The watcher verifies the thread’s runtime mode and posts its finished verdict to GitHub.

On the VPS, use a dedicated non-root account with its own T3 data and GitHub sign-in. Never run the watcher as root beside Paperclip. Keep access to the review checkout and T3 history limited to the review account.

## Configure the watcher

Run these commands from the cloned hub repository. You need Node.js 22+, Git, GitHub CLI, and T3 running with the providers you plan to use.

```sh
gh auth status
gh auth setup-git
umask 077
mkdir -p "$HOME/.config/agent-review" "$HOME/.local/share/agent-review-watch/project"
git -C "$HOME/.local/share/agent-review-watch/project" init -q
git -C "$HOME/.local/share/agent-review-watch/project" \
  -c user.name='Agent Review' -c user.email='review@agent-review.invalid' \
  -c commit.gpgsign=false commit --allow-empty -qm 'Initialize review workspace'
t3 project add "$HOME/.local/share/agent-review-watch/project"
```

Set the T3 project’s default runtime mode to `approval-required`. Keep this project empty and use it only for reviews. The watcher clones target objects into scratch storage and deletes the original objects after building a filtered worktree. Reviewers should work inside that worktree. Leave any request from a reviewer to execute code, use the network, edit files, or read outside the copy unapproved.

Create `~/.config/agent-review/config.json`. Change `mac` to `omarchy` or `vps` on those machines. Set `queueLogin` to the GitHub account that owns the hub’s `REVIEW_TARGET_TOKEN`. The watcher accepts queue records from that account and checks they still match the live request. Its own GitHub sign-in also needs access to read and comment on each target.

```json
{
  "machine": "mac",
  "queueLogin": "Flame119052",
  "allowlist": ["Flame119052"],
  "slots": 2
}
```

The watcher uses the hub’s `AGENT_ALLOWLIST` when it can read it. The local list is a fallback. Keep it in sync. Put one repository per line in `~/.config/agent-review/repos.txt`, or set `REVIEW_WATCH_REPOS` to a comma-separated list.

```sh
printf '%s\n' Flame119052/tess-music Flame119052/kstack > "$HOME/.config/agent-review/repos.txt"
node tools/review-watch/watch.mjs check
```

A machine can poll public and private targets in the same tick. Cursor and request state are stored separately for each target. The machine’s slot limit applies across repositories. For automatic private routing, also run the [usage publisher](../usage-publish/README.md) on each machine you want considered online.

## Start the timer

Clone the hub at `$HOME/Developer/agent-review`, or update the installed timer’s path to match your checkout.

### Mac

```sh
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
plist="$HOME/Library/LaunchAgents/com.flame119052.agent-review-watch.plist"
sed "s|/Users/REPLACE_ME|$HOME|g" tools/review-watch/com.flame119052.agent-review-watch.plist > "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
```

### Omarchy or VPS

```sh
mkdir -p "$HOME/.config/systemd/user"
install -m 644 tools/review-watch/agent-review-watch.{service,timer} "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now agent-review-watch.timer
systemctl --user list-timers agent-review-watch.timer
```

Review details live in T3 and in the target’s GitHub conversation. On Linux, inspect the watcher log with `journalctl --user -u agent-review-watch.service`.
