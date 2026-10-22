# AGENTS.md — project context

Telegram bridge for opencode: notifications about tasks/errors/permissions + management (answers to questions and permissions) right from Telegram.

**WARNING — this context was gathered through many debugging cycles. Do not re-open these gotchas; read the "Gotchas" section.**

## Repo role

- **Here** — development
- **There** — deploy: `cp telegram-notify.ts ~/.config/opencode/plugins/`
- The plugin is auto-loaded by opencode from `~/.config/opencode/plugins/` at startup (it is NOT in `opencode.json` and should not be — local plugins are loaded from the directory automatically)
- After any change: copy the file → **restart opencode** → test

## What it does

| opencode event | Action |
|---|---|
| `session.idle` | `✅ <project> <session title> [agent] (last turn duration)` — description = session title (`title`) if meaningful and not "New session", otherwise the first user message; + project and agent names; duration = difference between the last and second-to-last messages |
| `session.error`, `session.execution.failed`, `session.step.failed` | `❌ <description> + error text` |
| `permission.asked` / `permission.v2.asked` | `🟧 operation type + target folder` (extracted from the command) + **Once / Always / Reject** buttons. Fix 2026-10-15: instead of the truncated command — the type (Bash/write/…) and the folder from the command end; for v2 — `action`/`resources`/`source` |
| `question.asked` | `❓ question` + a button per option → the answer returns to opencode, the agent continues |

## Architecture (1476 lines, single file, TS, runtime — Bun)

**Event format — KEY:** events arrive in v2 format — fields are nested in `properties`:
```
{ "type": "question.asked", "properties": { "id": "que_...", "sessionID": "...", "questions": [...] } }
```
The handler must use `const ev = event?.properties ?? event`, otherwise all fields are `undefined`.

**Question/permission flow (owner answers):**
1. `question.asked` event → send to Telegram with buttons (callback_data: `ocq:<requestID>:q<N>:o<M>` / `ocq:<requestID>:reject`; for permissions `ocp:<permissionID>:once|always|reject`), write a record to `telegram-pending.json` / `telegram-pending-perm.json` with `ownerPid` (pid of its own process).
2. Telegram polling (`getUpdates` long-polling) is done by **one** instance (PID lock file). On a press, the poller does **not** reply directly:
   - if it IS the owner (`ownerPid === process.pid`) — replies immediately with its own client;
   - otherwise it marks `answered` in the shared file.
3. A `setInterval(2s)` timer in each instance (`processAnswered`) handles marked records where `ownerPid === process.pid`, replying with **its own** client (the in-process server is the only one that knows the defer).

**All pending lookups and mutations are file-backed** (`readJsonFile`/`mutateJsonFile`) — the shared files are the single source of truth across instances, in-memory pending maps were removed (see gotcha 10).

**Replies to opencode** — via the internal openapi-fetch client `client._client.request(...)`:
- URL is built **by hand** (`"/question/" + encodeURIComponent(requestID) + "/reply"`)
- Result is `{ data, error, response }`, NOT a `Response` (check `!r.error && r.response?.ok`)

## Gotchas (earned in battle, don't repeat)

