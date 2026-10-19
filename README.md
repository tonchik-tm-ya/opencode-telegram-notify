# opencode-telegram-notify

Telegram notifications and remote control for [opencode](https://opencode.ai/).

Walk away from the computer — and keep everything under control from your phone:

- ✅ **Task completion** — with task description and duration
- ❌ **Errors** — error text
- 🟧 **Permission requests** — with "Once / Always / Reject" buttons: answer right from Telegram
- ❓ **Agent questions** — each option gets a button; press one and the agent continues
- ✍️ **Free-text answers** — reply to a question with text (via Reply, or just a message when exactly one question is pending)
- 💬 **Bot commands** — `/help`, `/status`, `/mute`, `/unmute`, `/watch`, `/unwatch`, `/lang`
- 🎨 **Configurable format** — your own emojis and message templates via config; built-in `ru`/`en` languages

## Requirements

- opencode v1 (tested on 1.19.0)
- A Telegram account

## Installation

### Quick install (install.sh)

One-command install from GitHub:

```bash
curl -sL https://raw.githubusercontent.com/tonchik-tm-ya/opencode-telegram-notify/master/install.sh | bash
```

Or clone the repository and run:

```bash
git clone https://github.com/tonchik-tm-ya/opencode-telegram-notify.git
cd opencode-telegram-notify && bash install.sh
```

The script copies the plugin to `~/.config/opencode/plugins/`, verifies the SHA-256 checksum when available (`telegram-notify.ts.sha256` in the repo), and creates the config from the example (an existing config is never overwritten).

### 1. Create a bot

1. Open Telegram, find **@BotFather**, send `/newbot`
2. Pick a name and username, copy the **token** (looks like `123456789:AAH...`)

### 2. Get chat_id

1. Send your bot any message (e.g. "hi")
2. Run:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
3. Find `"chat":{"id":<NUMBER>}` in the response — that's your `chatId`

### 3. Copy the plugin

```bash
mkdir -p ~/.config/opencode/plugins
cp telegram-notify.ts ~/.config/opencode/plugins/
```

### 4. Add config with credentials

```bash
cp telegram-notify.json.example ~/.config/opencode/telegram-notify.json
# edit it — put in your token and chatId
```

Or use environment variables (higher priority than the config file):

```bash
export OPENCODE_NOTIFY_TELEGRAM_BOT_TOKEN="123456789:AAH..."
export OPENCODE_NOTIFY_TELEGRAM_CHAT_ID="123456789"
```

### 5. Restart opencode

Plugins are loaded at startup. Done — the first notification arrives after any turn finishes.

## How it works

The plugin listens to opencode server events:

| Event | What arrives in Telegram |
|---|---|
| `session.idle` | `✅ <project> <session title> [agent] (last turn duration)` |
| `session.error` and others | `❌ <description> + error text` |
| `permission.asked` | `🟧 type + target folder` (extracted from the command) + **Once / Always / Reject** buttons |
| `question.asked` | `❓ question` + a button per option → the answer returns to opencode |

The session title is taken from `session.title` (when meaningful and not "New session"), otherwise — the first user message.

Replies go through opencode's internal HTTP client: question — `POST /question/<requestID>/reply` (the "Reject" button — `POST /question/<requestID>/reject`), permission — `POST /session/<sessionID>/permissions/<permissionID>`. Question URLs are built by hand — SDK path parameter substitution does not work.

**Multiple opencode instances:** one process polls Telegram (PID lock file); button presses and text answers are handled only by the instance they belong to (`chatId` and `ownerPid` checks), and the instance where a question/permission originated replies — via shared state files in the config directory.

**Security:** buttons are handled only for the `chatId` from the config; foreign chats are ignored. The token stays local in the config file (or env) and never enters the code.

## Fine tuning

- **Multi-select questions** (`multiple: true`) — toggle buttons: a press marks/unmarks an option; "✔️ Done" and "✕ Reject" sit in one row below
- **Free input** — text from Telegram is accepted both without Reply (when exactly one question is pending) and via Reply to the question message
- State file paths: the `~/.config/opencode/telegram-notify/` subdirectory (created automatically)

### Configuration

All format settings live in `~/.config/opencode/telegram-notify.json` (template: `telegram-notify.json.example`). Missing sections fall back to defaults:

- `language` — interface language: `"en"` (default) or `"ru"`
- `emojis` — custom emojis (`project`, `done`, `error`, `permission`, `question`, `reply`, `agent`)
- `format` — message templates with placeholders `{project}` `{task}` `{agent}` `{duration}` `{cost}` `{kind}` `{target}` `{question_text}` `{answer}` `{decision}` `{error_text}` (values are HTML-escaped)
- `notify` — enable/disable notification types: `done`, `errors`, `permissions`, `questions`
- `projects` — filter by project name: `include` (only these) and `exclude` (except these)
- `quietHours` — quiet hours `{ "from": 23, "to": 8 }` (range across midnight); only DONE and errors are silenced, questions and permissions always arrive
- `digest` — batch DONE/errors into one message: `{ "enabled": true, "intervalMinutes": 15 }`
- `options` — `showCost` (cost in DONE), `questionTimeoutMinutes` (auto-reject stuck questions)

Custom translations: put key → string overrides into `~/.config/opencode/telegram-notify-lang.json` (template: `telegram-notify-lang.json.example`). They override the active language.

## Bot commands

| Command | Action |
|---|---|
| `/help` | List of commands |
| `/status` | State: enabled notifications, projects, digest, quiet hours, debug |
| `/mute <type>` | Disable a notification type (`done` \| `errors` \| `permissions` \| `questions`) |
| `/unmute <type>` | Enable a notification type |
| `/watch <project>` | Watch a project (add to `projects.include`) |
| `/unwatch <project>` | Stop watching a project |
| `/lang <ru\|en>` | Switch the interface language |

Commands are registered in the Telegram menu automatically on plugin start (`setMyCommands`) — they appear under the "/" button.

## Troubleshooting

- opencode log: `~/.local/share/opencode/log/opencode.log` (prefix `telegram-notify`)
- `401 Unauthorized` — wrong token; `400 chat not found` — wrong chatId
- Enable the verbose event log: add `"debug": true` to `~/.config/opencode/telegram-notify.json` (the log is written to `telegram-debug.log` in `~/.config/opencode/telegram-notify/`)

## License

MIT