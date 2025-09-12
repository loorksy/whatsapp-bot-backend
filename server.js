import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import qrcode from "qrcode";
import fs from "fs";
import pkg from "whatsapp-web.js"; // ✅ whatsapp-web.js
const { Client, LocalAuth } = pkg;

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";

// مصادقة بسيطة بالـ Bearer
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

// نخزن IDs المجموعات المختارة هنا
let selectedGroupIds = []; // Array<string>
let SELECTED_GROUP_IDS = new Set(); // Set<string>

// ===== حالة البوت/الإعدادات/العملاء =====
let RUNNING = false;
let CLIENTS = []; // [{ name, emoji? }]
let SETTINGS = {
  mode: "emoji",          // "emoji" | "text"
  emoji: "✅",
  replyText: "تم ✅",
  threshold: 0.6,         // 0..1
  cooldown: 3,            // ثواني بين ردّين في نفس الشات
  rateLimit: 20,          // حد أقصى / الدقيقة (عام)
  mustInclude: "",        // كلمات مطلوبة (مسافة تفصل بين الكلمات)
  mustExclude: "",        // كلمات تمنع التفاعل
  normalizeArabic: true,
  enableOCR: false,       // placeholder (غير مفعّل هنا)
  instantEyes: true,      // placeholder
  timezone: "auto",
  startDate: "",
  startTime: "",
  dryRun: false
};

// تطبيع نص عربي مبسّط
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

// تشابه مبسّط: نسبة كلمات الاسم الموجودة بالنص
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

// حدود السرعة/الكول داون
const lastActionByChat = new Map(); // jid -> timestamp
let actionsWindow = []; // آخر دقيقة (timestamps)

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

// تهيئة واتساب
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
    console.log("🔑 QR جاهز للمسح");
  });

  client.on("ready", () => {
    isReady = true;
    qrDataUrl = null;
    console.log("✅ واتساب جاهز");
  });

  client.on("disconnected", (reason) => {
    console.log("❌ تم قطع الاتصال:", reason);
    isReady = false;
    // إعادة المحاولة
    setTimeout(() => client.initialize(), 2000);
  });

  // الاستماع للرسائل
  client.on("message", async (msg) => {
    try {
      if (!RUNNING) return;

      const jid = msg.from || "";
      const isGroup = jid.endsWith("@g.us");
      if (!isGroup) return; // نهتم بالمجموعات فقط
      if (!SELECTED_GROUP_IDS.has(jid)) return; // ليست ضمن المختارة

      // تجاهل رسائلنا نحن
      if (msg.fromMe) return;

      // نص الرسالة/التعليق
      const text = msg.body || "";
      const T = norm(text);

      // شروط الكلمات
      if (SETTINGS.mustInclude) {
        const need = norm(SETTINGS.mustInclude).split(" ").filter(Boolean);
        const ok = need.every((w) => T.includes(w));
        if (!ok) return;
      }
      if (SETTINGS.mustExclude) {
        const ban = norm(SETTINGS.mustExclude).split(" ").filter(Boolean);
        const bad = ban.some((w) => T.includes(w));
        if (bad) return;
      }

      // المطابقة مع العملاء
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
      if (!matched) return;

      // حدود السرعة
      if (!canAct(jid)) return;

      // الرد
      if (!SETTINGS.dryRun) {
        if (SETTINGS.mode === "emoji") {
          // تفاعل إيموجي
          // مدعوم في whatsapp-web.js >= 1.20 تقريبًا
          try {
            await msg.react(matchedEmoji);
          } catch (e) {
            // بديل: إرسال رسالة قصيرة بدل الريأكشن
            await msg.reply(matchedEmoji);
          }
        } else {
          await msg.reply(SETTINGS.replyText || "تم ✅");
        }
      }

      // علِّم التنفيذ (لحدود السرعة/الكول داون)
      markAct(jid);
    } catch (e) {
      console.error("message handler error:", e.message);
    }
  });

  client.initialize();
}
initWhatsApp();

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

// جلب المجموعات بعد الاتصال
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

// حفظ اختيار المجموعات (IDs)
app.post("/groups/select", auth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids))
    return res.status(400).json({ error: "ids must be an array" });
  selectedGroupIds = ids;
  SELECTED_GROUP_IDS = new Set(ids);
  res.json({ success: true, selectedGroupIds });
});

// إرجاع الاختيار الحالي
app.get("/groups/selected", auth, (req, res) => {
  res.json({ selectedGroupIds });
});

// بدء البوت: نحفظ العملاء/الإعدادات ونشغّل
app.post("/bot/start", auth, (req, res) => {
  try {
    if (!isReady)
      return res.status(503).json({ error: "WhatsApp not ready" });

    const { clients = [], groups = [], settings = {} } = req.body || {};
    // العملاء (من الواجهة: [{name,emoji?}])
    CLIENTS = Array.isArray(clients) ? clients.filter(c => c && c.name) : [];

    // الإعدادات
    SETTINGS = {
      ...SETTINGS,
      ...settings,
      threshold: Math.max(0, Math.min(1, Number(settings.threshold || SETTINGS.threshold) / (settings.threshold > 1 ? 100 : 1))) // يدعم 60 أو 0.6
    };

    // لو في أسماء مجموعات فقط، نعتمد IDs المحفوظة من /groups/select
    // (الواجهة أصلاً ترسل /groups/select قبل البدء)
    RUNNING = true;

    console.log("▶️ BOT START",
      { clients: CLIENTS.length, groupsSelected: SELECTED_GROUP_IDS.size, settings: SETTINGS });

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
  console.log("⏸️ BOT STOP");
  res.json({ success: true, running: RUNNING });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
// === DEBUG & TEST endpoints (أضفها قبل app.listen) ===

// /debug: يُظهر حالة البوت الآن (يقبل الهيدر Authorization أو بارام k في الرابط)
app.get("/debug", (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "") || (req.query.k || "");
  if (token !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    isReady,
    running: RUNNING,
    selectedGroupIds: Array.from(SELECTED_GROUP_IDS),
    clients: CLIENTS,
    settings: SETTINGS
  });
});

// /test/send: يرسل رسالة تجريبية لمجموعة لتتأكد أن الإرسال يعمل
app.get("/test/send", async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "") || (req.query.k || "");
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