1. **`params.path` is NOT interpolated** in this client version — the server receives a literal `{requestID}` → 400. ALWAYS build the URL by hand.
2. **client baseUrl is empty** — the client works in-process (no TCP port). Don't try to read `client._client.baseUrl` for direct fetch — it's `""`. Reply only via `client._client.request`.
3. **`client.session.messages({ path: { id } })` from the SDK doesn't work** (same path issue) — for a task description use `raw.request({ method: "GET", url: "/session/<id>/message" })`, read `r?.data` (can be an array or `{ data: [...] }`).
4. **`permission.asked` may arrive twice for one operation** (same `tool.messageID`, different `per_` ids and callID — opencode re-asks). Dedupe by `toolMsgId`: don't send a second message, update `currentId` (the buttons answer the current request). In v2 the dedup field is `source.messageID` (in v1 — `tool.messageID`).
5. **Label race**: after our answer the server sends `question.replied`/`permission.replied` — the handler may overwrite our message with "(in terminal)". Set `selfAnswered` BEFORE replying; in the replied handler with `selfAnswered` — do not edit.
6. **Bun runtime**: without `@types/node`, `process`/`fs`/`setInterval` are unavailable in tsc — `declare const` at the top of the file is used for typing. Files are read/written via `Bun.file().text()` / `Bun.write()` (async!). `Bun.write` **creates parent directories itself** — mkdir is not needed; `Bun.mkdirSync` **does not exist** in Bun (the plugin would crash at startup with a TypeError).
7. **Telegram**: `parse_mode=HTML` (escape `& < >`); `callback_data` ≤ 64 bytes; handle only presses from your own `chatId`; `getUpdates` — long-polling with `timeout=30` and `offset` persisted to a file.
8. **DEBUG** — controlled from `telegram-notify.json` (field `"debug": true`); turn it on if you need an event log (`telegram-debug.log` + client dump `telegram-init.json`). With `DEBUG=true` and an empty buffer, the init dump can be overwritten by the `message.part.*` stream — it is filtered via `isInteresting()`.
9. **HTML escaping**: `tgSend` sends with `parse_mode=HTML`; any text with raw `<`/`>`/`&` (e.g. command help) → `400 can't parse entities`. Wrap all `renderTemplate` values and command replies in `escapeHtml`.
10. **Shared pending files across instances — the «устарело» bug (2026-10-21)**: several opencode instances may run at once; each loads the plugin and sees only ITS OWN session events. The PID lock protects only Telegram polling, NOT writes to the shared `telegram-pending*.json`. Keep the files the single source of truth: ALL lookups (button presses, `processAnswered`, dedup, replied-handlers) re-read the file, and ALL mutations go through `mutateJsonFile()` (read-modify-write). NEVER keep an in-memory snapshot and write it back — two instances overwriting each other's records made button presses hit vanished records → `cb.stale` toast («устарело»). Note: Bun 1.3.x has no `Bun.renameSync` (checked at runtime) — writes are not atomic; a torn write between instances is a theoretical accepted risk.

## Creds

- Priority: `OPENCODE_NOTIFY_TELEGRAM_BOT_TOKEN`/`OPENCODE_NOTIFY_TELEGRAM_CHAT_ID` (env) > `~/.config/opencode/telegram-notify.json` (`{ "botToken": "...", "chatId": "...", "debug": false, "language": "en" }`)
- **No credentials in code, ever.** All paths derive from `CONFIG_DIR = new URL("..", import.meta.url).pathname` (portable across users). Service files live in `DATA_DIR = CONFIG_DIR + "telegram-notify/"` (i.e. `~/.config/opencode/telegram-notify/`), the config `telegram-notify.json` sits in the root of `~/.config/opencode/`.
- Besides creds, the config holds sections `emojis`/`format`/`notify`/`projects`/`quietHours`/`digest`/`options`/`language`. Bot commands (`/mute`, `/watch`, `/lang`, ...) edit `cfg` in memory (only `notify`/`projects`/`language`) and persist via `saveCfg()` — other sections are not overwritten.
- Custom translations: `~/.config/opencode/telegram-notify-lang.json` (key → string, overrides the active language). Templates for colleagues: `telegram-notify.json.example`, `telegram-notify-lang.json.example`.

## Verification after changes

```bash
# typecheck (from ~/.config/opencode, where @opencode-ai/plugin resolves):
bunx tsc --noEmit --skipLibCheck --esModuleInterop --module esnext --moduleResolution bundler --target esnext plugins/telegram-notify.ts
# deploy:
cp telegram-notify.ts ~/.config/opencode/plugins/
# then: restart opencode → test
```

Test triggers:
- **DONE**: finish any turn — `✅ <description> (duration)` arrives
- **Question**: ask the agent to "ask me" (question tool) → press a button in Telegram → the agent continues
- **Permission**: write to a path outside granted permissions (e.g. `touch ~/perm-test-new-name` — use a FRESH path, previously granted ones won't ask) → buttons in Telegram. Note: sessions started with extended permissions don't ask at all.

## Repository

- Branch `master`. Commits — short, style as in history.

## Known limitations (conscious)

- Free-text answer from Telegram is implemented: accepted without Reply (when exactly one question is pending) and via Reply to the question message
- Duration in DONE = the last turn (difference between the last and second-to-last messages)
- **Future protocol risk (opencode dev, post-1.19.x)**: permissions were rewritten — new endpoint `POST /api/session/:sid/permission/:pid/reply` with body `{decision: "once"|"always"|"reject"}` (instead of `/session/:sid/permissions/:pid` + `{response}`), `permission.v2.asked` event removed. `replyPermission()` still works on 1.19.3; adapt it when updating opencode past that rewrite.