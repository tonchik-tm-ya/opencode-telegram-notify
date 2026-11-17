// Telegram bridge for opencode (v1).
// 1) Notifications: task completion (with description), errors, permission requests.
// 2) Questions: agent question (question tool) arrives in Telegram with option buttons;
//    a button press goes back to opencode (POST /question/{requestID}/reply) — agent continues.
// Auto-loaded from ~/.config/opencode/plugins/ on opencode start (runtime: Bun).
// @ts-ignore
import type { Plugin } from "@opencode-ai/plugin";

declare const process: {
  env: Record<string, string | undefined>;
  pid: number;
  kill(pid: number, signal: number): void;
};
declare const setInterval: (cb: () => void, ms: number) => unknown;
declare const Bun: {
  file(path: string): { text(): Promise<string> };
  write(path: string, data: string): Promise<number>;
};

// Creds: env (OPENCODE_NOTIFY_TELEGRAM_BOT_TOKEN / OPENCODE_NOTIFY_TELEGRAM_CHAT_ID) > file ~/.config/opencode/telegram-notify.json.
// No hardcoded values in code — the plugin is portable.
let BOT_TOKEN = process.env.OPENCODE_NOTIFY_TELEGRAM_BOT_TOKEN ?? "";
let CHAT_ID = process.env.OPENCODE_NOTIFY_TELEGRAM_CHAT_ID ?? "";

const THROTTLE_MS = 1500;
const MAX_TASK_LEN = 256;

// ---------- smart DONE config (options.smartDoneOptions) ----------
interface SmartDoneShowCfg { subagent?: boolean; write?: boolean; command?: boolean; error?: boolean; build?: boolean; }
interface SmartDoneOptionsCfg {
  showActions?: boolean; maxLines?: number; maxChars?: number; minWords?: number;
  show?: SmartDoneShowCfg;
  queryTools?: string[]; queryPrefixes?: string[]; readonlyBash?: string[];
}
interface SmartDoneResolved {
  showActions: boolean; maxLines: number; maxChars: number; minWords: number;
  show: { subagent: boolean; write: boolean; command: boolean; error: boolean; build: boolean };
  queryTools: string[]; queryPrefixes: string[]; readonlyBash: string[];
}
const SUMMARY_MAX_ACCUM = 8; // how many lines to accumulate per turn (internal — not in config)
// Defaults mirror the previous hardcoded constants — no config ⇒ unchanged behavior.
const DEFAULT_SMART_DONE: SmartDoneResolved = {
  showActions: true, maxLines: 4, maxChars: 80, minWords: 12,
  show: { subagent: true, write: true, command: true, error: true, build: true },
  queryTools: ["read","grep","glob","webfetch","websearch_cited","supermemory","ast_grep_search","task_status","task_message","get_skill","get_version","ping","ide_diagnostics","ide_project_diagnostics","ide_open_file","ide_get_active_file","ide_get_project_modes"],
  queryPrefixes: ["get_","list_","ide_find_","ide_search_","ide_symbol_","ide_get_","ide_project_","ide_index_","ide_type_hierarchy","ide_call_hierarchy","ide_file_structure","ide_read_file","ide_lifecycle_","openrouter_list-","openrouter_get-","openrouter_search-docs","openrouter_ping","openrouter_transcribe-","gh_grep_","figma_get_","list_mcp_","read_mcp_","playwright_browser_snapshot","playwright_browser_find","playwright_browser_console_","playwright_browser_network_","playwright_browser_navigate","playwright_browser_tabs","playwright_browser_emulate_media","playwright_browser_resize","playwright_browser_wait_for","playwright_browser_handle_dialog"],
  readonlyBash: [
    "git status","git diff","git log","git show","git ls-files","git grep","git blame","git branch","git tag","git remote","git rev-parse","git stash list",
    "grep ","rg ","ls ","cat ","head ","tail ","wc ","find ","which ","pwd ","echo ","printf ","ps ","df ","du ","env ","date ","whoami ","hostname ","test ",
  ],
};
let smartDoneCfg: SmartDoneResolved = DEFAULT_SMART_DONE;

function resolveSmartDone(o?: SmartDoneOptionsCfg): SmartDoneResolved {
  const src = (o ?? {}) as Record<string, unknown>;
  const show = (src.show ?? {}) as Record<string, unknown>;
  return {
    showActions: src.showActions !== false,
    maxLines: Math.max(1, Number(src.maxLines ?? DEFAULT_SMART_DONE.maxLines)),
    maxChars: Math.max(1, Number(src.maxChars ?? DEFAULT_SMART_DONE.maxChars)),
    minWords: Math.max(1, Number(src.minWords ?? DEFAULT_SMART_DONE.minWords)),
    show: {
      subagent: show.subagent !== false,
      write: show.write !== false,
      command: show.command !== false,
      error: show.error !== false,
      build: show.build !== false,
    },
    queryTools: Array.isArray(src.queryTools) ? src.queryTools as string[] : DEFAULT_SMART_DONE.queryTools,
    queryPrefixes: Array.isArray(src.queryPrefixes) ? src.queryPrefixes as string[] : DEFAULT_SMART_DONE.queryPrefixes,
    readonlyBash: Array.isArray(src.readonlyBash) ? src.readonlyBash as string[] : DEFAULT_SMART_DONE.readonlyBash,
  };
}

// All paths are relative to the opencode config dir (works for any user).
const CONFIG_DIR = new URL("..", import.meta.url).pathname; // …/.config/opencode/
const DATA_DIR = CONFIG_DIR + "telegram-notify/";
const PENDING_FILE = DATA_DIR + "telegram-pending.json";
const PERM_FILE = DATA_DIR + "telegram-pending-perm.json";
const STATE_FILE = DATA_DIR + "telegram-bridge-state.json";
const LOCK_FILE = DATA_DIR + "telegram-bridge.lock";
const DEBUG_FILE = DATA_DIR + "telegram-debug.log";
const INIT_FILE = DATA_DIR + "telegram-init.json";
const CRED_FILE = CONFIG_DIR + "telegram-notify.json";

async function loadCreds(): Promise<void> {
  try {
    const raw = JSON.parse(await Bun.file(CRED_FILE).text()) as PluginCfg;
    cfg = raw;
    customLang = await loadCustomLang();
    BOT_TOKEN = BOT_TOKEN || String(raw.botToken ?? "");
    CHAT_ID = CHAT_ID || String(raw.chatId ?? "");
    DEBUG = Boolean(raw.debug ?? false);
  } catch {
    /* no config file — keep env */
  }
}

function emoji(key: keyof EmojisCfg): string {
  return cfg.emojis?.[key] ?? DEFAULT_EMOJIS[key];
}
function fmt(key: keyof FormatCfg): string {
  return cfg.format?.[key] ?? DEFAULT_FORMAT[key];
}
function notifyEnabled(key: keyof NotifyCfg): boolean {
  return cfg.notify?.[key] ?? DEFAULT_NOTIFY[key];
}
function projectAllowed(name: string): boolean {
  const p = cfg.projects ?? DEFAULT_PROJECTS;
  if (p.exclude?.includes(name)) return false;
  if (p.include?.length) return p.include.includes(name);
  return true;
}

// Current hour falls inside quiet hours (from > to — crosses midnight, e.g. 23→8).
function isQuietHour(): boolean {
  const q = cfg.quietHours;
  if (!q || typeof q.from !== "number" || typeof q.to !== "number") return false;
  const h = new Date().getHours();
  return q.from <= q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

// Save config: re-read the file and overlay sections changed by bot commands
// (notify/projects/language), leaving the rest intact (emojis/format/... may be
// edited by hand after plugin start — must not be overwritten).
async function saveCfg(): Promise<void> {
  try {
    let file: PluginCfg = {};
    try {
      file = JSON.parse(await Bun.file(CRED_FILE).text()) as PluginCfg;
    } catch {
      /* no file — start from empty */
    }
    const merged: PluginCfg = { ...file };
    if (cfg.notify) merged.notify = cfg.notify;
    if (cfg.projects) merged.projects = cfg.projects;
    if (cfg.language) merged.language = cfg.language;
    await Bun.write(CRED_FILE, JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error("telegram-notify: save cfg failed", err);
  }
}

function tgBase(): string {
  return "https://api.telegram.org/bot" + BOT_TOKEN;
}

// Register bot commands in the menu (setMyCommands) — visible in Telegram via the "/" button.
async function registerCommands(): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    await fetch(tgBase() + "/setMyCommands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "status", description: t("menu.status") },
          { command: "mute", description: t("menu.mute") },
          { command: "unmute", description: t("menu.unmute") },
          { command: "watch", description: t("menu.watch") },
          { command: "unwatch", description: t("menu.unwatch") },
          { command: "lang", description: t("menu.lang") },
          { command: "help", description: t("menu.help") },
        ],
      }),
    });
  } catch (err) {
    console.error("telegram-notify: setMyCommands failed", err);
  }
}

// ---------- debug (off by default; with DEBUG=true logs only meaningful events) ----------

let DEBUG = false;
const debugLines: string[] = [];

function dbg(line: string): void {
  if (!DEBUG) return;
  debugLines.push(new Date().toISOString() + " " + line);
  if (debugLines.length > 1000) debugLines.shift();
}

async function flushDbg(): Promise<void> {
  if (!DEBUG) return;
  try {
    await Bun.write(DEBUG_FILE, debugLines.join("\n") + "\n");
  } catch {
    /* non-critical */
  }
}

// Write the init dump separately — so the event stream doesn't overwrite it.
async function dumpInit(data: unknown): Promise<void> {
  if (!DEBUG) return;
  try {
    await Bun.write(INIT_FILE, JSON.stringify(data, null, 2));
  } catch {
    /* non-critical */
  }
}

// Interesting events (message.* streams constantly — they are not logged).
function isInteresting(type: string): boolean {
  return (
    type === "session.idle" ||
    type === "session.error" ||
    type.startsWith("session.execution.") ||
    type.startsWith("session.step.") ||
    type.startsWith("permission.") ||
    type.startsWith("question.") ||
    type === "tui.toast.show"
  );
}

