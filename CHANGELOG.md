# Changelog

All notable changes to this project are documented here. Versions follow [SemVer](https://semver.org/).

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
