import https from "node:https";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { db, getSetting, setSetting } from "./db.js";
import { exportData } from "./backup.js";
import {
  createUser,
  getUser,
  listUsers,
  setUserEnabled,
  isUserActive,
  summarize,
} from "./users.js";
import { getSystemStats } from "./system.js";
import { logActivity } from "./activity.js";
import { buildUserLinks } from "./links.js";
import { restartCore } from "./core.js";
import type { Inbound, UserWithInbounds } from "./types.js";

interface TgResult {
  ok: boolean;
  description?: string;
  result?: unknown;
}

function apiCall(token: string, method: string, payload: Record<string, unknown>): Promise<TgResult> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as TgResult);
          } catch {
            resolve({ ok: false, description: "invalid response" });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, description: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, description: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

function sendDocument(
  token: string,
  chatId: string,
  filename: string,
  content: string,
  caption: string,
): Promise<TgResult> {
  return new Promise((resolve) => {
    const boundary = `----SideRail${Date.now()}`;
    const parts: Buffer[] = [];
    const push = (s: string) => parts.push(Buffer.from(s, "utf8"));

    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="chat_id"\r\n\r\n');
    push(`${chatId}\r\n`);

    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="caption"\r\n\r\n');
    push(`${caption}\r\n`);

    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="parse_mode"\r\n\r\n');
    push(`HTML\r\n`);

    push(`--${boundary}\r\n`);
    push(
      `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
        "Content-Type: application/json\r\n\r\n",
    );
    push(content);
    push(`\r\n--${boundary}--\r\n`);

    const payload = Buffer.concat(parts);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendDocument`,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.length,
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as TgResult);
          } catch {
            resolve({ ok: false, description: "invalid response" });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, description: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, description: "timeout" });
    });
    req.write(payload);
    req.end();
  });
}

export interface BotConfig {
  enabled: boolean;
  token: string;
  chatIds: string[];
  dailyBackup: boolean;
}

export function getBotConfig(): BotConfig {
  return {
    enabled: getSetting("bot_enabled") === "1",
    token: getSetting("bot_token") || "",
    chatIds: JSON.parse(getSetting("bot_chat_ids") || "[]") as string[],
    dailyBackup: getSetting("bot_daily_backup") !== "0",
  };
}

export function saveBotConfig(cfg: Partial<BotConfig>): void {
  if (cfg.enabled !== undefined) setSetting("bot_enabled", cfg.enabled ? "1" : "0");
  if (cfg.token !== undefined) setSetting("bot_token", cfg.token.trim());
  if (cfg.chatIds !== undefined)
    setSetting("bot_chat_ids", JSON.stringify(cfg.chatIds.map((c) => c.trim()).filter(Boolean)));
  if (cfg.dailyBackup !== undefined) setSetting("bot_daily_backup", cfg.dailyBackup ? "1" : "0");
}

export async function broadcast(html: string): Promise<void> {
  const cfg = getBotConfig();
  if (!cfg.enabled || !cfg.token || cfg.chatIds.length === 0) return;
  for (const chatId of cfg.chatIds) {
    await apiCall(cfg.token, "sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
}

export async function testBot(
  token: string,
  chatIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!token || chatIds.length === 0) return { ok: false, error: "token and chat id required" };
  const message =
    "<b>✅ SideRail bot connected</b>\n\n" +
    '🔗 <a href="https://github.com/icubaby/SideRail">github.com/icubaby/SideRail</a>\n\n' +
    "⭐️ If you enjoy the project, please give it a star — it means a lot!";
  let anyOk = false;
  let lastError = "";
  for (const chatId of chatIds) {
    const res = await apiCall(token, "sendMessage", {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    });
    if (res.ok) anyOk = true;
    else lastError = res.description || "failed";
  }
  return anyOk ? { ok: true } : { ok: false, error: lastError };
}

export async function sendDailyBackup(): Promise<void> {
  const cfg = getBotConfig();
  if (!cfg.enabled || !cfg.token || cfg.chatIds.length === 0 || !cfg.dailyBackup) return;
  const data = JSON.stringify(exportData(), null, 2);
  const date = new Date().toISOString().slice(0, 10);
  const caption =
    "<b>🗄 SideRail daily backup</b>\n" +
    `<b>Date:</b> ${date}\n` +
    "Keep this file safe — you can restore it from the dashboard.";
  for (const chatId of cfg.chatIds) {
    await sendDocument(cfg.token, chatId, `siderail-backup-${date}.json`, data, caption);
  }
}

// ---------------------------------------------------------------------------
// Telegram bot: user menu (buttons), credit system, admin commands
// ---------------------------------------------------------------------------

export const KEY_DAYS = 3;
export const REFERRAL_BONUS = 5;

// Packages users can buy with credits. sizes = GB per key.
export const KEY_PACKAGES: Record<string, { label: string; credits: number; sizes: number[] }> = {
  p500: { label: "500 MB · 1 key", credits: 1, sizes: [0.5] },
  p1gb: { label: "1 GB · 1 key", credits: 3, sizes: [1] },
  p3gb: { label: "3 GB · 1 key", credits: 5, sizes: [3] },
  p2x250: { label: "250 MB × 2 keys", credits: 5, sizes: [0.25, 0.25] },
};

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
}