// ---------- types and state ----------

interface QOption {
  label: string;
  description?: string;
}
interface QInfo {
  question: string;
  header?: string;
  options?: QOption[];
  multiple?: boolean;
  custom?: boolean;
}
interface PendingReq {
  items: Array<{ q: QInfo; msgId: number; selected?: string[]; answer?: string[] }>;
  project?: string; // project name (raw, no emoji)
  createdAt?: number; // creation ts (for question timeout)
  ownerPid?: number; // pid of the instance holding the question defer
  answered?: { reject?: boolean; complete?: boolean }; // final state set by a NON-owner poller for the owner to reply
  selfAnswered?: boolean; // answered via a Telegram button — don't overwrite with question.replied label
}
interface PendingPerm {
  sessionID: string;
  msgId: number;
  permission: string;
  project?: string; // project name (raw, no emoji)
  target?: string; // 📝 string (target path)
  ownerPid?: number;
  answered?: string; // "once" | "always" | "reject"
  selfAnswered?: boolean;
  currentId?: string; // current permId (updated when the same op is asked again)
  toolMsgId?: string; // operation messageID — dedup key
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

// Tolerant read: missing/corrupt file → fallback.
async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Bun.file(path).text()) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  try {
    await Bun.write(path, JSON.stringify(data));
  } catch (err) {
    console.error("telegram-notify: save state failed", err);
  }
}

// Read-modify-write a JSON file — the file is the SINGLE source of truth for
// pending questions/permissions (multiple opencode instances share it).
// All searches and mutations go through this helper; in-memory snapshots are
// never written back. Write is NOT atomic: Bun 1.3.x has no Bun.renameSync
// (checked at runtime) — a torn write is possible when two instances write
// concurrently, but read-modify-write keeps the file consistent between ops.
async function mutateJsonFile<T>(path: string, fn: (data: T) => void): Promise<void> {
  try {
    const data = await readJsonFile<T>(path, {} as T);
    fn(data);
    await Bun.write(path, JSON.stringify(data));
  } catch (err) {
    console.error("telegram-notify: mutate json failed", err);
  }
}

let pollOffset = 0;
let stateLoaded = false;

async function ensureState(): Promise<void> {
  if (stateLoaded) return;
  pollOffset = (await readJsonFile(STATE_FILE, { offset: 0 })).offset ?? 0;
  stateLoaded = true;
}

// Only one opencode instance polls Telegram (lock file with PID + heartbeat).
// kill(pid,0) succeeds for stopped/zombie processes, so a FROZEN poller (state T)
// holds the lock forever and blocks all button presses (permission buttons died
// because the sole poller was suspended). A heartbeat timestamp lets a new
// instance reclaim a lock whose holder has stopped heartbeating (frozen/crashed).
const LOCK_HEARTBEAT_STALE_MS = 30000; // holder idle longer than this → lock is stale
async function writeHeartbeatLock(): Promise<void> {
  try { await Bun.write(LOCK_FILE, String(process.pid) + ":" + Date.now()); } catch { /* non-critical */ }
}
async function tryAcquireLock(): Promise<boolean> {
  try {
    const cur = (await Bun.file(LOCK_FILE).text()).trim();
    const [pidStr, hbStr] = cur.split(":");
    const pid = Number(pidStr);
    if (cur && pid > 0) {
      let pidAlive = false;
      try { process.kill(pid, 0); pidAlive = true; } catch { /* dead */ }
      const hb = Number(hbStr);
      const hbKnown = Number.isFinite(hb) && hb > 0;
      const hbStale = hbKnown && Date.now() - hb > LOCK_HEARTBEAT_STALE_MS;
      // Healthy = pid alive AND (heartbeat unknown → trust pid, or heartbeat fresh).
      if (pidAlive && !hbStale) return false; // another healthy instance is polling
      // else: pid dead OR heartbeat stale (frozen holder) → take over
    }
  } catch {
    /* no lock / unreadable → take over */
  }
  try {
    await Bun.write(LOCK_FILE, String(process.pid) + ":" + Date.now());
    return true;
  } catch {
    return false;
  }
}

// ---------- small helpers ----------

const lastSent = new Map<string, number>();

// DONE/errors pile up in the buffer when digest is on; interactive messages always go immediately.
let digestBuf: string[] = [];
let lastDigestFlush = Date.now();
const DIGEST_MAX = 3800; // Telegram single-message length limit

async function sendOrDigest(text: string, digestable: boolean): Promise<number | null> {
  if (digestable && cfg.digest?.enabled) {
    digestBuf.push(text);
    return null;
  }
  return tgSend(text);
}

// Flush the buffer every intervalMinutes (called from the 2s timer).
async function flushDigest(): Promise<void> {
  if (!cfg.digest?.enabled || !digestBuf.length) return;
  const intervalMs = (cfg.digest.intervalMinutes ?? 15) * 60_000;
  if (Date.now() - lastDigestFlush < intervalMs) return;
  const text = digestBuf.join("\n\n");
  digestBuf = [];
  lastDigestFlush = Date.now();
  for (let i = 0; i < text.length; i += DIGEST_MAX) {
    await tgSend(text.slice(i, i + DIGEST_MAX));
  }
}

function throttle(key: string): boolean {
  const now = Date.now();
  if (lastSent.has(key) && now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return true;
  lastSent.set(key, now);
  return false;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? m + "m " + r + "s" : m + "m";
}

function truncate(s: string, max: number = MAX_TASK_LEN): string {
  const t = String(s).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

// Action name for the message header: "Bash(<command>)" → "Bash";
// known snake_case permission types ("External_directory(...)") are translated via t()
// (keys "perm.kind.<type>", overridable in telegram-notify-lang.json); others — a short truncation.
function permissionKind(s: string): string {
  const raw = String(s ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/^([A-Za-z]+)\(/);
  if (m) return m[1];
  const key = "perm.kind." + raw.split(/[:(]/)[0].toLowerCase();
  const label = t(key);
  return label !== key ? label : truncate(raw, 40).replace(/^./, (c) => c.toUpperCase());
}

// Extract the target path from a command/string: the last path-like token (not a flag).
function extractPath(text: string): string {
  const inner = String(text ?? "").replace(/^[A-Za-z]+\((.+)\)$/, "$1").trim();
  if (!inner) return "";
  const tokens = inner.split(/\s+/).filter(Boolean);
  let last = "";
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i].replace(/[;|&<>'")\]]+$/, "").replace(/^["'(]+/, "");
    if (!tok || tok.startsWith("-") || /[<>]/.test(tok)) continue;
    last = tok;
    break;
  }
  if (!last) return "";
  if (last.includes("/") || last.startsWith("~") || last.startsWith(".")) return last;
  return "";
}

// Truncation keeping the TAIL of the string (the path/folder is usually there).
// Trailing redirects ("2>/dev/null", ">/dev/null", "2>&1") are dropped.
function truncateTail(s: string, max: number): string {
  const tokens = String(s).replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean);
  while (tokens.length && /[<>]/.test(tokens[tokens.length - 1])) tokens.pop();
  const t = tokens.join(" ");
  if (t.length <= max) return t;
  return "…" + t.slice(-(max - 1));
}

// opencode server's own baseUrl (for routing question replies).
function getClientBase(client: AnyClient): string {
  try {
    const v =
      client?._client?.baseUrl ??
      client?._client?.config?.baseUrl ??
      client?._client?.options?.baseUrl ??
      client?.baseUrl ??
      client?.config?.baseUrl ??
      client?.options?.baseUrl ??
      "";
    return String(v);
  } catch {
    return "";
  }
}

// ---------- sending to Telegram ----------

interface TgButton {
  text: string;
  callback_data: string;
}

async function tgSend(text: string, buttons?: TgButton[][]): Promise<number | null> {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  const fields: Record<string, string> = { chat_id: CHAT_ID, parse_mode: "HTML", text };
  if (buttons && buttons.length) fields.reply_markup = JSON.stringify({ inline_keyboard: buttons });
  try {
    const r = await fetch(tgBase() + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    if (!r.ok) {
      console.error("telegram-notify: sendMessage", r.status);
      dbg("sendMessage FAIL status=" + r.status);
      return null;
    }
    dbg("sendMessage OK");
    const j = (await r.json().catch(() => null)) as { result?: { message_id?: number } } | null;
    return j?.result?.message_id ?? null;
  } catch (err) {
    console.error("telegram-notify: sendMessage failed", err);
    dbg("sendMessage THROW " + String(err));
    return null;
  }
}

// Telegram returns 400 "message is not modified" when the new text/markup is identical to the
// current one. These finalize/redraw edits are idempotent, and with multiple opencode instances
// a redundant identical edit (a duplicate by a neighbor/another path) is expected — treat it as
// success instead of logging a scary 400.
async function isBenignEdit400(r: Response): Promise<boolean> {
  if (r.status !== 400) return false;
  try {
    return /message is not modified/i.test(await r.text());
  } catch {
    return false;
  }
}

async function tgEdit(msgId: number, text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const r = await fetch(tgBase() + "/editMessageText", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        chat_id: CHAT_ID,
        message_id: String(msgId),
        parse_mode: "HTML",
        text,
      }),
    });
    if (!r.ok && !(await isBenignEdit400(r))) console.error("telegram-notify: editMessageText", r.status);
  } catch (err) {
    console.error("telegram-notify: editMessageText failed", err);
  }
}

// Redraw a message's inline keyboard (e.g. checkmarks on selected options).
async function tgEditButtons(msgId: number, buttons: TgButton[][]): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const r = await fetch(tgBase() + "/editMessageReplyMarkup", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        chat_id: CHAT_ID,
        message_id: String(msgId),
        reply_markup: JSON.stringify({ inline_keyboard: buttons }),
      }),
    });
    if (!r.ok && !(await isBenignEdit400(r))) console.error("telegram-notify: editMessageReplyMarkup", r.status);
  } catch (err) {
    console.error("telegram-notify: editMessageReplyMarkup failed", err);
  }
}

