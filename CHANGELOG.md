# Changelog

All notable changes to this project are documented here. Versions follow [SemVer](https://semver.org/).

## v1.3.0 (2026-11-17)

### Added

- **Smart DONE** — empty turns (no action tool, final text under `minWords`) are suppressed; meaningful turns append a compact action summary (subagent / writes / commands / errors / builds) with duplicate-line collapsing (`✎ path ×N`), read-only bash / query-tool filtering, and subagent excerpts from the task `<summary>` tag. Master switch `options.smartDone`.
- **`options.smartDoneOptions`** — tuning for Smart DONE: `showActions`, `maxLines`, `maxChars`, `minWords`, per-category `show.*` visibility, and replaceable `queryTools` / `queryPrefixes` / `readonlyBash` filter lists.
- **`perm.kind.doom_loop`** translation — opencode's doom-loop protection (repeated-failure guard) now renders as *Repeated failures* / *Повторные сбои* instead of the raw `Doom_loop`.

### Fixed

- **Frozen poller held the Telegram lock forever** — `kill(pid,0)` treats a STOPPED (state `T`) process as alive, so a suspended poller blocked all button presses until the stale lock was cleared. The lock file now stores `pid:heartbeat`; the holder refreshes it every 2s and `tryAcquireLock` reclaims a lock whose pid is dead or whose heartbeat is older than 30s (portable, no `/proc`).
- **Permission button silently dropped for a rapid second permission** — the session-keyed 1500ms throttle suppressed a *different* operation arriving right after the first. The throttle is now keyed by session + `toolMsgId`, so only repeats of the SAME operation are throttled; distinct permissions in the same session always notify.
- **Silent process crash from a handler exception** — the whole `event` hook is wrapped in try/catch (`EVENT THROW <type> :: <err>` to the debug log); an exception in any handler no longer kills the opencode process. `q.options` is guarded with `Array.isArray` before `.map` / `.forEach`.
- **I/O flood from per-part `flushDbg`** — removed the debug-file flush on every `message.part.updated` (streaming text = hundreds of writes per turn); msgpart lines are buffered and flushed at `session.idle`.

### Docs

- **AGENTS.md** — gotchas 13 (frozen poller + heartbeat), 14 (shared debug log overwritten by the last flusher), 15 (never remove the event-hook try/catch); Smart DONE note; PID+heartbeat lock in the architecture section.
- **README / README.ru.md** — Smart DONE feature, `smartDoneOptions` settings reference, `perm.kind.doom_loop`, PID+heartbeat lock.

## v1.2.0 (2026-10-22)

### Fixed

- **«Устарело» toast on permission/question buttons with several opencode instances** — the shared `telegram-pending.json` / `telegram-pending-perm.json` files are now the single source of truth: every lookup (button presses, `processAnswered`, dedup, replied-handlers) re-reads the file and every mutation goes through `mutateJsonFile()` (read-modify-write); the in-memory pending maps were removed. Previously two instances overwrote each other's records, so a press hit a vanished record → `cb.stale` («устарело»). Now a button is answered regardless of which instance polls Telegram.
- **Stale records after re-ask** — in `permission.replied`, a record found by its updated `currentId` is now deleted properly (it used to be deleted by an empty key, leaving dead records in the file).

### Docs

- **AGENTS.md** — gotcha 10 documents the multi-instance shared-file rule, plus a note about the future opencode permission-protocol rewrite (post-1.19.x).

## v1.1.0 (2026-10-19)

### Changed

- **`format` placeholders split** — `{project}` is now only the project emoji; the raw project name moved to `{project_text}`, and the Telegram-filter hashtag to `{project_hashtag}`. Default templates render exactly as before. Custom templates that used `{project}` must be updated to `{project} {project_text}` (add `{project_hashtag}` for hashtags).
- **Permission kinds translated** — `External_directory` / `External_file` no longer appear raw with an underscore; they render as *External folder* / *External file* via the `perm.kind.*` keys, overridable in `telegram-notify-lang.json`.

### Added

- **`install.sh` version pinning** — install a specific release by git tag: `bash install.sh --version=<tag>` or `VERSION=<tag> bash install.sh` (handy to roll back to a v1-compatible plugin when upgrading to opencode v2).
- **Detailed `format` documentation** in README — full placeholder list, default templates and examples.

## v1.0.0 (2026-10-18) — initial release

- Notifications: task completion, errors, permission requests with Once/Always/Reject buttons, agent questions with option buttons, free-text answers
- Bot commands (`/help`, `/status`, `/mute`, `/unmute`, `/watch`, `/unwatch`, `/lang`), project filter, quiet hours, digest, `ru`/`en` languages, custom emojis/templates/translations
- Multi-instance: a single Telegram poller (PID lock), answers handled by the owning instance
