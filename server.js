import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import qrcode from "qrcode";
import fs from "fs";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";

// مصادقة بسيطة
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (token !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// مجلد الجلسات
if (!fs.existsSync("./sessions")) fs.mkdirSync("./sessions", { recursive: true });

// ===== حالة واتساب =====
let client;
let qrDataUrl = null;
let isReady = false;

// ===== اختيار المجموعات =====
let selectedGroupIds = [];
let SELECTED_GROUP_IDS = new Set();

// ===== حالة البوت/العملاء/الإعدادات =====
let RUNNING = false;
let CLIENTS = []; // [{ name, emoji? }]
let SETTINGS = {
  mode: "emoji",          // "emoji" | "text"
  emoji: "✅",
  replyText: "تم ✅",
  threshold: 0.6,         // 0..1 (يمكن إرسال 60% من الواجهة، نحول هنا)
  cooldown: 3,            // ثواني
  rateLimit: 20,          // ردود/دقيقة كحد أقصى
  mustInclude: "",
  mustExclude: "",
  normalizeArabic: true,
  enableOCR: false,
  instantEyes: true,
  timezone: "auto",
  startDate: "",
  startTime: "",
  dryRun: false,
  historyOnStart: false,
  historyLimit: 200
};

// ===== لوج + طابور =====
let LOGS = [];
let MSG_QUEUE = []; // عناصر: {type:"live", msg} أو {type:"history", jid, body}
function addLog(event, data = {}) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  LOGS.unshift(entry);
  if (LOGS.length > 200) LOGS.pop();
}

// ===== أدوات مطابقة/سرعة =====
const lastActionByChat = new Map(); // jid -> timestamp
let actionsWindow = []; // آخر دقيقة

function canAct(jid) {
  const now = Date.now();
  // cooldown per chat
  const last = lastActionByChat.get(jid) || 0;
  if ((now - last) / 1000 < Number(SETTINGS.cooldown || 0)) return false;

  // global rate limit per minute
  const perMin = Number(SETTINGS.rateLimit) || 20;
  actionsWindow = actionsWindow.filter((t) => now - t < 60_000);
  if (actionsWindow.length >= perMin) return false;
  return true;
}
function markAct(jid) {
  const now = Date.now();
  lastActionByChat.set(jid, now);
  actionsWindow.push(now);
}

// تطبيع نص عربي مبسط
const norm = (s = "") =>
  SETTINGS.normalizeArabic
    ? s
        .toLowerCase()
        .replace(/[ًٌٍَُِّْـ]/g, "")
        .replace(/[أإآ]/g, "ا")
        .replace(/ة/g, "ه")
        .replace(/ى/g, "ي")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    : (s || "").toLowerCase().trim();

// تشابه مبسط: نسبة كلمات الاسم الموجودة بالنص
function similarity(name, text) {
  name = norm(name);
  text = norm(text);
  if (!name || !text) return 0;
  if (text.includes(name)) return 1;
  const parts = name.split(" ").filter(Boolean);
  if (!parts.length) return 0;
  let hit = 0;
  for (const p of parts) if (text.includes(p)) hit++;
  return hit / parts.length;
}

// ===== المعالجة الموحدة لرسالة واحدة =====
async function processOneMessage(jid, body, rawMsg) {
  if (!RUNNING) return "skip:not_running";
  const isGroup = jid.endsWith("@g.us");
  if (!isGroup) return "skip:not_group";

  // لو ما في اختيار، نعتبر كل المجموعات مسموحة؛ ولو في اختيار، نقيّد عليها
  if (SELECTED_GROUP_IDS.size > 0 && !SELECTED_GROUP_IDS.has(jid)) return "skip:not_selected";
  if (!body) return "skip:no_text";

  const T = norm(body);

  if (SETTINGS.mustInclude) {
    const need = norm(SETTINGS.mustInclude).split(" ").filter(Boolean);
    if (!need.every((w) => T.includes(w))) return "skip:mustInclude";
  }
  if (SETTINGS.mustExclude) {
    const ban = norm(SETTINGS.mustExclude).split(" ").filter(Boolean);
    if (ban.some((w) => T.includes(w))) return "skip:mustExclude";
  }

  const th = Number(SETTINGS.threshold) || 0.6;
  let matched = null;
  let matchedEmoji = SETTINGS.emoji || "✅";
  for (const c of CLIENTS) {
    const sc = similarity(c.name || "", T);
    if (sc >= th) {
      matched = c;
      if (c.emoji) matchedEmoji = c.emoji;
      break;
    }
  }
  if (!matched) return "skip:no_match";

  if (!canAct(jid)) return "skip:rate_or_cooldown";

  if (!SETTINGS.dryRun) {
    try {
      if (SETTINGS.mode === "emoji") {
        if (rawMsg?.react) {
          await rawMsg.react(matchedEmoji);
        } else if (rawMsg?.reply) {
          await rawMsg.reply(matchedEmoji);
        } else {
          await client.sendMessage(jid, matchedEmoji);
        }
      } else {
        if (rawMsg?.reply) await rawMsg.reply(SETTINGS.replyText || "تم ✅");
        else await client.sendMessage(jid, SETTINGS.replyText || "تم ✅");
      }
    } catch (e) {
      console.log("send fail:", e.message);
    }
  }

  markAct(jid);
  addLog("acted", { jid, preview: body.slice(0, 80) });
  return "ok";
}

