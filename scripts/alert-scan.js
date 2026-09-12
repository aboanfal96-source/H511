#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   فاحص التنبيهات على الخادم — يعمل والمتصفّح مغلق
   ──────────────────────────────────────────────────────────────────────────
   يُشغَّل من GitHub Actions بجدولة زمنية. لا خادم دائم ولا قاعدة بيانات:
   الحالة ملف JSON صغير يُحفظ في المستودع نفسه، والإرسال مباشرةً إلى واجهة
   بوت تلقرام.

   لماذا GitHub Actions لا Cloudflare Worker:
   • المستودع عام ⇒ الدقائق غير محدودة ومجانية، بينما Worker يحتاج حساباً
     جديداً وأداة نشر (wrangler) وتخزين KV للحالة.
   • حدّ التنفيذ في Actions ست ساعات، فيتّسع لجلب 259 سهماً وتشغيل المحرّك
     كاملاً. Worker مقيّد بعشرات الميلي ثانية من وقت المعالج في الطبقة
     المجانية — لا يكفي لتحليل طيفي على 259 سهماً.
   • الكود والمحرّك هنا أصلاً، فلا ازدواج مصدر.

   وحدّ يجب أن يُقال: جدولة Actions **تقريبية**. غيت هَب يؤخّر التشغيل
   المجدول دقائق (وقد تبلغ عشرين في أوقات الذروة)، وأقصر فاصل خمس دقائق.
   فهذا مناسب لـ«السعر دخل منطقة الدخول» وليس لتنفيذ لحظي. ومن يحتاج
   الدقّة إلى الثانية يحتاج خادماً دائماً — وهذا ليس مجانياً.

   التشغيل محليّاً:
     node scripts/alert-scan.js --dry            (بلا إرسال، يطبع ما كان سيُرسل)
     node scripts/alert-scan.js --limit 20 --dry (عيّنة صغيرة للتجربة)
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { createAppContext, ROOT } = require('../engine/appvm.js');

const args = process.argv.slice(2);
const flag = n => args.indexOf('--' + n) >= 0;
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DRY = flag('dry');
const LIMIT = parseInt(val('limit', '0'), 10) || 0;
const STATE_PATH = path.join(ROOT, val('state', '.alerts-state.json'));
const CONFIG_PATH = path.join(ROOT, 'alerts.config.json');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
/* يمكن توجيه الجلب إلى وسيط المنصة بدل ياهو مباشرةً — مفيد إن بدأ ياهو
   يرفض عناوين مراكز البيانات. */
const API_BASE = process.env.STOCK_API_BASE || '';
const SITE_URL = process.env.SITE_URL || 'https://h511-alpha.vercel.app';

const DEFAULT_CONFIG = {
  kinds: ['ready', 'zone'],
  radarHorizon: 10,
  approachPct: 1.5,
  cooldownHours: 20,
  maxPerBatch: 8,
  range: '5y',
  concurrency: 5,
  minBars: 120,
  symbols: null            /* null = كل الأسهم؛ أو مصفوفة رموز لمتابعة مختارة */
};

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

/* ── جلب الشموع ────────────────────────────────────────────────────────
   إعادة المحاولة بتباعد أسّي: ياهو يردّ 429 أحياناً على عناوين مراكز
   البيانات، والفشل الصامت لسهم واحد يعني تنبيهاً ضائعاً لا عطلاً ظاهراً. */