async function answerCallback(cbId: string, text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await fetch(tgBase() + "/answerCallbackQuery", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ callback_query_id: cbId, text }),
    });
  } catch {
    /* non-critical */
  }
}

// ---------- button presses ----------

// Button data format: "ocq:<requestID>:q<N>:o<M>" or "ocq:<requestID>:reject".
function parseCallbackData(data: string): { rid: string; qIdx: number; optIdx: number; done?: boolean } | "reject" | null {
  if (!data.startsWith("ocq:")) return null;
  const parts = data.slice(4).split(":");
  if (parts.length < 2) return null;
  const rid = parts[0];
  if (parts[1] === "reject") return "reject";
  if (parts.length !== 3) return null;
  const qIdx = Number(parts[1].replace(/^q/, ""));
  if (!Number.isFinite(qIdx)) return null;
  if (parts[2] === "done") return { rid, qIdx, optIdx: -1, done: true };
  const optIdx = Number(parts[2].replace(/^o/, ""));
  if (!Number.isFinite(optIdx)) return null;
  return { rid, qIdx, optIdx, done: false };
}

// answers === null → reject. URL is built by hand — params.path doesn't work in this client version.
async function replyToQuestion(client: AnyClient, requestID: string, answers: string[][] | null): Promise<boolean> {
  try {
    const raw = (client?._client as AnyClient | undefined) ?? client;
    if (!raw?.request) return false;
    const path = "/question/" + encodeURIComponent(requestID) + (answers ? "/reply" : "/reject");
    const r = await raw.request({
      method: "POST",
      url: path,
      body: answers ? { answers } : undefined,
    });
    const ok = !r?.error && (r?.response?.ok ?? true);
    dbg("REPLY " + requestID + " ok=" + ok + " err=" + JSON.stringify(r?.error ?? null).slice(0, 120));
    await flushDbg();
    return ok;
  } catch (err) {
    console.error("telegram-notify: question reply failed", err);
    dbg("REPLY THROW " + String(err));
    await flushDbg();
    return false;
  }
}

async function handleCallback(client: AnyClient, cq: Record<string, unknown>): Promise<void> {
  const msg = cq.message as { chat?: { id?: number }; message_id?: number } | undefined;
  if (!msg?.chat?.id || String(msg.chat.id) !== CHAT_ID) return; // ignore foreign chats
  const data = String(cq.data ?? "");
  const msgId = Number(msg.message_id ?? 0);
  const cbId = String(cq.id ?? "");
  dbg("CALLBACK data=" + data + " cbId=" + cbId.slice(0, 8));

  // --- permissions: "ocp:<permissionID>:once|always|reject" ---
  if (data.startsWith("ocp:")) {
    const parts = data.slice(4).split(":");
    const permId = parts[0];
    const response = parts[1];
    if (response !== "once" && response !== "always" && response !== "reject") {
      await answerCallback(cbId, t("cb.stale"));
      return;
    }
    // Lookup in the shared file (single source of truth) — not in memory.
    const p = (await readJsonFile<Record<string, PendingPerm>>(PERM_FILE, {}))[permId];
    if (!p) {
      await answerCallback(cbId, t("cb.stale"));
      return;
    }
    // Another instance is polling — mark the answer, the owner replies with its own client.
    if (p.ownerPid && p.ownerPid !== process.pid) {
      await mutateJsonFile<Record<string, PendingPerm>>(PERM_FILE, (m) => {
        const rec = m[permId];
        if (rec) rec.answered = response;
      });
      await answerCallback(cbId, t("cb.accepted"));
      return;
    }
    await mutateJsonFile<Record<string, PendingPerm>>(PERM_FILE, (m) => {
      const rec = m[permId];
      if (rec) rec.selfAnswered = true;
    });
    const ok = await replyPermission(client, p.currentId ?? permId, p.sessionID, response);
    if (ok) {
      const label = t("perm.decision." + response);
      await tgEdit(msgId, renderTemplate(fmt("permission_done"), {
        ...projectVars(p.project),
        permission: emoji("permission"),
        kind: permissionKind(p.permission) || t("perm.kindFallback"),
        reply: p.target ? emoji("reply") : "",
        target: p.target ?? "",
        decision: label,
      }));
      await mutateJsonFile<Record<string, PendingPerm>>(PERM_FILE, (m) => { delete m[permId]; });
    }
    await answerCallback(cbId, ok ? t("cb.done") : t("cb.errSend"));
    return;
  }

  const parsed = parseCallbackData(data);
  if (!parsed) {
    await answerCallback(cbId, t("cb.unknown"));
    return;
  }

  const pending = await readJsonFile<Record<string, PendingReq>>(PENDING_FILE, {});

  if (parsed === "reject") {
    const rid = data.slice(4).split(":")[0];
    const req = pending[rid];
    if (!req) {
      await answerCallback(cbId, t("cb.stale"));
      return;
    }
    if (req.ownerPid && req.ownerPid !== process.pid) {
      await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
        const r = m[rid];
        if (r) r.answered = { reject: true };
      });
      for (const it of req.items) await tgEdit(it.msgId, t("q.rejected"));
      await answerCallback(cbId, t("cb.accepted"));
      return;
    }
    await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
      const r = m[rid];
      if (r) r.selfAnswered = true;
    });
    const ok = await replyToQuestion(client, rid, null);
    if (ok) for (const it of req.items) await tgEdit(it.msgId, t("q.rejected"));
    await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => { delete m[rid]; });
    await answerCallback(cbId, ok ? t("cb.rejected") : t("cb.errSend"));
    return;
  }

  const req = pending[parsed.rid];
  const q = req?.items[parsed.qIdx]?.q;
  if (!req || !q) {
    await answerCallback(cbId, t("cb.questionStale"));
    return;
  }
  // A final decision (all answered / rejected) is already recorded — no further per-question work.
  if (req.answered) {
    await answerCallback(cbId, t("cb.questionStale"));
    return;
  }

  // "Done" button (multi-select): finalize THIS question's selection; reply only when ALL are answered.
  if (parsed.done) {
    const selected = req.items[parsed.qIdx]?.selected ?? [];
    if (!selected.length) {
      await answerCallback(cbId, t("cb.pickFirst"));
      return;
    }
    if (req.items[parsed.qIdx]?.answer) {
      await answerCallback(cbId, t("cb.questionStale"));
      return;
    }
    if (req.ownerPid && req.ownerPid !== process.pid) {
      await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
        const r = m[parsed.rid];
        if (!r || !r.items[parsed.qIdx]) return;
        r.items[parsed.qIdx].answer = selected;
        if (r.items.every((it) => it.answer)) r.answered = { complete: true };
      });
      await tgEdit(msgId, renderTemplate(fmt("question_done"), {
        ...projectVars(req.project),
        done: emoji("done"),
        question_text: truncate(q.question),
        "q.answer": t("q.answer", { answer: selected.join(", ") }),
      }));
      await answerCallback(cbId, t("cb.accepted"));
      return;
    }
    await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
      const r = m[parsed.rid];
      if (!r || !r.items[parsed.qIdx]) return;
      r.selfAnswered = true;
      r.items[parsed.qIdx].answer = selected;
    });
    await tgEdit(msgId, renderTemplate(fmt("question_done"), {
      ...projectVars(req.project),
      done: emoji("done"),
      question_text: truncate(q.question),
      "q.answer": t("q.answer", { answer: selected.join(", ") }),
    }));
    const upd = (await readJsonFile<Record<string, PendingReq>>(PENDING_FILE, {}))[parsed.rid];
    if (!upd) {
      await answerCallback(cbId, t("cb.questionStale"));
      return;
    }
    if (upd.items.every((it) => it.answer)) {
      const ok = await replyToQuestion(client, parsed.rid, upd.items.map((it) => it.answer ?? []));
      if (ok) await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => { delete m[parsed.rid]; });
      await answerCallback(cbId, ok ? t("cb.accepted") : t("cb.errSend"));
    } else {
      await answerCallback(cbId, t("cb.accepted"));
    }
    return;
  }

  const label = q?.options?.[parsed.optIdx]?.label;
  if (!label) {
    await answerCallback(cbId, t("cb.questionStale"));
    return;
  }

  // Pressing a multi-select option — toggle: select/deselect, no answer sent.
  if (q.multiple === true) {
    if (req.items[parsed.qIdx]?.answer) {
      await answerCallback(cbId, t("cb.questionStale"));
      return;
    }
    const wasSel = new Set(req.items[parsed.qIdx].selected ?? []).has(label);
    await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
      const it = m[parsed.rid]?.items?.[parsed.qIdx];
      if (!it) return;
      const sel = new Set(it.selected ?? []);
      if (wasSel) {
        sel.delete(label);
      } else {
        sel.add(label);
      }
      it.selected = [...sel];
    });
    await answerCallback(cbId, wasSel ? t("cb.unselected") : t("cb.selected"));
    // Redraw keyboards of all request questions (selected ones get a "✅" prefix).
    // Skip already-finalized siblings — their buttons are removed.
    const upd = (await readJsonFile<Record<string, PendingReq>>(PENDING_FILE, {}))[parsed.rid];
    if (!upd) return;
    for (let qi = 0; qi < upd.items.length; qi++) {
      const it = upd.items[qi];
      if (it.answer) continue;
      const btns: TgButton[][] = [];
      const selQ = new Set(it.selected ?? []);
      (it.q.options ?? []).forEach((o, oi) => {
        const t = selQ.has(o.label) ? "✅ " + truncate(o.label) : truncate(o.label);
        btns.push([{ text: t, callback_data: "ocq:" + parsed.rid + ":q" + qi + ":o" + oi }]);
      });
      if (it.q.multiple === true && btns.length) {
        btns.push([
          { text: t("btn.done"), callback_data: "ocq:" + parsed.rid + ":q" + qi + ":done" },
          { text: t("btn.reject"), callback_data: "ocq:" + parsed.rid + ":reject" },
        ]);
      } else if (btns.length) {
        btns.push([{ text: t("btn.reject"), callback_data: "ocq:" + parsed.rid + ":reject" }]);
      }
      await tgEditButtons(it.msgId, btns);
    }
    return;
  }

  // Regular question: record THIS question's answer; reply only once ALL questions are answered.
  if (req.items[parsed.qIdx]?.answer) {
    await answerCallback(cbId, t("cb.questionStale"));
    return;
  }
  if (req.ownerPid && req.ownerPid !== process.pid) {
    await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
      const r = m[parsed.rid];
      if (!r || !r.items[parsed.qIdx]) return;
      r.items[parsed.qIdx].answer = [label];
      if (r.items.every((it) => it.answer)) r.answered = { complete: true };
    });
    await tgEdit(msgId, renderTemplate(fmt("question_done"), {
      ...projectVars(req.project),
      done: emoji("done"),
      question_text: truncate(q.question),
      "q.answer": t("q.answer", { answer: label }),
    }));
    await answerCallback(cbId, t("cb.accepted"));
    return;
  }
  await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
    const r = m[parsed.rid];
    if (!r || !r.items[parsed.qIdx]) return;
    r.selfAnswered = true;
    r.items[parsed.qIdx].answer = [label];
  });
  await tgEdit(msgId, renderTemplate(fmt("question_done"), {
    ...projectVars(req.project),
    done: emoji("done"),
    question_text: truncate(q.question),
    "q.answer": t("q.answer", { answer: label }),
  }));
  const upd = (await readJsonFile<Record<string, PendingReq>>(PENDING_FILE, {}))[parsed.rid];
  if (!upd) {
    await answerCallback(cbId, t("cb.questionStale"));
    return;
  }
  if (upd.items.every((it) => it.answer)) {
    const ok = await replyToQuestion(client, parsed.rid, upd.items.map((it) => it.answer ?? []));
    if (ok) await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => { delete m[parsed.rid]; });
    await answerCallback(cbId, ok ? t("cb.accepted") : t("cb.errSend"));
  } else {
    await answerCallback(cbId, t("cb.accepted"));
  }
}