interface TgCallback {
  id: string;
  from: { id: number };
  data?: string;
  message?: TgMessage;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

type Markup = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pollOffset = 0;
let botUsername = "";

function ensureBotTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_users (
      chat_id TEXT PRIMARY KEY,
      credits INTEGER NOT NULL DEFAULT 0,
      referred_by TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

function enabledInbounds(): Inbound[] {
  return db.prepare("SELECT * FROM inbounds WHERE enabled = 1").all() as unknown as Inbound[];
}

/** Returns true when the user was newly created. */
function registerBotUser(chatId: string, referrer: string | null): boolean {
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO bot_users (chat_id, credits, referred_by, created_at) VALUES (?, 0, ?, ?)",
    )
    .run(chatId, referrer, Date.now());
  return info.changes > 0;
}

function botUserExists(chatId: string): boolean {
  return !!db.prepare("SELECT 1 FROM bot_users WHERE chat_id = ?").get(chatId);
}

function getCredits(chatId: string): number {
  const row = db.prepare("SELECT credits FROM bot_users WHERE chat_id = ?").get(chatId) as
    | { credits: number }
    | undefined;
  return row?.credits ?? 0;
}

function addCredits(chatId: string, n: number): void {
  db.prepare("UPDATE bot_users SET credits = credits + ? WHERE chat_id = ?").run(n, chatId);
}

/** Atomic check-and-deduct, so two taps can't spend the same credits twice. */
function spendCredits(chatId: string, n: number): boolean {
  const info = db
    .prepare("UPDATE bot_users SET credits = credits - ? WHERE chat_id = ? AND credits >= ?")
    .run(n, chatId, n);
  return info.changes > 0;
}

async function sendText(token: string, chatId: string, html: string, markup?: Markup): Promise<void> {
  await apiCall(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(markup ? { reply_markup: markup } : {}),
  });
}

async function editText(
  token: string,
  chatId: string,
  messageId: number,
  html: string,
  markup: Markup,
): Promise<void> {
  await apiCall(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: markup,
  });
}

function fmtSize(gb: number): string {
  return gb >= 1 ? `${gb} GB` : `${Math.round(gb * 1024)} MB`;
}

/** Creates one key per size and sends each config to the chat. Caller validates first. */
async function sendKeys(
  token: string,
  chatId: string,
  sizes: number[],
  days: number,
  label: string,
): Promise<void> {
  const host = config.publicDomain;
  const inbounds = enabledInbounds();
  const inboundIds = inbounds.map((ib) => ib.id);

  const created: { name: string; size: number; user: UserWithInbounds }[] = sizes.map((size) => {
    const name = `tg${chatId}-${randomBytes(3).toString("hex")}`;
    const user = createUser({
      email: name,
      dataLimit: size,
      expireDays: days,
      telegramId: chatId,
      comment: `bot: ${label}`,
      inboundIds,
      createdBy: null,
    });
    return { name, size, user };
  });

  restartCore();

  for (const [i, k] of created.entries()) {
    await sendText(
      token,
      chatId,
      `✅ <b>${escHtml(label)}</b>${sizes.length > 1 ? ` (${i + 1}/${sizes.length})` : ""}\n` +
        `<b>Name:</b> <code>${escHtml(k.name)}</code>\n` +
        `<b>Data:</b> ${fmtSize(k.size)}\n<b>Days:</b> ${days}`,
    );
    const links = buildUserLinks(host, k.user, inbounds);
    for (const l of links) {
      await sendText(token, chatId, `<b>${escHtml(l.tag)}</b>\n<code>${escHtml(l.link)}</code>`);
    }
  }
}