async function fetchCandles(sym, range) {
  const url = API_BASE
    ? `${API_BASE}/api/stock?symbol=${encodeURIComponent(sym)}&range=${range}&interval=1d`
    : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}.SR?range=${range}&interval=1d`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; ksa-alerts/1.0)', 'accept': 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      if (r.status === 429 || r.status >= 500) { await sleep(800 * Math.pow(2, attempt)); continue; }
      if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
      const d = await r.json();
      const res = d && d.chart && d.chart.result && d.chart.result[0];
      if (!res) return { ok: false, reason: (d && d.chart && d.chart.error && d.chart.error.description) || 'استجابة بلا نتائج' };
      return { ok: true, res };
    } catch (e) {
      if (attempt === 3) return { ok: false, reason: e.name === 'TimeoutError' ? 'مهلة' : (e.message || 'تعذّر الاتصال') };
      await sleep(800 * Math.pow(2, attempt));
    }
  }
  return { ok: false, reason: 'فشل بعد أربع محاولات' };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: text.slice(0, 3500), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000)
  });
  const b = await r.json().catch(() => null);
  if (!r.ok || !b || b.ok !== true) throw new Error((b && b.description) || `HTTP ${r.status}`);
}

(async () => {
  const cfg = Object.assign({}, DEFAULT_CONFIG, readJSON(CONFIG_PATH, {}));
  const wantRadar = cfg.kinds.indexOf('radar') >= 0;

  log(`▸ تهيئة بيئة التطبيق…`);
  const { ctx } = createAppContext();
  const G = ctx.G, E = ctx.KSAEngine, A = ctx.KSAAlerts;
  if (!A) { console.error('✗ engine/alerts.js لم يُحمّل'); process.exit(1); }

  let syms = (cfg.symbols && cfg.symbols.length) ? cfg.symbols : ctx.STKS.map(s => s.sym);
  if (LIMIT) syms = syms.slice(0, LIMIT);
  log(`▸ جلب ${syms.length} سهماً (${cfg.range})…`);

  let okCount = 0; const failed = [];
  const t0 = Date.now();
  await mapLimit(syms, cfg.concurrency, async (sym) => {
    const r = await fetchCandles(sym, cfg.range);
    if (!r.ok) { failed.push(`${sym}: ${r.reason}`); return; }
    try {
      const p = ctx.parseY(r.res, sym);
      if (!p || !p.cs || p.cs.length < cfg.minBars) { failed.push(`${sym}: شموع غير كافية`); return; }
      ctx.applyY(sym, p);
      okCount++;
    } catch (e) { failed.push(`${sym}: ${e.message}`); }
  });
  log(`  نجح ${okCount} · فشل ${failed.length} · ${((Date.now() - t0) / 1000).toFixed(1)} ثانية`);
  if (failed.length && failed.length <= 8) failed.forEach(f => log('    ⚠ ' + f));
  if (!okCount) { console.error('✗ لم يصل أي سهم — لا فحص'); process.exit(1); }

  /* خريطة المواعيد ثقيلة (تحليل طيفي على كل سهم) ولا تلزم إلا لتنبيه
     الرادار، وهو مطفأ افتراضياً. */
  if (wantRadar) {
    log('▸ بناء خريطة المواعيد الزمنية…');
    const tm = Date.now();
    for (const sym of Object.keys(G.cans)) { try { ctx._timeMap[sym] = ctx._timeEntry(sym); } catch (e) { } }
    log(`  ${((Date.now() - tm) / 1000).toFixed(1)} ثانية`);
  }

  log('▸ تقييم الشروط…');
  const items = [];
  for (const sym of Object.keys(G.cans)) {
    const cs = G.cans[sym];
    if (!cs || cs.length < 80 || G.demo.has(sym)) continue;
    let levels = null, time = null, action = null;
    try { levels = ctx.tradeLevels(sym); } catch (e) { }
    try { time = wantRadar ? (ctx._timeMap[sym] || null) : null; } catch (e) { }
    if (levels && levels.viable && levels.riskOk) {
      try { action = ctx.KSATiming.actionPlan(cs, {}); } catch (e) { }
    }
    const meta = ctx.STKS.find(x => x.sym === sym);
    items.push({ sym, name: (meta && meta.name) || sym, price: G.pr[sym], levels, time, action });
  }

  const ev = A.evaluate(items, { kinds: cfg.kinds, radarHorizon: cfg.radarHorizon, approachPct: cfg.approachPct });
  const s = ev.stats;
  log(`  فُحص ${s.scanned} · مكتملة ${s.ready} · منطقة ${s.zone} · اقتراب ${s.approach} · رادار ${s.radar}`);
  log(`  استُبعد: ${s.skippedAtrZone} نطاق ATR · ${s.skippedNoisyStop} وقف داخل الضجيج · ${s.skippedNoPlan} بلا خطة`);

  const state = readJSON(STATE_PATH, {});
  const dd = A.dedupe(ev.alerts, state.store || {}, { cooldownHours: cfg.cooldownHours, max: cfg.maxPerBatch });
  log(`▸ للإرسال ${dd.send.length} · مكتوم ${dd.suppressed.length}`);

  if (!dd.send.length) { log('لا جديد يستحق الإرسال.'); }

  let sent = 0, sendError = null;
  for (const a of dd.send) {
    const text = A.format(a, { url: SITE_URL });
    if (DRY || !TG_TOKEN || !TG_CHAT) {
      log('\n--- ' + (DRY ? 'تجربة جافّة' : 'بلا رمز بوت — لم يُرسل') + ' ---\n' + text);
      continue;
    }
    try { await sendTelegram(text); sent++; await sleep(400); }
    catch (e) { sendError = e.message; log('✗ فشل الإرسال: ' + e.message); break; }
  }

  /* الحالة تُحفظ فقط لما أُرسل فعلاً: لو سقط الإرسال في المنتصف يجب أن
     تُعاد محاولة الباقي في التشغيل التالي لا أن يُعدّ مُرسَلاً. */
  if (!DRY) {
    const confirmed = {};
    const keysSent = dd.send.slice(0, (TG_TOKEN && TG_CHAT) ? sent : 0).map(a => a.key);
    for (const k of Object.keys(dd.store)) {
      if (keysSent.indexOf(k) >= 0 || (state.store && state.store[k] != null)) confirmed[k] = dd.store[k];
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      updatedAt: new Date().toISOString(),
      lastRun: { scanned: s.scanned, candidates: ev.alerts.length, sent, suppressed: dd.suppressed.length, failedFetch: failed.length },
      store: confirmed
    }, null, 1) + '\n');
    log(`▸ حُفظت الحالة (${Object.keys(confirmed).length} مفتاحاً)`);
  }

  log(`\n✓ انتهى — أُرسل ${sent} تنبيهاً${sendError ? ` (توقّف عند: ${sendError})` : ''}`);
  if (sendError) process.exit(1);
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