// Free-text answer to a question: the user replies (reply) to the question message
// in Telegram or just sends text when there is exactly one pending question.
async function handleTextMessage(client: AnyClient, msg: Record<string, unknown>): Promise<void> {
  const chat = msg.chat as { id?: number } | undefined;
  if (!chat?.id || String(chat.id) !== CHAT_ID) return; // only our chat
  const text = String(msg.text ?? "").trim();
  if (!text) return;
  if (text.startsWith("/")) {
    await handleCommand(text);
    return;
  }
  const replyTo = msg.reply_to_message as { message_id?: number } | undefined;
  const repliedMsgId = Number(replyTo?.message_id ?? 0);
  // Where the text goes: 1) reply to a question message — exact match;
  // 2) no reply — if exactly one unanswered question is pending (qIdx 0).
  const pending = await readJsonFile<Record<string, PendingReq>>(PENDING_FILE, {});
  let rid = "";
  let req: PendingReq | undefined;
  let qIdx = -1;
  if (repliedMsgId) {
    for (const [r, rq] of Object.entries(pending)) {
      const i = rq.items.findIndex((it) => it.msgId === repliedMsgId);
      if (i >= 0) { rid = r; req = rq; qIdx = i; break; }
    }
  }
  if (!req) {
    // Bare text (no reply): route it only when exactly ONE unanswered question exists anywhere.
    const open: Array<{ r: string; i: number }> = [];
    for (const [r, rq] of Object.entries(pending)) {
      if (rq.answered) continue;
      rq.items.forEach((it, i) => { if (!it.answer) open.push({ r, i }); });
    }
    if (open.length === 1) { rid = open[0].r; req = pending[rid]; qIdx = open[0].i; }
  }
  if (!req) { dbg("TEXT ignored: no pending question"); return; }
  dbg("TEXT reply=" + repliedMsgId + " q=" + qIdx + " text=" + text.slice(0, 60));
  const doneText = renderTemplate(fmt("question_done"), {
    ...projectVars(req.project),
    done: emoji("done"),
    question_text: truncate(req.items[qIdx].q.question),
    "q.answer": t("q.answer", { answer: text }),
  });
  if (req.ownerPid && req.ownerPid !== process.pid) {
    await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
      const r = m[rid];
      if (!r || !r.items[qIdx]) return;
      r.items[qIdx].answer = [text];
      if (r.items.every((it) => it.answer)) r.answered = { complete: true };
    });
    if (req.items[qIdx]) await tgEdit(req.items[qIdx].msgId, doneText);
    return;
  }
  await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
    const r = m[rid];
    if (!r || !r.items[qIdx]) return;
    r.selfAnswered = true;
    r.items[qIdx].answer = [text];
  });
  if (req.items[qIdx]) await tgEdit(req.items[qIdx].msgId, doneText);
  const upd = (await readJsonFile<Record<string, PendingReq>>(PENDING_FILE, {}))[rid];
  if (!upd) return;
  if (upd.items.every((it) => it.answer)) {
    const ok = await replyToQuestion(client, rid, upd.items.map((it) => it.answer ?? []));
    if (ok) await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => { delete m[rid]; });
  }
}

// Bot commands: /help /status /mute /unmute /watch /unwatch /lang.
async function handleCommand(text: string): Promise<void> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");
  if (!cfg.notify) cfg.notify = { ...DEFAULT_NOTIFY };
  const n = cfg.notify;
  switch (cmd) {
    case "/help":
      await tgSend(t("cmd.help"));
      return;
    case "/status":
      await tgSend(t("cmd.status", {
        done: String(n.done ?? true),
        errors: String(n.errors ?? true),
        permissions: String(n.permissions ?? true),
        questions: String(n.questions ?? true),
        include: (cfg.projects?.include ?? []).join(","),
        exclude: (cfg.projects?.exclude ?? []).join(","),
        digest: cfg.digest?.enabled ? t("cmd.digestOn", { min: String(cfg.digest.intervalMinutes ?? 15) }) : t("cmd.digestOff"),
        quiet: cfg.quietHours ? cfg.quietHours.from + "→" + cfg.quietHours.to : t("cmd.quietNone"),
        lang: cfg.language ?? "en",
        debug: String(DEBUG),
      }));
      return;
    case "/mute": {
      const key = arg.trim() as keyof NotifyCfg;
      if (key in DEFAULT_NOTIFY) { n[key] = false; await saveCfg(); await tgSend(t("cmd.muted", { type: key })); } else await tgSend(t("cmd.typeNotFound", { arg: escapeHtml(arg) }));
      return;
    }
    case "/unmute": {
      const key = arg.trim() as keyof NotifyCfg;
      if (key in DEFAULT_NOTIFY) { n[key] = true; await saveCfg(); await tgSend(t("cmd.unmuted", { type: key })); } else await tgSend(t("cmd.typeNotFound", { arg: escapeHtml(arg) }));
      return;
    }
    case "/watch": {
      const p = arg.trim();
      if (!p) { await tgSend(t("cmd.projectRequired")); return; }
      if (!cfg.projects) cfg.projects = { include: [], exclude: [] };
      if (!cfg.projects.include.includes(p)) cfg.projects.include.push(p);
      await saveCfg(); await tgSend(t("cmd.watched", { project: escapeHtml(p) }));
      return;
    }
    case "/unwatch": {
      const p = arg.trim();
      if (!p) { await tgSend(t("cmd.projectRequired")); return; }
      if (!cfg.projects) cfg.projects = { include: [], exclude: [] };
      cfg.projects.include = (cfg.projects.include ?? []).filter((x) => x !== p);
      await saveCfg(); await tgSend(t("cmd.unwatched", { project: escapeHtml(p) }));
      return;
    }
    case "/lang": {
      const l = arg.trim().toLowerCase();
      if (l in BUILTIN_LANGS) { cfg.language = l; await saveCfg(); await tgSend(t("cmd.langSet", { lang: l })); }
      else await tgSend(t("cmd.langInvalid", { lang: escapeHtml(arg) }));
      return;
    }
    default:
      await tgSend(t("cmd.unknown", { cmd: escapeHtml(cmd) }));
  }
}

// The owner processes marked answers with ITS OWN client (every 2s).
// The file is re-read on every tick — the single source of truth across instances.
async function processAnswered(client: AnyClient): Promise<void> {
  try {
    // Questions marked as answered by the poller of another instance.
    const pending = await readJsonFile<Record<string, PendingReq>>(PENDING_FILE, {});
    for (const [rid, req] of Object.entries(pending)) {
      const a = req.answered;
      if (req.ownerPid !== process.pid || !a) continue;
      await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
        const r = m[rid];
        if (r) r.selfAnswered = true;
      });
      // The poller already edited each message as its question was answered (reject edits all).
      // Here we only send the final reply and clean up.
      const ok = a.reject
        ? await replyToQuestion(client, rid, null)
        : await replyToQuestion(client, rid, req.items.map((it) => it.answer ?? []));
      if (ok) await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => { delete m[rid]; });
    }
    // Permissions marked as answered by the poller of another instance.
    const perms = await readJsonFile<Record<string, PendingPerm>>(PERM_FILE, {});
    for (const [pid2, p] of Object.entries(perms)) {
      if (p.ownerPid !== process.pid || !p.answered) continue;
      await mutateJsonFile<Record<string, PendingPerm>>(PERM_FILE, (m) => {
        const rec = m[pid2];
        if (rec) rec.selfAnswered = true;
      });
      const ok = await replyPermission(client, pid2, p.sessionID, p.answered);
      if (ok) {
        const label = t("perm.decision." + p.answered);
        await tgEdit(p.msgId, renderTemplate(fmt("permission_done"), {
          ...projectVars(p.project),
          permission: emoji("permission"),
          kind: permissionKind(p.permission) || t("perm.kindFallback"),
          reply: p.target ? emoji("reply") : "",
          target: p.target ?? "",
          decision: label,
        }));
        await mutateJsonFile<Record<string, PendingPerm>>(PERM_FILE, (m) => { delete m[pid2]; });
      }
    }
  } catch (err) {
    dbg("PROCESS ANSWERED THROW " + String(err));
    await flushDbg();
  }
}

