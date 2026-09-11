/* ══════════════════════════════════════════════════════════════════════════
   /api/notify — تسليم التنبيهات إلى تلقرام
   ──────────────────────────────────────────────────────────────────────────
   لماذا تلقرام دون واتساب: واتساب لا يسمح ببدء رسالة إلى مستخدم إلا عبر
   واجهة الأعمال (Meta Cloud API أو Twilio)، وتتطلّب حساب أعمال موثّقاً،
   ورقماً مخصّصاً، وقوالب رسائل معتمَدة مسبقاً لأي رسالة خارج نافذة 24
   ساعة من آخر ردّ منك. بوت تلقرام يُنشأ في دقيقتين بلا توثيق ولا تكلفة.
   المسار هنا مفتوح للتوسّع: أي قناة أخرى تُضاف كدالة إرسال بجانب
   sendTelegram دون تغيير ما يستدعيه المتصفّح.

   ⚠️ السرّ لا يغادر الخادم. رمز البوت في متغيّر بيئة على Vercel، ولا
   يُرسَل إلى المتصفّح ولا يظهر في أي استجابة. ولهذا وُجدت هذه الدالة
   أصلاً: نداء تلقرام مباشرةً من الصفحة يعني نشر الرمز لكل من يفتحها.

   الضبط المطلوب من المستخدم (مرّة واحدة):
     ① في تلقرام: راسل @BotFather ثم /newbot، واحفظ الرمز.
     ② راسل بوتك الجديد بأي رسالة، ثم افتح:
        https://api.telegram.org/bot<الرمز>/getUpdates
        وخذ الرقم من result[0].message.chat.id
     ③ في Vercel → Settings → Environment Variables أضف:
        TELEGRAM_BOT_TOKEN = <الرمز>
        TELEGRAM_CHAT_ID   = <الرقم>
     ثم أعد النشر.

   شكل الخطأ موحَّد مع بقية الدوال: { error: <رمز آلي>, message: <عربي> }
   ══════════════════════════════════════════════════════════════════════════ */

const MAX_MESSAGES = 10;
const MAX_CHARS = 3500;          /* حدّ تلقرام 4096؛ نترك هامشاً */
const TIMEOUT_MS = 9000;

/* حدّ بسيط للإرسال داخل نفس النسخة الحيّة من الدالة. ليس حماية أمنية —
   الدوال بلا حالة وقد تُنشأ نسخ متعددة — لكنه يمنع حلقةً في الواجهة من
   إغراق الهاتف بمئات الرسائل خلال ثوانٍ، وهو العطل الأرجح عملياً. */
const RATE = { windowMs: 60000, max: 20, hits: [] };
function rateOk() {
  const now = Date.now();
  RATE.hits = RATE.hits.filter(t => now - t < RATE.windowMs);
  if (RATE.hits.length >= RATE.max) return false;
  RATE.hits.push(now);
  return true;
}

async function sendTelegram(token, chatId, text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, MAX_CHARS),
        disable_web_page_preview: true
      }),
      signal: ctrl.signal
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.ok !== true) {
      /* وصف تلقرام للخطأ مفيد جداً للمستخدم (رمز خاطئ، لم يبدأ محادثة
         مع البوت، معرّف محادثة خاطئ) — يُمرَّر كما هو بلا الرمز السرّي. */
      return { ok: false, status: r.status, detail: (body && body.description) || `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 504, detail: e.name === 'AbortError' ? 'انتهت مهلة الاتصال بتلقرام' : (e.message || 'تعذّر الاتصال') };
  } finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'method_not_allowed', message: 'هذه الواجهة تقبل POST فقط.' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId)
    return res.status(503).json({
      error: 'not_configured',
      message: 'تنبيهات تلقرام غير مضبوطة. أضف TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID في إعدادات Vercel ثم أعد النشر. الخطوات مشروحة في لوحة التنبيهات داخل المنصة.'
    });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object')
    return res.status(400).json({ error: 'bad_request', message: 'جسم الطلب غير صالح.' });

  /* يُقبل شكلان: رسالة واحدة {text}، أو دفعة {messages:[...]} */
  let msgs = [];
  if (typeof body.text === 'string') msgs = [body.text];
  else if (Array.isArray(body.messages)) msgs = body.messages.filter(m => typeof m === 'string');
  msgs = msgs.map(m => m.trim()).filter(m => m.length > 0);

  if (!msgs.length)
    return res.status(400).json({ error: 'bad_request', message: 'لا نصّ للإرسال. مرّر text أو messages.' });
  if (msgs.length > MAX_MESSAGES)
    return res.status(400).json({ error: 'too_many', message: `الحدّ ${MAX_MESSAGES} رسائل في الطلب الواحد، ووصل ${msgs.length}.` });
  if (!rateOk())
    return res.status(429).json({ error: 'rate_limited', message: 'تجاوزت حدّ الإرسال (20 طلباً في الدقيقة). أعد المحاولة بعد قليل.' });

  const results = [];
  for (const text of msgs) {
    const r = await sendTelegram(token, chatId, text);
    results.push(r);
    if (!r.ok) break;                       /* لا نكرّر الفشل نفسه تسع مرات */
  }

  const failed = results.find(r => !r.ok);
  if (failed)
    return res.status(failed.status === 504 ? 504 : 502).json({
      error: failed.status === 504 ? 'timeout' : 'upstream_error',
      message: 'تعذّر الإرسال عبر تلقرام: ' + failed.detail,
      sent: results.filter(r => r.ok).length
    });

  return res.status(200).json({ ok: true, sent: results.length });
}
