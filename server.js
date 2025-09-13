// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import qrcode from "qrcode";
import fs from "fs";
import pkg from "whatsapp-web.js";
import Tesseract from "tesseract.js";

const { Client, LocalAuth, MessageMedia } = pkg;

dotenv.config();
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";

// ====== مصادقة بسيطة ======
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (token !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ====== جلسات واتساب ======
const SESS_PATH = "./sessions"; // غيّر إلى مسار الـ Persistent Disk إن رغبت
if (!fs.existsSync(SESS_PATH)) fs.mkdirSync(SESS_PATH, { recursive: true });

let client;
let qrDataUrl = null;
let isReady = false;

// ====== إعدادات وتشغيل البوت ======
let running = false;
let selectedGroupIds = []; // IDs للمجموعات
let settings = {
  emoji: "✅",
  rateLimit: 20,        // أقصى تفاعلات بالدقيقة
  cooldown: 3,          // ثوانٍ بين تفاعلين متتاليين
  enableOCR: false,     // تحليل الصور
  archive: { enabled: false, startAt: null, limit: 200 }, // limit = رسائل لكل مجموعة
  clients: []           // [{name, emoji?}] من الواجهة
};

// ====== طابور لمعالجة الرسائل (انفجار الرسائل) ======
const queue = [];
let lastActionAt = 0;
function now() { return Date.now(); }

function normalizeArabic(s=""){
  return s
    .replace(/[إأآا]/g,'ا')
    .replace(/ى/g,'ي')
    .replace(/ؤ/g,'و')
    .replace(/ئ/g,'ي')
    .replace(/ة/g,'ه')
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}

// مطابقة اسم عميل
function matchClient(text){
  const t = normalizeArabic(text||"");
  for(const c of (settings.clients||[])){
    const name = normalizeArabic(c.name||"");
    if(!name) continue;
    if (t.includes(name)) return c; // مطابقة بسيطة بالاحتواء
  }
  return null;
}

// سجل بسيط في الذاكرة (آخر 500 بند)
const logs = [];
function log(obj){ logs.push({ ts: Date.now(), ...obj }); if(logs.length>500) logs.shift(); }

// تفاعل بإيموجي فقط
async function reactOnly(msg, emoji) {
  try {
    await msg.react(emoji || settings.emoji || "✅");
    log({ event:"react", jid: msg.from, preview: (msg.body||"").slice(0,80) });
  } catch (e) {
    log({ event:"react_error", err: String(e) });
  }
}

// OCR على الصور (إذا مفعّل)
async function extractTextFromMsg(msg){
  try{
    const media = await msg.downloadMedia();
    if (!media || media.mimetype.indexOf('image') !== 0) return "";
    const buf = Buffer.from(media.data, 'base64');
    const { data:{ text } } = await Tesseract.recognize(buf, 'ara+eng', { logger:()=>{} });
    return text || "";
  }catch(e){
    log({ event:"ocr_error", err:String(e) });
    return "";
  }
}

// معالج الطابور وفق rateLimit & cooldown
let throttleWindowStart = now();
let actionsThisMinute = 0;

async function processQueue(){
  if (!running || !isReady) return;
  const perMinute = settings.rateLimit || 20;
  const gap = Math.max(0, (settings.cooldown||0) * 1000);

  // نافذة الدقيقة
  const elapsed = now() - throttleWindowStart;
  if (elapsed >= 60000) { throttleWindowStart = now(); actionsThisMinute = 0; }

  if (actionsThisMinute >= perMinute) return; // انتظر بداية الدقيقة التالية
  if (now() - lastActionAt < gap) return;     // احترم المهلة بين التفاعلات
  const item = queue.shift();
  if (!item) return;

  try{
    // نفّذ التفاعل
    await reactOnly(item.msg, item.emoji);
    actionsThisMinute++;
    lastActionAt = now();
  }catch(e){
    log({ event:"queue_error", err:String(e) });
  }
}
setInterval(processQueue, 250);

// تهيئة واتساب
function initWhatsApp(){
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESS_PATH }),
    puppeteer: { headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] }
  });

  client.on("qr", async (qr) => {
    qrDataUrl = await qrcode.toDataURL(qr);
    isReady = false;
    log({ event:"qr_ready" });
  });

  client.on("ready", () => {
    isReady = true;
    qrDataUrl = null;
    log({ event:"ready" });
  });

  client.on("disconnected", (reason) => {
    isReady = false;
    running = false;
    log({ event:"disconnected", reason });
    client.initialize();
  });

  // استقبال الرسائل
  client.on("message", async (msg) => {
    try{
      if (!running) return;
      // فقط مجموعات مختارة
      if (!selectedGroupIds.includes(msg.from)) return;

      let content = msg.body || "";

      // OCR على الصور لو مفعّل
      if (settings.enableOCR && msg.hasMedia) {
        const text = await extractTextFromMsg(msg);
        if (text) content += " " + text;
      }

      const matched = matchClient(content);
      if (matched) {
        queue.push({ msg, emoji: matched.emoji || settings.emoji || "✅" });
        log({ event:"enqueue", from: msg.from, preview: (content||"").slice(0,80) });
      }
    }catch(e){
      log({ event:"message_error", err:String(e) });
    }
  });

  client.initialize();
}
initWhatsApp();