// Auto-reject questions stuck for longer than questionTimeoutMinutes.
async function expireQuestions(client: AnyClient): Promise<void> {
  const timeoutMs = (cfg.options?.questionTimeoutMinutes ?? 30) * 60_000;
  const pending = await readJsonFile<Record<string, PendingReq>>(PENDING_FILE, {});
  for (const [rid, req] of Object.entries(pending)) {
    if (req.ownerPid !== process.pid) continue;
    if (!req.createdAt || Date.now() - req.createdAt < timeoutMs) continue;
    await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
      const r = m[rid];
      if (r) r.selfAnswered = true;
    });
    await replyToQuestion(client, rid, null);
    for (const it of req.items) await tgEdit(it.msgId, t("q.timeout"));
    await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => { delete m[rid]; });
  }
}

// ---------- Telegram polling loop ----------

// Permission response: "once" | "always" | "reject".
async function replyPermission(
  client: AnyClient,
  permissionID: string,
  sessionID: string,
  response: string,
): Promise<boolean> {
  try {
    const raw = (client?._client as AnyClient | undefined) ?? client;
    if (!raw?.request) return false;
    const path = "/session/" + encodeURIComponent(sessionID) + "/permissions/" + encodeURIComponent(permissionID);
    const r = await raw.request({
      method: "POST",
      url: path,
      body: { response },
    });
    const ok = !r?.error && (r?.response?.ok ?? true);
    dbg("PERM REPLY " + permissionID + " " + response + " ok=" + ok + " err=" + JSON.stringify(r?.error ?? null).slice(0, 120));
    await flushDbg();
    return ok;
  } catch (err) {
    console.error("telegram-notify: permission reply failed", err);
    dbg("PERM REPLY THROW " + String(err));
    await flushDbg();
    return false;
  }
}

async function pollOnce(client: AnyClient): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const url = tgBase() + "/getUpdates?timeout=30&offset=" + pollOffset + "&allowed_updates=" + encodeURIComponent(JSON.stringify(["callback_query", "message"]));
    const r = await fetch(url);
    if (!r.ok) return;
    const data = (await r.json().catch(() => null)) as { result?: Array<Record<string, unknown>> } | null;
    for (const u of data?.result ?? []) {
      if (typeof u.update_id === "number") pollOffset = Math.max(pollOffset, (u.update_id as number) + 1);
      const cq = u.callback_query as Record<string, unknown> | undefined;
      if (cq) await handleCallback(client, cq);
      const msg = u.message as Record<string, unknown> | undefined;
      if (msg) await handleTextMessage(client, msg);
    }
    if (pollOffset) await writeJson(STATE_FILE, { offset: pollOffset });
  } catch (err) {
    console.error("telegram-notify: poll failed", err);
    dbg("POLL THROW " + String(err));
    await flushDbg();
  }
}

async function pollLoop(client: AnyClient): Promise<void> {
  while (true) {
    await pollOnce(client);
  }
}

// ---------- session access (for notifications) ----------

interface TgMessage {
  info?: { role?: string; time?: { created?: number } };
  parts?: Array<{ type?: string; text?: string }>;
}

async function sessionMessages(client: AnyClient, sessionID: string): Promise<TgMessage[]> {
  try {
    const raw = (client?._client as AnyClient | undefined) ?? client;
    if (!raw?.request) return [];
    const r = await raw.request({ method: "GET", url: "/session/" + encodeURIComponent(sessionID) + "/message" });
    const res = r?.data ?? r;
    const msgs = Array.isArray(res) ? res : (res as { data?: unknown })?.data;
    if (!Array.isArray(msgs)) {
      dbg("MSGS shape: " + JSON.stringify(res).slice(0, 400));
      await flushDbg();
      return [];
    }
    return msgs as TgMessage[];
  } catch (err) {
    dbg("MSGS THROW " + String(err));
    await flushDbg();
    return [];
  }
}

interface SessionInfo {
  directory: string;
  agent: string;
  title: string;
  cost: number;
}

// ---------- message format config (telegram-notify.json) ----------

interface NotifyCfg {
  done: boolean;
  errors: boolean;
  permissions: boolean;
  questions: boolean;
}
interface ProjectsCfg {
  include: string[];
  exclude: string[];
}
interface EmojisCfg {
  project: string;
  done: string;
  error: string;
  permission: string;
  question: string;
  reply: string;
  agent: string;
}
interface FormatCfg {
  done: string;
  error: string;
  permission: string;
  permission_done: string;
  question: string;
  question_done: string;
}
interface QuietCfg {
  from: number; // hour 0-23
  to: number;
}
interface DigestCfg {
  enabled: boolean;
  intervalMinutes: number;
}
interface OptionsCfg {
  showCost: boolean;
  questionTimeoutMinutes: number;
  smartDone: boolean; // suppress empty turns + add action summary to DONE (default true)
  smartDoneOptions?: SmartDoneOptionsCfg;
}
interface PluginCfg {
  botToken?: string;
  chatId?: string | number;
  debug?: boolean;
  language?: string;
  emojis?: Partial<EmojisCfg>;
  format?: Partial<FormatCfg>;
  notify?: Partial<NotifyCfg>;
  projects?: ProjectsCfg;
  quietHours?: QuietCfg;
  digest?: DigestCfg;
  options?: Partial<OptionsCfg>;
}

let cfg: PluginCfg = {};
const DEFAULT_EMOJIS: EmojisCfg = { project: "📁", done: "✅", error: "❌", permission: "🟧", question: "❓", reply: "💬", agent: "🤖" };
// Format templates — placeholders only, actual text comes from t() at render time,
// so defaults are language-neutral (no per-language split needed).
const DEFAULT_FORMAT: FormatCfg = {
  done: "{project} {project_text} {done} {task}{agent} ({duration}{cost})",
  error: "{project} {project_text} {error} {task}\n{reply} {error_text}",
  permission: "{project} {project_text} {permission} {kind}\n{reply} {target}",
  permission_done: "{project} {project_text} {permission} {kind}\n{reply} {target}\n→ {decision}",
  question: "{project} {project_text} {question} {question_text}",
  question_done: "{project} {project_text} {done} {question_text}\n{q.answer}",
};
const DEFAULT_NOTIFY: NotifyCfg = { done: true, errors: true, permissions: true, questions: true };
const DEFAULT_PROJECTS: ProjectsCfg = { include: [], exclude: [] };
const DEFAULT_OPTIONS: OptionsCfg = { showCost: true, questionTimeoutMinutes: 30, smartDone: true };

// ---------- i18n ----------

type LangDict = Record<string, string>;

const BUILTIN_LANGS: Record<string, LangDict> = {
  ru: {
    "btn.once": "✅ Разово",
    "btn.always": "♾ Всегда",
    "btn.reject": "✕ Отклонить",
    "btn.done": "✔️ Готово",
    "hint.custom": "\n💬 Ответь на это сообщение текстом",

    "done.extra.one": "… и ещё {count} действие",
    "done.extra.few": "… и ещё {count} действия",
    "done.extra.many": "… и ещё {count} действий",

    "cmd.help": "Команды:\n/status — состояние\n/mute done|errors|permissions|questions — выключить тип\n/unmute тип — включить тип\n/watch проект — подписаться\n/unwatch проект — отписаться\n/lang ru|en — язык\n/help — этот список",
    "cmd.status": "Статус:\n• уведомления: done={done}, errors={errors}, permissions={permissions}, questions={questions}\n• проекты: include={include} exclude={exclude}\n• digest={digest}\n• тихие часы: {quiet}\n• язык: {lang}\n• debug={debug}",
    "cmd.digestOn": "вкл ({min}м)",
    "cmd.digestOff": "выкл",
    "cmd.quietNone": "нет",
    "cmd.muted": "Выключено: {type}",
    "cmd.unmuted": "Включено: {type}",
    "cmd.typeNotFound": "Тип не найден: {arg}",
    "cmd.projectRequired": "Укажи имя проекта",
    "cmd.watched": "Подписан: {project}",
    "cmd.unwatched": "Отписан: {project}",
    "cmd.unknown": "Неизвестная команда: {cmd} (напиши /help)",
    "cmd.langSet": "Язык: {lang}",
    "cmd.langInvalid": "Неизвестный язык: {lang}",

    "perm.decision.once": "разрешено разово",
    "perm.decision.always": "разрешено всегда",
    "perm.decision.reject": "отклонено",
    "perm.terminal": " (в терминале)",
    "perm.kindFallback": "Разрешение",
    "perm.kind.external_directory": "Внешняя папка",
    "perm.kind.external_file": "Внешний файл",
    "perm.kind.doom_loop": "Повторные сбои",

    "q.answer": "Ответ: {answer}",
    "q.timeout": "✕ (истёк таймаут вопроса)",
    "q.buttonsOnly": "⚠️ Не удалось принять текст — вопрос принимает кнопки, выбери вариант из списка.",
    "q.repliedTerminal": "✅ (ответ дан в терминале)",
    "q.rejectedTerminal": "✕ (отклонено в терминале)",
    "q.rejected": "✕ Отклонено",
    "q.fallback": "Вопрос",

    "cb.accepted": "Принято",
    "cb.stale": "устарело",
    "cb.questionStale": "вопрос устарел",
    "cb.pickFirst": "сначала выбери варианты",
    "cb.selected": "✓ выбрано",
    "cb.unselected": "снято",
    "cb.unknown": "неизвестная команда",
    "cb.done": "Готово",
    "cb.errSend": "ошибка отправки",
    "cb.rejected": "Отклонено",

    "err.unknown": "неизвестная ошибка",

    "menu.status": "Состояние плагина",
    "menu.mute": "Выключить тип уведомлений (done/errors/permissions/questions)",
    "menu.unmute": "Включить тип уведомлений",
    "menu.watch": "Подписаться на проект",
    "menu.unwatch": "Отписаться от проекта",
    "menu.lang": "Язык (ru/en)",
    "menu.help": "Список команд",
  },
  en: {
    "btn.once": "✅ Once",
    "btn.always": "♾ Always",
    "btn.reject": "✕ Reject",
    "btn.done": "✔️ Done",
    "hint.custom": "\n💬 Reply to this message with text",

    "done.extra.one": "… and {count} more action",
    "done.extra.few": "… and {count} more actions",
    "done.extra.many": "… and {count} more actions",

    "cmd.help": "Commands:\n/status — status\n/mute done|errors|permissions|questions — disable type\n/unmute type — enable type\n/watch project — watch project\n/unwatch project — stop watching\n/lang ru|en — language\n/help — this list",
    "cmd.status": "Status:\n• notifications: done={done}, errors={errors}, permissions={permissions}, questions={questions}\n• projects: include={include} exclude={exclude}\n• digest={digest}\n• quiet hours: {quiet}\n• language: {lang}\n• debug={debug}",
    "cmd.digestOn": "on ({min}m)",
    "cmd.digestOff": "off",
    "cmd.quietNone": "none",
    "cmd.muted": "Muted: {type}",
    "cmd.unmuted": "Unmuted: {type}",
    "cmd.typeNotFound": "Type not found: {arg}",
    "cmd.projectRequired": "Specify a project name",
    "cmd.watched": "Watching: {project}",
    "cmd.unwatched": "Not watching: {project}",
    "cmd.unknown": "Unknown command: {cmd} (use /help)",
    "cmd.langSet": "Language: {lang}",
    "cmd.langInvalid": "Unknown language: {lang}",

    "perm.decision.once": "allowed once",
    "perm.decision.always": "allowed always",
    "perm.decision.reject": "rejected",
    "perm.terminal": " (in terminal)",
    "perm.kindFallback": "Permission",
    "perm.kind.external_directory": "External folder",
    "perm.kind.external_file": "External file",
    "perm.kind.doom_loop": "Repeated failures",

    "q.answer": "Answer: {answer}",
    "q.timeout": "✕ (question timed out)",
    "q.buttonsOnly": "⚠️ Text not accepted — the question only accepts buttons, pick one.",
    "q.repliedTerminal": "✅ (answered in terminal)",
    "q.rejectedTerminal": "✕ (rejected in terminal)",
    "q.rejected": "✕ Rejected",
    "q.fallback": "Question",

    "cb.accepted": "Accepted",
    "cb.stale": "stale",
    "cb.questionStale": "question is stale",
    "cb.pickFirst": "select options first",
    "cb.selected": "selected",
    "cb.unselected": "unselected",
    "cb.unknown": "unknown command",
    "cb.done": "Done",
    "cb.errSend": "send error",
    "cb.rejected": "Rejected",

    "err.unknown": "unknown error",

    "menu.status": "Plugin status",
    "menu.mute": "Disable notification type (done/errors/permissions/questions)",
    "menu.unmute": "Enable notification type",
    "menu.watch": "Watch a project",
    "menu.unwatch": "Stop watching a project",
    "menu.lang": "Language (ru/en)",
    "menu.help": "List of commands",
  },
};