// ===== تهيئة واتساب =====
function initWhatsApp() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: "./sessions" }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }
  });

  client.on("qr", async (qr) => {
    qrDataUrl = await qrcode.toDataURL(qr);
    isReady = false;
    addLog("qr_ready");
    console.log("🔑 QR جاهز للمسح");
  });

  client.on("ready", () => {
    isReady = true;
    qrDataUrl = null;
    addLog("wa_ready");
    console.log("✅ واتساب جاهز");
  });

  client.on("disconnected", (reason) => {
    console.log("❌ تم قطع الاتصال:", reason);
    addLog("wa_disconnected", { reason });
    isReady = false;
    setTimeout(() => client.initialize(), 2000);
  });

  // استقبال الرسائل الحية → ندخلها الطابور
  client.on("message", async (msg) => {
    try {
      if (msg.fromMe) return;
      addLog("message_in", { from: msg.from, body: (msg.body || "").slice(0, 120) });
      MSG_QUEUE.push({ type: "live", msg });
    } catch (e) {
      console.error("enqueue error:", e.message);
    }
  });

  client.initialize();
}
initWhatsApp();

// ===== عامل الطابور (كل 400ms) =====
setInterval(async () => {
  try {
    if (!RUNNING) return;
    if (!MSG_QUEUE.length) return;
    const item = MSG_QUEUE.shift();
    if (!item) return;

    if (item.type === "live") {
      const m = item.msg;
      const jid = m.from || "";
      await processOneMessage(jid, m.body || "", m);
    } else if (item.type === "history") {
      const { jid, body } = item;
      await processOneMessage(jid, body, null);
    }
  } catch (e) {
    console.error("queue worker err:", e.message);
  }
}, 400);

// ============ API ============

// صحة الخادم
app.get("/health", (req, res) => {
  res.json({ status: "ok", isReady });
});

// إرجاع QR كـ DataURL
app.get("/session/qr", auth, (req, res) => {
  if (qrDataUrl) return res.json({ qr: qrDataUrl });
  if (isReady) return res.json({ message: "Already connected" });
  return res.status(503).json({ error: "QR not available yet" });
});

// عرض QR كصورة للتجربة
app.get("/session/qr-view", auth, (req, res) => {
  if (!qrDataUrl) return res.status(503).send("QR not ready");
  res.send(`<img src="${qrDataUrl}" style="max-width:320px">`);
});