// ====== الأرشيف: مسح رسائل قديمة منذ وقت معيّن ======
async function scanHistory({ startAt, limit=200 }){
  if (!isReady) throw new Error("WhatsApp not ready");
  if (!running) log({ event:"history_scan", note:"running is false (still scanning)" });

  const startTs = startAt ? new Date(startAt).getTime() : null;
  if (!startTs) throw new Error("startAt is required");

  let enqueued = 0;

  for (const gid of selectedGroupIds){
    try{
      const chat = await client.getChatById(gid);
      // نحاول جلب على دفعات حتى نتجاوز startTs أو ننتهي
      let fetchedAll = false;
      let before; // message id boundary (غير ضروري إن كانت limit تكفي)
      let loops = 0;

      while(!fetchedAll && loops < 10){ // حماية من الدوران الطويل
        loops++;
        const opts = { limit: Math.min(limit, 500) };
        if (before) opts.before = before; // لو احتجنا paging
        const msgs = await chat.fetchMessages(opts);
        if (!msgs || !msgs.length) break;

        // ترتيب من الأقدم إلى الأحدث
        msgs.sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));

        for(const m of msgs){
          const ts = (m.timestamp||0)*1000;
          if (ts < startTs) continue; // أقدم من المطلوب
          if (m.from !== gid) continue; // احتياط
          let content = m.body || "";
          if (settings.enableOCR && m.hasMedia){
            const text = await extractTextFromMsg(m);
            if (text) content += " " + text;
          }
          const matched = matchClient(content);
          if (matched){
            queue.push({ msg: m, emoji: matched.emoji || settings.emoji || "✅" });
            enqueued++;
          }
        }

        // لو أقدم رسالة صارت أقدم من startTs، ما في داعي نكمل
        const oldest = msgs[0];
        if (oldest && (oldest.timestamp||0)*1000 < startTs) fetchedAll = true;

        // تحضير للدفعة التالية (لو أردت paging أعمق)
        before = msgs[0]?.id?._serialized || null;
        if (!before) fetchedAll = true;
      }

    }catch(e){
      log({ event:"history_error", gid, err:String(e) });
    }
  }

  log({ event:"history_done", enqueued });
  return { enqueued };
}

// ====== REST API ======

// الصحة
app.get("/health", (req,res)=> res.json({ status:"ok", isReady, running, selectedGroupIds, settings }));

// QR
app.get("/session/qr", auth, (req,res)=>{
  if (qrDataUrl) return res.json({ qr: qrDataUrl });
  if (isReady)   return res.json({ message:"Already connected" });
  return res.status(503).json({ error:"QR not ready" });
});

// عرض المجموعات
app.get("/chats", auth, async (req,res)=>{
  try{
    if (!isReady) return res.status(503).json({ error:"WhatsApp not ready" });
    const chats = await client.getChats();
    const groups = chats.filter(c=>c.isGroup).map(c=>({
      id: c.id._serialized, name: c.name, isGroup:true, participants: Array.isArray(c.participants)?c.participants.length:0
    }));
    res.json(groups);
  }catch(e){ res.status(500).json({ error: String(e) }); }
});

// حفظ اختيار المجموعات
app.post("/groups/select", auth, (req,res)=>{
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error:"ids must be array" });
  selectedGroupIds = ids;
  log({ event:"groups_selected", idsCount: ids.length });
  res.json({ ok:true, selectedGroupIds });
});

// بدء/إيقاف
app.post("/bot/start", auth, async (req,res)=>{
  try{
    const body = req.body || {};
    const s = body.settings || {};
    const clients = body.clients || [];
    settings.emoji = s.emoji || "✅";
    settings.rateLimit = Math.max(1, +s.rateLimit || 20);
    settings.cooldown  = Math.max(0, +s.cooldown || 3);
    settings.enableOCR = !!s.enableOCR;
    settings.archive = {
      enabled: !!(s.archive?.enabled || s.historyOnStart),
      startAt: s.archive?.startAt || s.archiveStart || null,
      limit:   Math.max(10, +(s.archive?.limit || s.historyLimit || 200))
    };
    settings.clients = clients;

    running = true;
    log({ event:"bot_started", settings });

    // تشغيل فحص الأرشيف عند البدء
    if (settings.archive.enabled && settings.archive.startAt){
      scanHistory({ startAt: settings.archive.startAt, limit: settings.archive.limit })
        .catch(e=>log({ event:"history_trigger_error", err:String(e) }));
    }

    res.json({ ok:true, running, settings });
  }catch(e){ res.status(500).json({ error:String(e) }); }
});

app.post("/bot/stop", auth, (req,res)=>{
  running = false;
  res.json({ ok:true, running:false });
});

// فحص الأرشيف الآن (من الواجهة)
app.post("/history/scan", auth, async (req,res)=>{
  try{
    const { startAt, limit } = req.body || {};
    if (!startAt) return res.status(400).json({ error:"startAt is required" });
    const r = await scanHistory({ startAt, limit: Math.max(10, +limit || 200) });
    res.json(r);
  }catch(e){ res.status(500).json({ error:String(e) }) }
});

// السجل
app.get("/logs", auth, (req,res)=> res.json(logs));

app.listen(PORT, ()=> console.log(`🚀 Server running on http://localhost:${PORT}`));