const homeMarkup = (chatId: string): Markup => {
  const rows: Markup["inline_keyboard"] = [
    [{ text: "🔑 Key ထုတ်မယ်", callback_data: "menu:buy" }],
    [
      { text: "💰 Credit", callback_data: "menu:balance" },
      { text: "🎁 Referral", callback_data: "menu:ref" },
    ],
  ];
  if (isAdminChat(chatId)) rows.push([{ text: "🛠 Admin", callback_data: "adm:home" }]);
  return { inline_keyboard: rows };
};

const homeText = (chatId: string): string =>
  `<b>SideRail</b>\nCredit ကျန်: <b>${getCredits(chatId)}</b>`;

const buyMarkup = (): Markup => ({
  inline_keyboard: [
    ...Object.entries(KEY_PACKAGES).map(([id, p]) => [
      { text: `${p.label} · ${p.credits} credit`, callback_data: `buy:${id}` },
    ]),
    [{ text: "⬅️ နောက်သို့", callback_data: "menu:home" }],
  ],
});

const isAdminChat = (chatId: string): boolean => getBotConfig().chatIds.includes(chatId);

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

const USERS_PAGE_SIZE = 8;

const adminMarkup = (): Markup => ({
  inline_keyboard: [
    [{ text: "🖥 Server status", callback_data: "adm:server" }],
    [{ text: "👥 Users", callback_data: "adm:users:0" }],
    [{ text: "⬅️ နောက်သို့", callback_data: "menu:home" }],
  ],
});

function serverText(): string {
  const s = getSystemStats();
  const sum = summarize(listUsers());
  return (
    `<b>🖥 Server status</b>\n` +
    `Xray: ${s.xray.running ? "🟢 running" : "🔴 stopped"} (v${escHtml(s.xray.version)})\n` +
    `CPU: ${s.cpu.usage}% · RAM: ${s.ram.usage}% (${fmtBytes(s.ram.used)} / ${fmtBytes(s.ram.total)})\n` +
    `Disk: ${s.storage.usage}% · Free ${fmtBytes(s.storage.free)}\n` +
    `Server uptime: ${fmtDuration(s.uptime)} · Xray uptime: ${fmtDuration(s.xray.uptime)}\n` +
    `IP: <code>${escHtml(s.ip.address || "-")}</code> ${escHtml(s.ip.location || "")}\n\n` +
    `<b>Users</b>: ${sum.clients} · 🟢 online ${sum.online} · ✅ active ${sum.active} · ⚠️ depleting ${sum.depleting}`
  );
}

function userStatusIcon(u: UserWithInbounds): string {
  if (!u.enabled) return "⛔";
  if (!isUserActive(u)) return "⌛";
  return u.online ? "🟢" : "✅";
}

