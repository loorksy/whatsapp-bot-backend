import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import qrcode from "qrcode";
import fs from "fs";
import { Client, LocalAuth } from "whatsapp-web.js";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors()); // لاحقًا ممكن تخصّص origin

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

// حالة واتساب
let client;
let qrDataUrl = null;
let isReady = false;
let selectedGroupIds = []; // نخزن IDs المجموعات المختارة هنا (سنستقبلها من الواجهة)

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
    client.initialize();
  });

  client.initialize();
}
initWhatsApp();

// ============ API ============

// صحة الخادم
app.get("/health", (req, res) => {
  res.json({ status: "ok", isReady });
});

// إرجاع QR كـ DataURL (للاستهلاك من الواجهة)
app.get("/session/qr", auth, (req, res) => {
  if (qrDataUrl) return res.json({ qr: qrDataUrl });
  if (isReady) return res.json({ message: "Already connected" });
  return res.status(503).json({ error: "QR not available yet" });
});

// عرض QR سريعًا كصورة (اختياري للتجربة بالمتصفح)
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
      .filter(c => c.isGroup)
      .map(c => ({
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
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids must be an array" });
  selectedGroupIds = ids;
  res.json({ success: true, selectedGroupIds });
});

// (اختياري) إرجاع الاختيار الحالي
app.get("/groups/selected", auth, (req, res) => {
  res.json({ selectedGroupIds });
});

// نقاط بدء/إيقاف للبوت (سنكمل المنطق بالخطوات القادمة)
app.post("/bot/start", auth, (req, res) => {
  if (!isReady) return res.status(503).json({ error: "WhatsApp not ready" });
  // سنستخدم payload الإعدادات/العملاء لاحقًا
  res.json({ success: true, message: "Bot start accepted" });
});

app.post("/bot/stop", auth, (req, res) => {
  res.json({ success: true, message: "Bot stop accepted" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