// Custom translation file: ~/.config/opencode/telegram-notify-lang.json (key → string).
async function loadCustomLang(): Promise<LangDict> {
  try {
    return JSON.parse(await Bun.file(CONFIG_DIR + "telegram-notify-lang.json").text()) as LangDict;
  } catch {
    return {};
  }
}

let customLang: LangDict = {};

// Translate with {param} substitution. Returns key itself if no translation found.
function t(key: string, params: Record<string, string> = {}): string {
  const lang = cfg.language ?? "en";
  let s: string | undefined =
    customLang[key] ??
    BUILTIN_LANGS[lang]?.[key] ??
    BUILTIN_LANGS.ru[key] ??
    key;
  for (const [k, v] of Object.entries(params)) {
    s = s.split("{" + k + "}").join(v);
  }
  return s;
}

// Session info cache (events don't carry directory/agent — fetched via /session/<id>).
const sessionInfoCache = new Map<string, SessionInfo>();

// Smart DONE per-turn accumulation (in-memory, per session).
// Turn boundaries: start = first message.part.updated after the previous session.idle,
// end = session.idle. If the plugin starts mid-turn (no accumulated events) — acc is
// undefined at idle → never suppress (safety rule).
interface TurnAccum {
  hasActionTool: boolean; // any non-query tool completed/errored this turn
  seenCalls: Set<string>; // dedup by part.callID (a part can be re-emitted)
  lines: string[]; // raw summary lines (HTML-escaped only at final assembly)
  errors: number; // error counter
  lastText: string | null; // last non-synthetic assistant text
}
const turnStore = new Map<string, TurnAccum>();

async function sessionInfo(client: AnyClient, sessionID: string, fresh = false): Promise<SessionInfo | null> {
  if (!sessionID) return null;
  if (!fresh) {
    const hit = sessionInfoCache.get(sessionID);
    if (hit) return hit;
  }
  try {
    const raw = (client?._client as AnyClient | undefined) ?? client;
    if (!raw?.request) return null;
    const r = await raw.request({ method: "GET", url: "/session/" + encodeURIComponent(sessionID) });
    const s = r?.data ?? r;
    const obj = Array.isArray(s) ? (s as AnyClient[])[0] : s;
    const info: SessionInfo = {
      directory: String(obj?.directory ?? ""),
      agent: String(obj?.agent ?? ""),
      title: String(obj?.title ?? ""),
      cost: Number(obj?.cost ?? 0),
    };
    if (sessionInfoCache.size > 500) sessionInfoCache.clear();
    sessionInfoCache.set(sessionID, info);
    return info;
  } catch {
    return null;
  }
}

// Project name (last path segment) — no emoji/hashtag (the template vars {project}/{project_hashtag} add them).
function projectTag(info: SessionInfo | null): string {
  const dir = info?.directory ?? "";
  return dir.split("/").filter(Boolean).pop() ?? "";
}

// Telegram hashtag from a project name: letters/digits/_ only (no spaces, no emoji),
// must not start with a digit (Telegram rule).
function projectHashtag(name?: string): string {
  let tag = (name || "").replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (/^\d/.test(tag)) tag = "_" + tag;
  return tag ? "#" + tag : "";
}

// Template vars for a project name: {project} = emoji, {project_text} = raw name, {project_hashtag} = "#name".
function projectVars(name?: string): Record<string, string> {
  return {
    project: name ? emoji("project") : "",
    project_text: name || "",
    project_hashtag: projectHashtag(name),
  };
}

// Agent name — no brackets (the template adds them); don't duplicate if already
// in the task title (opencode titles often contain "(<agent> subagent)").
function agentTag(info: SessionInfo | null, task: string = ""): string {
  const agent = info?.agent ?? "";
  if (!agent) return "";
  if (task && (task.includes(agent) || /subagent/i.test(task))) return "";
  return agent;
}

// Replace {name} placeholders in the template. Values are HTML-escaped.
// Empty placeholder: empty brackets/square brackets and extra spaces are removed.
function renderTemplate(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split("{" + k + "}").join(escapeHtml(v));
  }
  out = out
    .replace(/\s*\[\s*\]/g, "")
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out;
}

// Session title if meaningful (not empty and not "New session"); otherwise — first user message.
function taskLabel(info: SessionInfo | null, fallback: string): string {
  const t = String(info?.title ?? "").trim();
  return t && !/^New session/i.test(t) ? truncate(t) : fallback;
}

