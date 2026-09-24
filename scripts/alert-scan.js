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
const FROM = val('from', '');          /* تشغيل على لقطة محفوظة بلا شبكة */
const SNAPSHOT = val('snapshot', '');  /* حفظ الاستجابات الخام في لقطة */
const STATE_PATH = path.join(ROOT, val('state', '.alerts-state.json'));
const CONFIG_PATH = path.join(ROOT, 'alerts.config.json');
const FEED_PATH = path.join(ROOT, val('feed', 'alerts-feed.json'));
const FEED_MAX = 150;
/* مفتاح GitHub المدمج — يمنحه Actions تلقائياً لكل تشغيل، لا يضبطه المستخدم */
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPOSITORY || '';
const ISSUE_TITLE = '🔔 تنبيهات السوق — المنصة';

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
  symbols: null,           /* null = كل الأسهم؛ أو مصفوفة رموز لمتابعة مختارة */
  githubIssue: true        /* نشر التنبيهات تعليقاتٍ في مسألة بالمستودع ⇒ إشعار GitHub */
};

const log = (...a) => console.log(...a);

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

const { loadInto, writeSnapshot, sleep } = require('./fetch.js');

/** ينشر تعليقاً على مسألة التنبيهات، وينشئها إن لم توجد. يعيد رقمها. */
async function postIssueComment(body) {
  /* GITHUB_API_URL يضبطه Actions تلقائياً؛ وتغييره يتيح اختبار هذه القناة على خادم محلّي */
  const api = `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${GH_REPO}`;
  const h = { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'ksa-alerts' };
  const j = async (r) => { const b = await r.json().catch(() => null); if (!r.ok) throw new Error((b && b.message) || `HTTP ${r.status}`); return b; };
  const list = await j(await fetch(`${api}/issues?state=open&per_page=100`, { headers: h, signal: AbortSignal.timeout(15000) }));
  let issue = (list || []).find(i => i.title === ISSUE_TITLE && !i.pull_request);
  if (!issue) {
    issue = await j(await fetch(`${api}/issues`, { method: 'POST', headers: h, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ title: ISSUE_TITLE, body: 'تنبيهات فاحص الخادم تُنشر هنا تعليقاتٍ. GitHub يُشعرك بكل تعليق بالبريد وفي تطبيق GitHub على الجوال — بلا أي مفتاح.\n\nلإيقاف الإشعارات: زر Unsubscribe في هذه الصفحة. لإيقاف النشر هنا: "githubIssue": false في alerts.config.json.' }) }));
  }
  await j(await fetch(`${api}/issues/${issue.number}/comments`, { method: 'POST', headers: h, signal: AbortSignal.timeout(15000), body: JSON.stringify({ body }) }));
  return issue.number;
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

  const t0 = Date.now();
  const loaded = await loadInto(ctx, syms, { range: cfg.range, minBars: cfg.minBars, concurrency: cfg.concurrency, apiBase: API_BASE, from: FROM });
  const okCount = loaded.ok, failed = loaded.failed;
  log(`  نجح ${okCount} · فشل ${failed.length} · ${((Date.now() - t0) / 1000).toFixed(1)} ثانية${loaded.takenAt ? ` · من لقطة ${loaded.takenAt}` : ''}`);
  if (failed.length && failed.length <= 8) failed.forEach(f => log('    ⚠ ' + f));
  if (SNAPSHOT) { writeSnapshot(SNAPSHOT, loaded.raw, { range: cfg.range }); log(`  حُفظت لقطة البيانات الخام: ${SNAPSHOT}`); }
  if (!okCount) { console.error('✗ لم يصل أي سهم — لا فحص'); process.exit(1); }

  /* خريطة المواعيد ثقيلة (تحليل طيفي على كل سهم) ولا تلزم إلا لتنبيه
     الرادار، وهو مطفأ افتراضياً. */
  /* 🛠️ كانت الخريطة تُكتب في ctx._timeMap — لكن _timeMap معرّفة بـ let في
     سكربت الصفحة، فلا تصير خاصية على الكائن العام، والكتابة ترمي خطأً
     يبتلعه try لكل سهم. أي أن تنبيه الرادار على الخادم لم يعمل قط، بصمت.
     الآن خريطة محلية، ويُطبَّق عليها تصحيح الاختبارات المتعددة نفسه الذي
     تطبّقه الصفحة. */
  const timeMap = {};
  if (wantRadar) {
    log('▸ بناء خريطة المواعيد الزمنية…');
    const tm = Date.now();
    let errs = 0;
    for (const sym of Object.keys(G.cans)) { try { timeMap[sym] = ctx._timeEntry(sym); } catch (e) { errs++; } }
    const fdr = ctx.applyTimeMapFDR(timeMap);
    log(`  ${((Date.now() - tm) / 1000).toFixed(1)} ثانية${errs ? ` · ${errs} خطأ` : ''}`
      + (fdr.applied ? ` · تصحيح BH على ${fdr.tested}: بقيت ${fdr.kept} دورة وأُسقطت ${fdr.demoted}` : ''));
  }

  log('▸ تقييم الشروط…');
  const items = [];
  for (const sym of Object.keys(G.cans)) {
    const cs = G.cans[sym];
    if (!cs || cs.length < 80 || G.demo.has(sym)) continue;
    let levels = null, time = null, action = null;
    try { levels = ctx.tradeLevels(sym); } catch (e) { }
    time = wantRadar ? (timeMap[sym] || null) : null;
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

  /* ══ القنوات ══════════════════════════════════════════════════════════
     بلا أي مفتاح يضبطه المستخدم: كل شيء داخل المستودع نفسه.
     ① ملف alerts-feed.json في المستودع — تقرؤه المنصة عند فتحها فترى ما
        صدر وأنت غائب، ويُطلق إشعار المتصفّح لما هو جديد منذ آخر زيارة.
     ② تعليق على مسألة (issue) واحدة في المستودع بمفتاح GitHub المدمج
        (GITHUB_TOKEN — يمنحه Actions تلقائياً، لا يُضبط). GitHub يُشعر مالك
        المستودع بالبريد وفي تطبيق GitHub على الجوال.
     ③ تلقرام — اختياري، إن وُجد مفتاحاه فقط. */
  const now = new Date().toISOString();
  const texts = dd.send.map(a => ({ a, text: A.format(a, { url: SITE_URL, sessionClosed: !ctx.marketOpen() }) }));
  const delivered = { feed: 0, issue: 0, telegram: 0 };
  let sendError = null;

  if (DRY) {
    texts.forEach(x => log('\n--- تجربة جافّة ---\n' + x.text));
  } else if (texts.length) {
    /* ① الملف */
    try {
      const feed = readJSON(FEED_PATH, { items: [] });
      const fresh = texts.map(x => ({ at: now, key: x.a.key, sym: x.a.sym, name: x.a.name, kind: x.a.kind, price: x.a.price, text: x.text }));
      feed.items = fresh.concat(feed.items || []).slice(0, FEED_MAX);
      feed.updatedAt = now;
      fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 1) + '\n');
      delivered.feed = fresh.length;
      log(`▸ سُجّل ${fresh.length} تنبيهاً في ${path.basename(FEED_PATH)}`);
    } catch (e) { log('✗ تعذّرت كتابة ملف التنبيهات: ' + e.message); }

    /* ② المسألة */
    if (GH_TOKEN && GH_REPO && cfg.githubIssue !== false) {
      try {
        /* الإشارة (@) تُشعر المالك حتى لو لم يكن «يراقب» المستودع */
        const owner = process.env.GITHUB_REPOSITORY_OWNER ? `@${process.env.GITHUB_REPOSITORY_OWNER} ` : '';
        const body = owner + `**${texts.length} تنبيهاً — ${ctx.marketOpen() ? 'السوق مفتوح' : 'السوق مغلق'}** · ${now.slice(0, 16).replace('T', ' ')} UTC\n\n`
          + texts.map(x => '```\n' + x.text + '\n```').join('\n');
        const n = await postIssueComment(body.slice(0, 60000));
        delivered.issue = texts.length;
        log(`▸ نُشر في المسألة #${n} — يصلك إشعار GitHub`);
      } catch (e) { log('✗ تعذّر النشر في مسألة GitHub: ' + e.message); }
    }

    /* ③ تلقرام — اختياري */
    if (TG_TOKEN && TG_CHAT) {
      for (const x of texts) {
        try { await sendTelegram(x.text); delivered.telegram++; await sleep(400); }
        catch (e) { sendError = e.message; log('✗ فشل إرسال تلقرام: ' + e.message); break; }
      }
    }
    texts.forEach(x => log('\n---\n' + x.text));
  }

  /* الحالة: المفتاح يُسجَّل حين وصل التنبيه إلى قناة واحدة على الأقل —
     وإلا يُعاد في التشغيل التالي لا أن يُعدّ مُرسَلاً. */
  const reached = Math.max(delivered.feed, delivered.issue, delivered.telegram);
  if (!DRY) {
    const confirmed = {};
    const keysSent = dd.send.slice(0, reached).map(a => a.key);
    for (const k of Object.keys(dd.store)) {
      if (keysSent.indexOf(k) >= 0 || (state.store && state.store[k] != null)) confirmed[k] = dd.store[k];
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      updatedAt: now,
      lastRun: { scanned: s.scanned, candidates: ev.alerts.length, sent: reached, delivered, suppressed: dd.suppressed.length, failedFetch: failed.length },
      store: confirmed
    }, null, 1) + '\n');
    log(`▸ حُفظت الحالة (${Object.keys(confirmed).length} مفتاحاً)`);
  }

  log(`\n✓ انتهى — ملف ${delivered.feed} · مسألة ${delivered.issue} · تلقرام ${delivered.telegram}${sendError ? ` (توقّف تلقرام عند: ${sendError})` : ''}`);
  const summary = [
    `### تنبيهات السوق — ${now.slice(0, 16).replace('T', ' ')} UTC`,
    `- السوق: ${ctx.marketOpen() ? 'مفتوح' : 'مغلق'}`,
    `- فُحص ${s.scanned} · مرشّح ${ev.alerts.length} · للإرسال ${dd.send.length} · مكتوم ${dd.suppressed.length}`,
    `- وصل: ملف المنصة ${delivered.feed} · مسألة GitHub ${delivered.issue} · تلقرام ${TG_TOKEN && TG_CHAT ? delivered.telegram : '— (غير مستعمل)'}`,
    sendError ? `- ✗ فشل تلقرام: ${sendError}` : ''
  ].filter(Boolean).join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n'); } catch (e) { } }

  /* الفشل الظاهر فقط حين لم يصل تنبيهٌ جاهز إلى أي قناة */
  if (!DRY && texts.length && !reached) {
    console.log(`::error title=التنبيهات لم تصل::${texts.length} تنبيهاً جاهزاً ولم يصل أيّ منها إلى أي قناة`);
    process.exit(2);
  }
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
