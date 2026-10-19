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
  items: Array<{ q: QInfo; msgId: number; selected?: string[] }>;
  project?: string; // project name (raw, no emoji)
  createdAt?: number; // creation ts (for question timeout)
  ownerPid?: number; // pid of the instance holding the question defer
  answered?: { reject?: boolean; qIdx?: number; labels?: string[] };
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

async function readJson<T>(path: string, fallback: T): Promise<T> {
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

// Pending questions by requestID and permissions by permissionID
// (shared files — in case of multiple opencode instances).
let pending: Record<string, PendingReq> = {};
let pendingPerm: Record<string, PendingPerm> = {};
let pollOffset = 0;
let stateLoaded = false;

async function ensureState(): Promise<void> {
  if (stateLoaded) return;
  pending = await readJson(PENDING_FILE, {});
  pendingPerm = await readJson(PERM_FILE, {});
  pollOffset = (await readJson(STATE_FILE, { offset: 0 })).offset ?? 0;
  stateLoaded = true;
}

// Only one opencode instance polls Telegram (lock file with PID).
async function tryAcquireLock(): Promise<boolean> {
  try {
    const cur = (await Bun.file(LOCK_FILE).text()).trim();
    const pid = Number(cur);
    if (cur && pid > 0) {
      try {
        process.kill(pid, 0);
        return false; // another instance is polling
      } catch {
        /* stale lock — take over */
      }
    }
  } catch {
    /* no lock — take over */
  }
  try {
    await Bun.write(LOCK_FILE, String(process.pid));
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
    if (!r.ok) console.error("telegram-notify: editMessageText", r.status);
  } catch (err) {
    console.error("telegram-notify: editMessageText failed", err);
  }
}

// Redraw a message's inline keyboard (e.g. checkmarks on selected options).
async function tgEditButtons(msgId: number, buttons: TgButton[][]): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await fetch(tgBase() + "/editMessageReplyMarkup", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        chat_id: CHAT_ID,
        message_id: String(msgId),
        reply_markup: JSON.stringify({ inline_keyboard: buttons }),
      }),
    });
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
    const p = pendingPerm[permId];
    if (!p || (response !== "once" && response !== "always" && response !== "reject")) {
      await answerCallback(cbId, t("cb.stale"));
      return;
    }
    // Another instance is polling — mark the answer, the owner replies with its own client.
    if (p.ownerPid && p.ownerPid !== process.pid) {
      p.answered = response;
      await writeJson(PERM_FILE, pendingPerm);
      await answerCallback(cbId, t("cb.accepted"));
      return;
    }
    p.selfAnswered = true;
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
      delete pendingPerm[permId];
      await writeJson(PERM_FILE, pendingPerm);
    }
    await answerCallback(cbId, ok ? t("cb.done") : t("cb.errSend"));
    return;
  }

  const parsed = parseCallbackData(data);
  if (!parsed) {
    await answerCallback(cbId, t("cb.unknown"));
    return;
  }

  if (parsed === "reject") {
    const rid = data.slice(4).split(":")[0];
    const req = pending[rid];
    if (!req) {
      await answerCallback(cbId, t("cb.stale"));
      return;
    }
    if (req.ownerPid && req.ownerPid !== process.pid) {
      req.answered = { reject: true };
      await writeJson(PENDING_FILE, pending);
      await answerCallback(cbId, t("cb.accepted"));
      return;
    }
    req.selfAnswered = true;
    const ok = await replyToQuestion(client, rid, null);
    if (ok) await tgEdit(msgId, t("q.rejected"));
    delete pending[rid];
    await writeJson(PENDING_FILE, pending);
    await answerCallback(cbId, ok ? t("cb.rejected") : t("cb.errSend"));
    return;
  }

  const req = pending[parsed.rid];
  const q = req?.items[parsed.qIdx]?.q;
  if (!req || !q) {
    await answerCallback(cbId, t("cb.questionStale"));
    return;
  }

  // "Done" button (multi-select): send the whole set of chosen labels.
  if (parsed.done) {
    const selected = req.items[parsed.qIdx]?.selected ?? [];
    if (!selected.length) {
      await answerCallback(cbId, t("cb.pickFirst"));
      return;
    }
    if (req.ownerPid && req.ownerPid !== process.pid) {
      req.answered = { qIdx: parsed.qIdx, labels: selected };
      await writeJson(PENDING_FILE, pending);
      await answerCallback(cbId, t("cb.accepted"));
      return;
    }
    req.selfAnswered = true;
    const answers: string[][] = req.items.map(() => []);
    answers[parsed.qIdx] = selected;
    const ok = await replyToQuestion(client, parsed.rid, answers);
    if (ok) {
      for (const it of req.items) {
        await tgEdit(it.msgId, renderTemplate(fmt("question_done"), {
          ...projectVars(req.project),
          done: emoji("done"),
          question_text: truncate(it.q.question),
          "q.answer": t("q.answer", { answer: selected.join(", ") }),
        }));
      }
      delete pending[parsed.rid];
      await writeJson(PENDING_FILE, pending);
    }
    await answerCallback(cbId, ok ? t("cb.accepted") : t("cb.errSend"));
    return;
  }

  const label = q?.options?.[parsed.optIdx]?.label;
  if (!label) {
    await answerCallback(cbId, t("cb.questionStale"));
    return;
  }

  // Pressing a multi-select option — toggle: select/deselect, no answer sent.
  if (q.multiple === true) {
    const sel = new Set(req.items[parsed.qIdx].selected ?? []);
    if (sel.has(label)) {
      sel.delete(label);
    } else {
      sel.add(label);
    }
    req.items[parsed.qIdx].selected = [...sel];
    await writeJson(PENDING_FILE, pending);
    await answerCallback(cbId, sel.has(label) ? t("cb.selected") : t("cb.unselected"));
    // Redraw keyboards of all request questions (selected ones get a "✅" prefix).
    for (let qi = 0; qi < req.items.length; qi++) {
      const it = req.items[qi];
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

  // Regular question: first press sends the answer immediately.
  if (req.ownerPid && req.ownerPid !== process.pid) {
    req.answered = { qIdx: parsed.qIdx, labels: [label] };
    await writeJson(PENDING_FILE, pending);
    await answerCallback(cbId, t("cb.accepted"));
    return;
  }
  req.selfAnswered = true;
  const answers: string[][] = req.items.map(() => []);
  answers[parsed.qIdx] = [label];
  const ok = await replyToQuestion(client, parsed.rid, answers);
  if (ok) {
    await tgEdit(msgId, renderTemplate(fmt("question_done"), {
      ...projectVars(req.project),
      done: emoji("done"),
      question_text: truncate(q.question),
      "q.answer": t("q.answer", { answer: label }),
    }));
    delete pending[parsed.rid];
    await writeJson(PENDING_FILE, pending);
  }
  await answerCallback(cbId, ok ? t("cb.accepted") : t("cb.errSend"));
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
    const open = Object.entries(pending).filter(([, rq]) => !rq.answered);
    if (open.length === 1) { rid = open[0][0]; req = open[0][1]; qIdx = 0; }
  }
  if (!req) { dbg("TEXT ignored: no pending question"); return; }
  dbg("TEXT reply=" + repliedMsgId + " q=" + qIdx + " text=" + text.slice(0, 60));
  if (req.ownerPid && req.ownerPid !== process.pid) {
    req.answered = { qIdx, labels: [text] };
    await writeJson(PENDING_FILE, pending);
    return;
  }
  req.selfAnswered = true;
  const answers: string[][] = req.items.map(() => []);
  answers[qIdx] = [text];
  const ok = await replyToQuestion(client, rid, answers);
  if (ok) {
    for (const it of req.items) {
      await tgEdit(it.msgId, renderTemplate(fmt("question_done"), {
        ...projectVars(req.project),
        done: emoji("done"),
        question_text: truncate(it.q.question),
        "q.answer": t("q.answer", { answer: text }),
      }));
    }
    delete pending[rid];
    await writeJson(PENDING_FILE, pending);
  } else {
    await tgSend(t("q.buttonsOnly"));
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
async function processAnswered(client: AnyClient): Promise<void> {
  try {
    let changed = false;
    for (const [rid, req] of Object.entries(pending)) {
      const a = req.answered;
      if (req.ownerPid !== process.pid || !a) continue;
      req.selfAnswered = true;
      const ok = a.reject
        ? await replyToQuestion(client, rid, null)
        : await replyToQuestion(client, rid, req.items.map((_, i) => (i === a.qIdx ? (a.labels ?? []) : [])));
      if (ok) {
        const label = a.reject ? t("perm.decision.reject") : (a.labels ?? []).join(", ");
        for (const it of req.items) await tgEdit(it.msgId, renderTemplate(fmt("question_done"), {
          ...projectVars(req.project),
          done: emoji("done"),
          question_text: truncate(it.q.question),
          "q.answer": t("q.answer", { answer: label }),
        }));
        delete pending[rid];
        changed = true;
      }
    }
    for (const [pid2, p] of Object.entries(pendingPerm)) {
      if (p.ownerPid !== process.pid || !p.answered) continue;
      p.selfAnswered = true;
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
        delete pendingPerm[pid2];
        changed = true;
      }
    }
    if (changed) {
      await writeJson(PENDING_FILE, pending);
      await writeJson(PERM_FILE, pendingPerm);
    }
  } catch (err) {
    dbg("PROCESS ANSWERED THROW " + String(err));
    await flushDbg();
  }
}

// Auto-reject questions stuck for longer than questionTimeoutMinutes.
async function expireQuestions(client: AnyClient): Promise<void> {
  const timeoutMs = (cfg.options?.questionTimeoutMinutes ?? 30) * 60_000;
  let changed = false;
  for (const [rid, req] of Object.entries(pending)) {
    if (req.ownerPid !== process.pid) continue;
    if (!req.createdAt || Date.now() - req.createdAt < timeoutMs) continue;
    req.selfAnswered = true;
    const ok = await replyToQuestion(client, rid, null);
    for (const it of req.items) await tgEdit(it.msgId, t("q.timeout"));
    delete pending[rid];
    changed = true;
  }
  if (changed) await writeJson(PENDING_FILE, pending);
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
const DEFAULT_OPTIONS: OptionsCfg = { showCost: true, questionTimeoutMinutes: 30 };

// ---------- i18n ----------

type LangDict = Record<string, string>;

const BUILTIN_LANGS: Record<string, LangDict> = {
  ru: {
    "btn.once": "✅ Разово",
    "btn.always": "♾ Всегда",
    "btn.reject": "✕ Отклонить",
    "btn.done": "✔️ Готово",
    "hint.custom": "\n💬 Ответь на это сообщение текстом",

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

// ---------- plugin ----------

// @ts-ignore
export const TelegramNotify: Plugin = async ({ client }) => {
  const c = client as AnyClient;
  // DATA_DIR is created lazily: Bun.write creates parent directories itself.
  await loadCreds();
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
    void processAnswered(c);
    void expireQuestions(c);
    void flushDigest();
  }, 2000);

  return {
    event: async ({ event }: { event: Record<string, unknown> }) => {
const type = event?.type as string | undefined;
      // Events come in v2 format: fields are nested in properties.
      const ev = ((event?.properties ?? event) ?? {}) as Record<string, unknown>;
      if (type && isInteresting(type)) {
        dbg("EVENT " + type + " :: " + JSON.stringify(event).slice(0, 600));
        await flushDbg();
      }

      if (type === "session.idle") {
        const id = String(ev.sessionID ?? "");
        if (!id || throttle("idle:" + id)) return;
        const [task0, dur, info] = await Promise.all([
          taskText(c, id),
          taskDuration(c, id),
          sessionInfo(c, id, true), // fresh: cost grows during the session
        ]);
        const task = taskLabel(info, task0);
        if (!notifyEnabled("done") || !projectAllowed(projectTag(info))) return;
        if (isQuietHour()) return;
        const name = projectTag(info);
        const agent = agentTag(info, task);
        const cost = (cfg.options?.showCost ?? true) && info?.cost ? " · $" + info.cost.toFixed(2) : "";
        await sendOrDigest(renderTemplate(fmt("done"), {
          ...projectVars(name),
          done: emoji("done"),
          task: truncate(task),
          agent: agent ? " [" + agent + "]" : "",
          duration: dur ? fmtDuration(dur) : "",
          cost,
        }), true);
        return;
      }

      if (type === "session.error" || type === "session.execution.failed" || type === "session.step.failed") {
        const id = String(ev.sessionID ?? "");
        if (throttle("error:" + id)) return;
        const task0 = id ? await taskText(c, id) : "opencode";
        const info = id ? await sessionInfo(c, id) : null;
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
        const info = await sessionInfo(c, id);
        const name = projectTag(info);
        if (throttle("perm:" + id)) return;
        const permId = String(ev.id ?? "");
        const tool = (ev.tool ?? ev.source) as { messageID?: string } | undefined;
        const toolMsgId = String(tool?.messageID ?? "");
        // The same operation asked again (opencode re-asks with a new permId) —
        // don't duplicate the message, just update the current id for the buttons.
        if (toolMsgId) {
          const existing = Object.entries(pendingPerm).find(([, e]) => e.toolMsgId === toolMsgId);
          if (existing) {
            existing[1].currentId = permId;
            await writeJson(PERM_FILE, pendingPerm);
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
          pendingPerm[permId] = { sessionID: id, ownerPid: process.pid, msgId, permission, currentId: permId, toolMsgId, project: name, target };
          await writeJson(PERM_FILE, pendingPerm);
        }
        return;
      }

      if (type === "permission.replied") {
        const permId = String(ev.requestID ?? "");
        const p = pendingPerm[permId] ?? Object.values(pendingPerm).find((e) => e.currentId === permId);
        if (!p) return;
        if (p.selfAnswered) {
          delete pendingPerm[permId];
          await writeJson(PERM_FILE, pendingPerm);
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
        delete pendingPerm[permId];
        await writeJson(PERM_FILE, pendingPerm);
        return;
      }

      if (type === "question.asked") {
        const rid = String(ev.id ?? "");
        const info = await sessionInfo(c, String(ev.sessionID ?? ""));
        const proj = projectTag(info);
        const qs = (ev.questions ?? []) as QInfo[];
        if (!rid || !qs.length || throttle("q:" + rid)) return;
        if (!notifyEnabled("questions") || !projectAllowed(proj)) return;
        const items: PendingReq["items"] = [];
        for (let i = 0; i < qs.length; i++) {
          const q = qs[i] as QInfo;
          const custom = q.custom === true || !(q.options ?? []).length;
          const text = renderTemplate(fmt("question"), {
            ...projectVars(proj),
            question: emoji("question"),
            question_text: (q.header ? q.header + "\n" : "") + truncate(q.question || t("q.fallback")),
            options: (q.options ?? []).map((o) => o.label).join(", "),
          }) + (custom ? t("hint.custom") : "");
          const buttons: TgButton[][] = [];
          (q.options ?? []).forEach((o, oi) => {
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
          pending[rid] = { items, ownerPid: process.pid, project: proj, createdAt: Date.now() };
          await writeJson(PENDING_FILE, pending);
        }
        return;
      }

      if (type === "question.replied" || type === "question.rejected") {
        const rid = String(ev.requestID ?? "");
        const req = pending[rid];
        if (!req) return;
        if (req.selfAnswered) {
          delete pending[rid];
          await writeJson(PENDING_FILE, pending);
          return;
        }
        const status = type === "question.replied" ? t("q.repliedTerminal") : t("q.rejectedTerminal");
        for (const item of req.items) await tgEdit(item.msgId, status);
        delete pending[rid];
        await writeJson(PENDING_FILE, pending);
      }
    },
  };
};

export default TelegramNotify;