function usersPage(page: number): { text: string; markup: Markup } {
  const all = listUsers();
  const pages = Math.max(1, Math.ceil(all.length / USERS_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows: Markup["inline_keyboard"] = all
    .slice(p * USERS_PAGE_SIZE, (p + 1) * USERS_PAGE_SIZE)
    .map((u) => [{ text: `${userStatusIcon(u)} ${u.email}`, callback_data: `adm:u:${u.id}` }]);

  const nav: { text: string; callback_data: string }[] = [];
  if (p > 0) nav.push({ text: "⬅️", callback_data: `adm:users:${p - 1}` });
  nav.push({ text: `${p + 1}/${pages}`, callback_data: `adm:users:${p}` });
  if (p < pages - 1) nav.push({ text: "➡️", callback_data: `adm:users:${p + 1}` });
  rows.push(nav);
  rows.push([{ text: "⬅️ Admin", callback_data: "adm:home" }]);

  return {
    text:
      `<b>👥 Users</b> (${all.length})\n` +
      `🟢 online · ✅ active · ⌛ expired/limit · ⛔ disabled`,
    markup: { inline_keyboard: rows },
  };
}

function userText(u: UserWithInbounds): string {
  const limit = u.data_limit > 0 ? fmtBytes(u.data_limit) : "∞";
  const exp = u.expire_at ? new Date(u.expire_at).toISOString().slice(0, 10) : "∞";
  const state = !u.enabled ? "⛔ disabled" : !isUserActive(u) ? "⌛ expired / limit reached" : "✅ active";
  return (
    `<b>👤 ${escHtml(u.email)}</b>\n` +
    `ID: ${u.id}\n` +
    `Telegram: <code>${escHtml(u.telegram_id || "-")}</code>\n` +
    `Status: ${state}\n` +
    `Usage: ${fmtBytes(u.total)} / ${limit}\n` +
    `Expire: ${exp}\n` +
    `Created by: ${escHtml(u.creator || "-")}`
  );
}

function userMarkup(u: UserWithInbounds): Markup {
  return {
    inline_keyboard: [
      [
        {
          text: u.enabled ? "⛔ Key ပိတ်မယ်" : "✅ Key ပြန်ဖွင့်မယ်",
          callback_data: `adm:t:${u.id}`,
        },
      ],
      [{ text: "⬅️ Users", callback_data: "adm:users:0" }],
    ],
  };
}

async function handleAdminCallback(
  token: string,
  chatId: string,
  messageId: number | undefined,
  data: string,
): Promise<void> {
  const show = (text: string, markup: Markup) =>
    messageId ? editText(token, chatId, messageId, text, markup) : sendText(token, chatId, text, markup);
  const parts = data.split(":");

  if (data === "adm:home") {
    await show("<b>🛠 Admin</b>", adminMarkup());
  } else if (data === "adm:server") {
    await show(serverText(), {
      inline_keyboard: [
        [{ text: "🔄 Refresh", callback_data: "adm:server" }],
        [{ text: "⬅️ Admin", callback_data: "adm:home" }],
      ],
    });
  } else if (parts[1] === "users") {
    const v = usersPage(Number(parts[2]) || 0);
    await show(v.text, v.markup);
  } else if (parts[1] === "u" || parts[1] === "t") {
    const id = Number(parts[2]);
    if (parts[1] === "t") {
      const current = getUser(id);
      if (current) {
        setUserEnabled(id, !current.enabled);
        restartCore();
        logActivity("telegram-bot", current.enabled ? "user_disable" : "user_enable", current.email);
      }
    }
    const u = getUser(id);
    if (!u) {
      await show("❌ User မတွေ့ပါ။", adminMarkup());
    } else {
      await show(userText(u), userMarkup(u));
    }
  }
}

async function handleBuy(token: string, chatId: string, pkgId: string): Promise<void> {
  const pkg = KEY_PACKAGES[pkgId];
  if (!pkg) {
    await sendText(token, chatId, "❌ Package မတွေ့ပါ။");
    return;
  }
  if (!config.publicDomain) {
    await sendText(token, chatId, "⚠️ Server မှာ <code>PUBLIC_DOMAIN</code> မသတ်မှတ်ရသေးပါ။ Admin ကို ပြောပါ။");
    return;
  }
  if (enabledInbounds().length === 0) {
    await sendText(token, chatId, "⚠️ ရောင်းလို့ရတဲ့ inbound မရှိသေးပါ။ Admin ကို ပြောပါ။");
    return;
  }

  if (!spendCredits(chatId, pkg.credits)) {
    await sendText(
      token,
      chatId,
      `❌ Credit မလုံလောက်ပါ။\nလိုအပ်: <b>${pkg.credits}</b> · ရှိ: <b>${getCredits(chatId)}</b>`,
      homeMarkup(chatId),
    );
    return;
  }

  try {
    await sendKeys(token, chatId, pkg.sizes, KEY_DAYS, pkg.label);
  } catch (e) {
    console.error("[bot] buy failed, refunding:", e);
    addCredits(chatId, pkg.credits);
    await sendText(token, chatId, "⚠️ Key ထုတ်မရပါ။ Credit ကို ပြန်ထည့်ပေးပြီးပါပြီ။");
  }
}

async function handleCallback(token: string, cb: TgCallback): Promise<void> {
  // acknowledge the tap so Telegram stops the loading spinner
  await apiCall(token, "answerCallbackQuery", { callback_query_id: cb.id });

  const chatId = String(cb.message?.chat.id ?? cb.from.id);
  const messageId = cb.message?.message_id;
  const data = cb.data || "";
  registerBotUser(chatId, null);

  if (data.startsWith("adm:")) {
    if (!isAdminChat(chatId)) return;
    await handleAdminCallback(token, chatId, messageId, data);
    return;
  }

  if (data === "menu:home" && messageId) {
    await editText(token, chatId, messageId, homeText(chatId), homeMarkup(chatId));
  } else if (data === "menu:buy" && messageId) {
    await editText(token, chatId, messageId, "<b>Package ရွေးပါ</b>", buyMarkup());
  } else if (data === "menu:balance") {
    await sendText(token, chatId, homeText(chatId), homeMarkup(chatId));
  } else if (data === "menu:ref") {
    const link = `https://t.me/${botUsername}?start=ref_${chatId}`;
    await sendText(
      token,
      chatId,
      `🎁 <b>Referral</b>\nသူငယ်ချင်း ဤလင့်ခ်နဲ့ ပထမဆုံး start လုပ်ရင် credit <b>+${REFERRAL_BONUS}</b> ရပါမယ်။\n\n<code>${escHtml(link)}</code>`,
    );
  } else if (data.startsWith("buy:")) {
    await handleBuy(token, chatId, data.slice(4));
  }
}

async function handleMessage(token: string, chatId: string, isAdmin: boolean, text: string): Promise<void> {
  const [raw, ...args] = text.split(/\s+/);
  const cmd = raw.split("@")[0].toLowerCase();

  if (cmd === "/start") {
    const refArg = args[0]?.startsWith("ref_") ? args[0].slice(4) : null;
    const isNew = registerBotUser(chatId, null);
    if (isNew && refArg && refArg !== chatId && botUserExists(refArg)) {
      db.prepare("UPDATE bot_users SET referred_by = ? WHERE chat_id = ?").run(refArg, chatId);
      addCredits(refArg, REFERRAL_BONUS);
      await sendText(token, refArg, `🎁 Referral bonus <b>+${REFERRAL_BONUS}</b> credit ရရှိပါပြီ။`);
    }
    await sendText(token, chatId, homeText(chatId), homeMarkup(chatId));
    return;
  }

  if (isAdmin && cmd === "/admin") {
    await sendText(token, chatId, "<b>🛠 Admin</b>", adminMarkup());
    return;
  }

  if (isAdmin && cmd === "/genkey") {
    const gb = Number(args[0]);
    const days = Math.floor(Number(args[1]));
    if (!(gb > 0) || !(days > 0)) {
      await sendText(token, chatId, "Usage: <code>/genkey &lt;GB&gt; &lt;days&gt;</code>");
      return;
    }
    await sendKeys(token, chatId, [gb], days, "Admin key");
    return;
  }

  if (isAdmin && cmd === "/credit") {
    const target = args[0];
    const amount = Math.floor(Number(args[1]));
    if (!target || !Number.isFinite(amount) || amount === 0) {
      await sendText(token, chatId, "Usage: <code>/credit &lt;chat_id&gt; &lt;amount&gt;</code>");
      return;
    }
    registerBotUser(target, null);
    addCredits(target, amount);
    await sendText(token, chatId, `✅ <code>${escHtml(target)}</code> ကို ${amount} credit ပြောင်းလဲပြီး — ယခု ${getCredits(target)}`);
    if (target !== chatId) {
      await sendText(token, target, `💰 Credit <b>${amount > 0 ? "+" : ""}${amount}</b> · ယခု ${getCredits(target)}`);
    }
    return;
  }

  // anything else: show the menu
  registerBotUser(chatId, null);
  await sendText(token, chatId, homeText(chatId), homeMarkup(chatId));
}

async function pollOnce(cfg: BotConfig): Promise<boolean> {
  const res = await apiCall(cfg.token, "getUpdates", {
    offset: pollOffset,
    timeout: 10,
    allowed_updates: ["message", "callback_query"],
  });
  if (!res.ok || !Array.isArray(res.result)) return false;

  for (const upd of res.result as TgUpdate[]) {
    pollOffset = upd.update_id + 1;
    try {
      if (upd.callback_query) {
        const m = upd.callback_query.message;
        if (m && m.chat.type !== "private") continue;
        await handleCallback(cfg.token, upd.callback_query);
      } else if (upd.message?.text && upd.message.chat.type === "private") {
        const chatId = String(upd.message.chat.id);
        const isAdmin = cfg.chatIds.includes(chatId);
        await handleMessage(cfg.token, chatId, isAdmin, upd.message.text.trim());
      }
    } catch (e) {
      console.error("[bot] update error:", e);
    }
  }
  return true;
}

export function startBotPolling(): void {
  void (async () => {
    ensureBotTables();
    for (;;) {
      const cfg = getBotConfig();
      if (!cfg.enabled || !cfg.token) {
        await delay(5000);
        continue;
      }
      try {
        if (!botUsername) {
          const me = await apiCall(cfg.token, "getMe", {});
          botUsername = ((me.result as { username?: string } | undefined)?.username) || "";
        }
        const ok = await pollOnce(cfg);
        if (!ok) await delay(3000);
      } catch (e) {
        console.error("[bot] polling error:", e);
        await delay(5000);
      }
    }
  })();
}