// جلب المجموعات
app.get("/chats", auth, async (req, res) => {
  if (!isReady) return res.status(503).json({ error: "WhatsApp not ready" });
  try {
    const chats = await client.getChats();
    const groups = chats
      .filter((c) => c.isGroup)
      .map((c) => ({
        id: c.id._serialized,
        name: c.name,
        participants: Array.isArray(c.participants) ? c.participants.length : 0,
        isGroup: true
      }));
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// حفظ اختيار المجموعات
app.post("/groups/select", auth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids must be an array" });
  selectedGroupIds = ids;
  SELECTED_GROUP_IDS = new Set(ids);
  addLog("groups_select", { count: ids.length });
  res.json({ success: true, selectedGroupIds });
});

// رجوع الاختيار
app.get("/groups/selected", auth, (req, res) => {
  res.json({ selectedGroupIds: Array.from(SELECTED_GROUP_IDS) });
});

// بدء البوت
app.post("/bot/start", auth, (req, res) => {
  try {
    if (!isReady) return res.status(503).json({ error: "WhatsApp not ready" });

    const { clients = [], settings = {} } = req.body || {};
    CLIENTS = Array.isArray(clients) ? clients.filter((c) => c && c.name) : [];

    // دعم threshold كنسبة (60) أو كقيمة (0.6)
    const incomingTh = settings.threshold ?? SETTINGS.threshold;
    const th = Number(incomingTh);
    SETTINGS = {
      ...SETTINGS,
      ...settings,
      threshold: th > 1 ? th / 100 : th
    };

    RUNNING = true;
    addLog("bot_start", {
      clients: CLIENTS.length,
      groupsSelected: Array.from(SELECTED_GROUP_IDS),
      settings: SETTINGS
    });

    // تشغيل فحص الأرشيف تلقائيًا على البدء (اختياري)
    if (SETTINGS.historyOnStart) {
      (async () => {
        try {
          const limit = Math.min(Number(SETTINGS.historyLimit || 200), 1000);
          const groups = Array.from(SELECTED_GROUP_IDS);
          for (const gid of groups) {
            const chat = await client.getChatById(gid);
            const msgs = await chat.fetchMessages({ limit });
            msgs.reverse().forEach((m) => {
              if (m.fromMe) return;
              const body = m.body || "";
              if (!body) return;
              MSG_QUEUE.push({ type: "history", jid: gid, body });
            });
          }
          addLog("history_scan_autostart", { groups: groups.length, limit });
        } catch (e) {
          console.error("auto history scan fail:", e.message);
        }
      })();
    }

    return res.json({
      success: true,
      running: RUNNING,
      clients: CLIENTS.length,
      groupsSelected: SELECTED_GROUP_IDS.size
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// إيقاف البوت
app.post("/bot/stop", auth, (req, res) => {
  RUNNING = false;
  addLog("bot_stop");
  res.json({ success: true, running: RUNNING });
});

// فحص الأرشيف يدويًا
app.post("/history/scan", auth, async (req, res) => {
  try {
    if (!isReady) return res.status(503).json({ error: "WhatsApp not ready" });
    const limit = Math.min(Number(req.body?.limit || 200), 1000);
    const groups =
      Array.isArray(req.body?.groups) && req.body.groups.length
        ? req.body.groups
        : Array.from(SELECTED_GROUP_IDS);

    if (!groups.length) return res.status(400).json({ error: "no groups selected" });

    let enq = 0;
    for (const gid of groups) {
      const chat = await client.getChatById(gid);
      const msgs = await chat.fetchMessages({ limit });
      msgs.reverse().forEach((m) => {
        if (m.fromMe) return;
        const body = m.body || "";
        if (!body) return;
        MSG_QUEUE.push({ type: "history", jid: gid, body });
        enq++;
      });
    }
    addLog("history_scan", { groups: groups.length, enqueued: enq, limit });
    res.json({ ok: true, groups: groups.length, enqueued: enq });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// مسح الطابور يدويًا (اختياري)
app.post("/queue/flush", auth, (req, res) => {
  const n = MSG_QUEUE.length;
  MSG_QUEUE = [];
  res.json({ ok: true, cleared: n });
});

// لوج
app.get("/logs", auth, (req, res) => {
  res.json(LOGS);
});

// Debug سريع (يدعم query k)
app.get("/debug", (req, res) => {
  const token =
    (req.headers.authorization || "").replace("Bearer ", "") || (req.query.k || "");
  if (token !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    isReady,
    running: RUNNING,
    selectedGroupIds: Array.from(SELECTED_GROUP_IDS),
    clients: CLIENTS,
    settings: SETTINGS,
    queueSize: MSG_QUEUE.length
  });
});

// اختبار إرسال
app.get("/test/send", async (req, res) => {
  const token =
    (req.headers.authorization || "").replace("Bearer ", "") || (req.query.k || "");
  if (token !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    if (!isReady) return res.status(503).json({ error: "WhatsApp not ready" });
    const { gid, text = "PONG" } = req.query;
    if (!gid) return res.status(400).json({ error: "gid required" });
    await client.sendMessage(gid, text);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