async function taskText(client: AnyClient, sessionID: string): Promise<string> {
  const msgs = await sessionMessages(client, sessionID);
  for (const m of msgs) {
    if (m.info?.role === "user") {
      const text = (m.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join(" ")
        .trim();
      if (text) return truncate(text);
      break;
    }
  }
  return sessionID.slice(0, 6);
}

async function taskDuration(client: AnyClient, sessionID: string): Promise<number | null> {
  const msgs = await sessionMessages(client, sessionID);
  const times = msgs.map((m) => m.info?.time?.created ?? 0).filter((t) => t > 0).sort((a, b) => a - b);
  if (times.length < 2) return null;
  const last = times[times.length - 1];
  const prev = times[times.length - 2];
  return last > prev ? last - prev : null;
}

// Extract a readable message from an error of any shape:
// { message }, { data: { message } }, { error: { message } }, or { name, data: { message } }.
function errorText(event: Record<string, unknown>): string {
  const err = event.error as { name?: string; message?: string; data?: unknown; error?: unknown } | undefined;
  if (!err) return truncate(t("err.unknown"));
  const data =
    (err.data && typeof err.data === "object" ? (err.data as { message?: unknown }) : undefined) ??
    (err.error && typeof err.error === "object" ? (err.error as { message?: unknown }) : undefined);
  const msg =
    (typeof err.message === "string" && err.message) ||
    (typeof data?.message === "string" && data.message) ||
    (err.name ? err.name : "");
  return truncate(msg || t("err.unknown"));
}

// ---------- smart DONE ----------

// Query/read-only tools are NOT "actions" — a turn of only these is suppressible.
// Everything else counts as an action (safer: don't miss real work).
function isQueryTool(name: string): boolean {
  const n = String(name ?? "");
  return smartDoneCfg.queryTools.includes(n) || smartDoneCfg.queryPrefixes.some((p) => n.startsWith(p));
}

// Best-effort detection of side-effect-free bash (inspection only). Strips
// wrapper prefixes (rtk/bunx/npx/sudo) and FOO=bar env assignments first.
function isReadOnlyBash(cmd: unknown): boolean {
  let c = String(cmd ?? "").trim();
  for (const w of ["rtk ", "bunx ", "npx ", "sudo "]) if (c.startsWith(w)) c = c.slice(w.length).trim();
  c = c.replace(/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+/, ""); // strip FOO=bar prefix
  return smartDoneCfg.readonlyBash.some((p) => c.startsWith(p));
}

// Strip HTML-ish tags from a raw string.
function stripTags(s: string): string {
  return String(s).replace(/<[^>]+>/g, "");
}

// Subagent report from a task tool output — NOT JSON, text with HTML tags:
// <task id=...><summary>…</summary><task_result>final text</task_result></task>.
function extractTaskReport(out: unknown): string {
  const text = String(out ?? "");
  if (!text) return "";
  const sum = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (sum) return stripTags(sum[1]).trim();
  const res = text.match(/<task_result>([\s\S]*?)<\/task_result>/);
  if (res) return stripTags(res[1]).trim();
  const err = text.match(/<task_error>([\s\S]*?)<\/task_error>/);
  if (err) return stripTags(err[1]).trim();
  return stripTags(text).trim();
}

// First non-empty line, truncated to smartDoneCfg.maxChars.
function firstLine(s: string): string {
  return (String(s).split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, smartDoneCfg.maxChars);
}

// First "meaty" line of a report: skip empty lines, bullets, markdown headers,
// numbered items — the first line of an agent report is often a file list/header.
function pickSummaryLine(s: string): string {
  for (const raw of String(s).split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (/^[-#*>\d.)]/.test(l)) continue; // bullet / header / numbered item
    return l.slice(0, smartDoneCfg.maxChars);
  }
  return "";
}

// A final assistant text is "substantive" if it has at least smartDoneCfg.minWords.
function isSubstantive(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  return text.trim().split(/\s+/).filter(Boolean).length >= smartDoneCfg.minWords;
}

// Russian-style pluralization (n:1 → one, n:2–4 → few, else many); en-like default.
function pluralize(n: number, one: string, few: string, many: string): string {
  const lang = cfg.language ?? "en";
  if (lang === "ru") {
    const abs = Math.abs(n) % 100;
    const d = abs % 10;
    if (d === 1 && abs !== 11) return one;
    if (d >= 2 && d <= 4 && !(abs >= 12 && abs <= 14)) return few;
    return many;
  }
  return n === 1 ? one : many; // en-like default
}

// One summary line for a completed tool part (raw text — escaped once at assembly).
// Unknown tools return null → no line (only high-signal actions go into the summary).
const IDE_MUTATORS = ["ide_refactor_rename","ide_edit_member","ide_replace_member","ide_insert_member","ide_create_file","ide_replace_text_in_file","ide_reformat_code","ide_move_file"];
function toolSummaryLine(tool: string, st: Record<string, unknown>): string | null {
  const input = (st?.input ?? {}) as Record<string, unknown>;
  if (tool === "task") {
    if (!smartDoneCfg.show.subagent) return null;
    const sub = String(input?.subagent_type ?? tool);
    // Background dispatch: the "result" is just a boilerplate ack — show no report.
    if (input?.background === true) return "➜ " + sub;
    const report = pickSummaryLine(extractTaskReport(st?.output));
    return report ? "➜ " + sub + ": " + report : "➜ " + sub;
  }
  if (tool === "write" || tool === "edit" || tool === "ast_grep_replace") {
    if (!smartDoneCfg.show.write) return null;
    const path = String(input?.filePath ?? "") || String(input?.file ?? "") || (Array.isArray(input?.paths) ? String(input?.paths?.[0] ?? "") : "");
    return "✎ " + (path || tool);
  }
  if (tool === "bash") {
    if (!smartDoneCfg.show.command) return null;
    return "⚙ " + firstLine(String(input?.command ?? ""));
  }
  if (IDE_MUTATORS.includes(tool)) {
    if (!smartDoneCfg.show.write) return null;
    const f = String(input?.file ?? "");
    return f ? "✎ " + f : "🔧 " + tool;
  }
  if (tool === "ide_build_project") {
    if (!smartDoneCfg.show.build) return null;
    return "🔧 build";
  }
  if (tool === "ide_run_tests") {
    if (!smartDoneCfg.show.build) return null;
    return "🔧 tests";
  }
  return null;
}

// Get-or-create the per-session accumulator (single source of turn state).
function getOrCreateAcc(sessionID: string): TurnAccum {
  let acc = turnStore.get(sessionID);
  if (!acc) {
    acc = { hasActionTool: false, seenCalls: new Set(), lines: [], errors: 0, lastText: null };
    turnStore.set(sessionID, acc);
  }
  return acc;
}

// Accumulate per-session turn data from message.part.updated events.
// Only act on completed/error parts (pending/running would duplicate lines per update).
function accumulateTurn(ev: Record<string, unknown>): void {
  const sessionID = String(ev?.sessionID ?? "");
  const part = (ev?.part ?? {}) as Record<string, unknown>;
  const ptype = String(part?.type ?? "");
  if (!sessionID || !ptype) return;
  const st = (part?.state ?? {}) as Record<string, unknown>;

  if (ptype === "tool") {
    const tool = String(part?.tool ?? "");
    const status = String(st?.status ?? "");
    if (status === "pending" || status === "running") return;
    if (DEBUG && (status === "completed" || status === "error")) {
      dbg("msgpart.tool " + tool + " " + JSON.stringify({ input: st.input, output: String(st.output ?? "").slice(0, 200), error: st.error }));
    }
    const acc = getOrCreateAcc(sessionID);
    const callID = String(part?.callID ?? "");
    if (status === "completed") {
      if (callID && acc.seenCalls.has(callID)) return; // part re-emitted — dedup
      if (callID) acc.seenCalls.add(callID);
      if (isQueryTool(tool)) return; // read-only — not an action, no line
      if (tool === "bash" && isReadOnlyBash((st.input as { command?: unknown } | undefined)?.command)) return; // inspection — not an action
      acc.hasActionTool = true;
      const line = toolSummaryLine(tool, st);
      if (line && acc.lines.length < Math.max(SUMMARY_MAX_ACCUM, smartDoneCfg.maxLines)) acc.lines.push(line);
    } else if (status === "error") {
      acc.hasActionTool = true; // an error is always meaningful
      acc.errors++;
      if (smartDoneCfg.show.error) {
        const firstErr = firstLine(String(st?.error ?? ""));
        if (acc.lines.length < Math.max(SUMMARY_MAX_ACCUM, smartDoneCfg.maxLines)) acc.lines.push("❌ " + tool + (firstErr ? ": " + firstErr : ""));
      }
    }
    return;
  }

  if (ptype === "text") {
    const text = String(part?.text ?? "");
    if (text && !part?.synthetic) {
      const acc = getOrCreateAcc(sessionID);
      acc.lastText = text;
    }
  }
}

// Final summary block: join accumulated lines (collapsing duplicates), add a
// pluralized "… and N more" tail for overflow, and HTML-escape once (gotcha 9).
// Empty acc or showActions=false → "".
function buildSummaryBlock(acc: TurnAccum): string {
  if (!smartDoneCfg.showActions || !acc.lines.length) return "";
  // Collapse identical lines: "✎ /path (×4)".
  const groups: { text: string; count: number }[] = [];
  for (const line of acc.lines) {
    const g = groups.find((x) => x.text === line);
    if (g) g.count++;
    else groups.push({ text: line, count: 1 });
  }
  const shown = groups.slice(0, smartDoneCfg.maxLines);
  let block = shown.map((g) => (g.count > 1 ? g.text + " (×" + g.count + ")" : g.text)).join("\n");
  const extra = groups.length - shown.length;
  if (extra > 0) {
    block += "\n" + pluralize(extra,
      t("done.extra.one", { count: String(extra) }),
      t("done.extra.few", { count: String(extra) }),
      t("done.extra.many", { count: String(extra) }));
  }
  return escapeHtml(block); // gotcha 9: once, at assembly
}

// ---------- plugin ----------

// @ts-ignore
export const TelegramNotify: Plugin = async ({ client }) => {
  const c = client as AnyClient;
  // DATA_DIR is created lazily: Bun.write creates parent directories itself.
  await loadCreds();
  smartDoneCfg = resolveSmartDone(cfg.options?.smartDoneOptions);
  void registerCommands();
  await ensureState();
  const lock = await tryAcquireLock();
  dbg("INIT lock=" + lock + " pid=" + process.pid + " base=" + getClientBase(c));
  try {
    const proto = (Object.getOwnPropertyNames(Object.getPrototypeOf(c?.session ?? {})).slice(0, 40));
    const protoClient = (Object.getOwnPropertyNames(Object.getPrototypeOf(c?._client ?? {})).slice(0, 40));
    await dumpInit({
      lock,
      pid: process.pid,
      base: getClientBase(c),
      clientKeys: Object.keys(c ?? {}).slice(0, 30),
      _clientKeys: Object.keys(c?._client ?? {}).slice(0, 30),
      sessionProtoMethods: proto,
      _clientProtoMethods: protoClient,
      options: c?._client?.options ?? null,
      getConfig: JSON.stringify(await (c?._client?.getConfig as AnyClient | undefined)?.call(c?._client).catch?.(() => null) ?? null).slice(0, 500),
      sessKeys: Object.keys(c?.session ?? {}).slice(0, 30),
    });
  } catch (err) {
    await dumpInit({ error: String(err) });
  }
  await flushDbg();
  if (lock) {
    void pollLoop(c);
  }
  setInterval(() => {
    void processAnswered(c).catch(() => {});
    void expireQuestions(c).catch(() => {});
    void flushDigest();
    if (lock) void writeHeartbeatLock(); // keep the poller lock fresh (stale → reclaimed)
  }, 2000);

  async function onEvent(client: AnyClient, event: Record<string, unknown>): Promise<void> {
const type = event?.type as string | undefined;
      // Events come in v2 format: fields are nested in properties.
      const ev = ((event?.properties ?? event) ?? {}) as Record<string, unknown>;
      if (type && isInteresting(type)) {
        dbg("EVENT " + type + " :: " + JSON.stringify(event).slice(0, 600));
        await flushDbg();
      }

      // Feed the per-turn accumulator (Smart DONE). Only message.part.updated exists
      // on this runtime (no message.part.completed) — statuses come from part.state.
      if (type === "message.part.updated") {
        // Non-critical: never let a bad part payload break event delivery (there's no
        // outer try/catch in this handler). Do NOT flushDbg here — it rewrites the whole
        // debug file on EVERY part update (a text stream = hundreds of writes per turn),
        // which starves the poller (getUpdates) and the 2s processAnswered timer — the
        // permission button presses died under that flood. Lines stay buffered (cap 1000)
        // and flush at the next interesting event (session.idle → flushDbg).
        try { accumulateTurn(ev); } catch { /* non-critical */ }
        return;
      }

      if (type === "session.idle") {
        const id = String(ev.sessionID ?? "");
        if (!id || throttle("idle:" + id)) return;
        const acc = turnStore.get(id);
        const smart = cfg.options?.smartDone !== false; // toggle, default on

        // Suppress a turn observed as empty (no action tool, no substantive text) —
        // early return BEFORE the expensive HTTP calls. acc === undefined (plugin
        // started mid-turn) → never suppress: plain DONE without a summary.
        if (smart && acc) {
          const meaningful = acc.hasActionTool || isSubstantive(acc.lastText);
          if (!meaningful) {
            turnStore.delete(id);
            return;
          }
        }
        const [task0, dur, info] = await Promise.all([
          taskText(client, id),
          taskDuration(client, id),
          sessionInfo(client, id, true), // fresh: cost grows during the session
        ]);
        const task = taskLabel(info, task0);
        if (!notifyEnabled("done") || !projectAllowed(projectTag(info))) {
          turnStore.delete(id);
          return;
        }
        if (isQuietHour()) {
          turnStore.delete(id);
          return;
        }
        const name = projectTag(info);
        const agent = agentTag(info, task);
        const cost = (cfg.options?.showCost ?? true) && info?.cost ? " · $" + info.cost.toFixed(2) : "";
        let msg = renderTemplate(fmt("done"), {
          ...projectVars(name),
          done: emoji("done"),
          task: truncate(task),
          agent: agent ? " [" + agent + "]" : "",
          duration: dur ? fmtDuration(dur) : "",
          cost,
        });
        // Smart DONE summary block: raw lines are escaped ONCE here (gotcha 9).
        if (smart && acc) {
          const block = buildSummaryBlock(acc);
          if (block) msg += "\n" + block;
        }
        await sendOrDigest(msg, true);
        turnStore.delete(id); // reset for the next turn
        return;
      }

      if (type === "session.error" || type === "session.execution.failed" || type === "session.step.failed") {
        const id = String(ev.sessionID ?? "");
        if (throttle("error:" + id)) return;
        const task0 = id ? await taskText(client, id) : "opencode";
        const info = id ? await sessionInfo(client, id) : null;
        const task = id ? taskLabel(info, task0) : "opencode";
        if (!notifyEnabled("errors") || !projectAllowed(projectTag(info))) return;
        if (isQuietHour()) return;
        const name = projectTag(info);
        await sendOrDigest(renderTemplate(fmt("error"), {
          ...projectVars(name),
          error: emoji("error"),
          task: truncate(task),
          reply: emoji("reply"),
          error_text: errorText(ev),
        }), true);
        return;
      }

      if (type === "permission.asked" || type === "permission.v2.asked") {
        const id = String(ev.sessionID ?? "");
        const info = await sessionInfo(client, id);
        const name = projectTag(info);
        const tool = (ev.tool ?? ev.source) as { messageID?: string } | undefined;
        const toolMsgId = String(tool?.messageID ?? "");
        // Throttle only repeats of the SAME operation (same toolMsgId) — a second,
        // DIFFERENT permission in the same session within THROTTLE_MS must still notify.
        // (Old key was session-only: a rapid read+edit pair only surfaced the first one.)
        if (toolMsgId && throttle("perm:" + id + ":" + toolMsgId)) {
          if (DEBUG) dbg("PERM THROTTLED " + id + " toolMsgId=" + toolMsgId);
          return;
        }
        const permId = String(ev.id ?? "");
        // The same operation asked again (opencode re-asks with a new permId) —
        // don't duplicate the message, just update the current id for the buttons.
        // Dedup lookup goes to the FILE (shared across instances).
        if (toolMsgId) {
          const perms = await readJsonFile<Record<string, PendingPerm>>(PERM_FILE, {});
          const existing = Object.values(perms).find((e) => e.toolMsgId === toolMsgId);
          if (existing) {
            await mutateJsonFile<Record<string, PendingPerm>>(PERM_FILE, (m) => {
              for (const k of Object.keys(m)) {
                if (m[k].toolMsgId === toolMsgId) m[k].currentId = permId;
              }
            });
            return;
          }
        }
        const permission = String(ev.permission ?? ev.action ?? "");
        const metadata = (ev.metadata ?? {}) as Record<string, unknown>;
        const command = String(metadata.command ?? metadata.title ?? metadata.filepath ?? "");
        const kind = permissionKind(permission);
        // Target path: folder extracted from the command → explicit resources/patterns (v2 resources / v1 patterns) → command tail.
        const target =
          extractPath(command || permission) ||
          (Array.isArray(ev.resources) ? (ev.resources as string[]).join(", ") : "") ||
          (Array.isArray(ev.patterns) ? (ev.patterns as string[]).join(", ") : "") ||
          truncateTail(command || permission, MAX_TASK_LEN);
        if (!notifyEnabled("permissions") || !projectAllowed(name)) return;
        const buttons: TgButton[][] = [
          [{ text: t("btn.once"), callback_data: "ocp:" + permId + ":once" }],
          [{ text: t("btn.always"), callback_data: "ocp:" + permId + ":always" }],
          [{ text: t("btn.reject"), callback_data: "ocp:" + permId + ":reject" }],
        ];
        const msgId = await tgSend(renderTemplate(fmt("permission"), {
          ...projectVars(name),
          permission: emoji("permission"),
          kind,
          reply: target ? emoji("reply") : "",
          target,
        }), permId ? buttons : undefined);
        if (permId && msgId) {
          await mutateJsonFile<Record<string, PendingPerm>>(PERM_FILE, (m) => {
            m[permId] = { sessionID: id, ownerPid: process.pid, msgId, permission, currentId: permId, toolMsgId, project: name, target };
          });
        }
        return;
      }

      if (type === "permission.replied") {
        const permId = String(ev.requestID ?? "");
        const perms = await readJsonFile<Record<string, PendingPerm>>(PERM_FILE, {});
        // Find the record by its key or by currentId (a re-ask may have updated it).
        let permKey = "";
        if (perms[permId]) permKey = permId;
        else {
          const found = Object.entries(perms).find(([, e]) => e.currentId === permId);
          if (found) permKey = found[0];
        }
        const p = permKey ? perms[permKey] : undefined;
        if (!p) return;
        if (p.selfAnswered) {
          await mutateJsonFile<Record<string, PendingPerm>>(PERM_FILE, (m) => { delete m[permKey]; });
          return;
        }
        const reply = String(ev.reply ?? "");
        const label = t("perm.decision." + (reply === "once" || reply === "always" ? reply : "reject"));
        await tgEdit(p.msgId, renderTemplate(fmt("permission_done"), {
          ...projectVars(p.project),
          permission: emoji("permission"),
          kind: permissionKind(p.permission) || t("perm.kindFallback"),
          reply: p.target ? emoji("reply") : "",
          target: p.target ?? "",
          decision: label + t("perm.terminal"),
        }));
        await mutateJsonFile<Record<string, PendingPerm>>(PERM_FILE, (m) => { delete m[permKey]; });
        return;
      }

      if (type === "question.asked") {
        const rid = String(ev.id ?? "");
        const info = await sessionInfo(client, String(ev.sessionID ?? ""));
        const proj = projectTag(info);
        const qs = (ev.questions ?? []) as QInfo[];
        if (!rid || !qs.length || throttle("q:" + rid)) return;
        if (!notifyEnabled("questions") || !projectAllowed(proj)) return;
        const items: PendingReq["items"] = [];
        for (let i = 0; i < qs.length; i++) {
          const q = qs[i] as QInfo;
          const opts = Array.isArray(q.options) ? q.options : [];
          const custom = q.custom === true || !opts.length;
          const text = renderTemplate(fmt("question"), {
            ...projectVars(proj),
            question: emoji("question"),
            question_text: (q.header ? q.header + "\n" : "") + truncate(q.question || t("q.fallback")),
            options: opts.map((o) => o.label).join(", "),
          }) + (custom ? t("hint.custom") : "");
          const buttons: TgButton[][] = [];
          opts.forEach((o, oi) => {
            buttons.push([{ text: truncate(o.label), callback_data: "ocq:" + rid + ":q" + i + ":o" + oi }]);
          });
          if (q.multiple === true && buttons.length) {
            buttons.push([
              { text: t("btn.done"), callback_data: "ocq:" + rid + ":q" + i + ":done" },
              { text: t("btn.reject"), callback_data: "ocq:" + rid + ":reject" },
            ]);
          } else if (buttons.length) {
            buttons.push([{ text: t("btn.reject"), callback_data: "ocq:" + rid + ":reject" }]);
          }
          const msgId = await tgSend(text, buttons);
          if (msgId) items.push({ q, msgId });
        }
        if (items.length) {
          await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => {
            m[rid] = { items, ownerPid: process.pid, project: proj, createdAt: Date.now() };
          });
        }
        return;
      }

      if (type === "question.replied" || type === "question.rejected") {
        const rid = String(ev.requestID ?? "");
        const req = (await readJsonFile<Record<string, PendingReq>>(PENDING_FILE, {}))[rid];
        if (!req) return;
        if (req.selfAnswered) {
          await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => { delete m[rid]; });
          return;
        }
        const status = type === "question.replied" ? t("q.repliedTerminal") : t("q.rejectedTerminal");
        for (const item of req.items) await tgEdit(item.msgId, status);
        await mutateJsonFile<Record<string, PendingReq>>(PENDING_FILE, (m) => { delete m[rid]; });
      }
  }

  return {
    event: async ({ event }: { event: Record<string, unknown> }) => {
      try {
        await onEvent(client, event);
      } catch (err) {
        dbg("EVENT THROW " + String((event as Record<string, unknown>)?.type ?? "") + " :: " + String(err));
        await flushDbg();
      }
    },
  };
};

export default TelegramNotify;