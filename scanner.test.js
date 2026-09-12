/* ══════════════════════════════════════════════════════════════════════════
   اختبارات فاحص التنبيهات على الخادم — node scanner.test.js
   ──────────────────────────────────────────────────────────────────────────
   هذا السكربت يعمل بلا رقيب كل ربع ساعة. فشله الصامت يعني أنك تظنّ السوق
   هادئاً وهو ليس كذلك، وخطؤه الصاخب يعني إغراق هاتفك. الاختبارات هنا
   تشغّله فعلاً كعملية مستقلّة على بيانات مُصطنعة ثابتة، وتفحص المخرَج.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
let passed = 0, failed = 0; const fails = [];
const test = (n, f) => { try { f(); passed++; console.log('  ✓ ' + n); } catch (e) { failed++; fails.push(n + ' — ' + e.message); console.log('  ✗ ' + n + '\n      ' + e.message); } };
const group = n => console.log('\n▸ ' + n);
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

/* ── مصدر بيانات مُصطنع ثابت: نفس الرمز ⇒ نفس السلسلة دائماً ─────────── */
function synth(sym) {
  let x = (parseInt(sym, 10) || 1) * 7919 % 2147483647;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  const ts = [], o = [], h = [], l = [], c = [], v = [];
  let p = 12 + (parseInt(sym, 10) % 40), t = Math.floor(Date.UTC(2021, 8, 1) / 1000);
  for (let i = 0; i < 1250; i++) {
    const d = new Date(t * 1000);
    if (d.getUTCDay() === 5 || d.getUTCDay() === 6) { t += 86400; i--; continue; }
    const op = p;
    p = p * (1 + (rnd() - 0.5) * 0.03 + Math.sin(2 * Math.PI * i / 34) * 0.002);
    const cl = +p.toFixed(2);
    ts.push(t); o.push(+op.toFixed(2));
    h.push(+(Math.max(op, cl) * (1 + rnd() * 0.01)).toFixed(2));
    l.push(+(Math.min(op, cl) * (1 - rnd() * 0.01)).toFixed(2));
    c.push(cl); v.push(Math.round(2e5 * (0.4 + rnd())));
    t += 86400;
  }
  return { chart: { result: [{ meta: { regularMarketPrice: c[c.length - 1], previousClose: c[c.length - 2], symbol: sym }, timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] } }], error: null } };
}

let requests = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/stock') {
    requests++;
    const sym = u.searchParams.get('symbol') || '2222';
    if (sym === '__FAIL__') { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(synth(sym)));
  }
  res.writeHead(404); res.end('nf');
});

/* ⚠️ spawnSync يُجمّد حلقة الأحداث، فالخادم المحلّي في هذه العملية نفسها
   لا يستطيع الردّ والعملية الابنة تنتظر إلى أن تُقتل بالمهلة. النسخة
   الأولى من هذا الاختبار سقطت بهذا السبب: ثمانية فحوص «فشلت» والكود
   سليم. التشغيل لا بدّ أن يكون لا تزامنياً. */
function run(extraArgs, env) {
  const state = path.join(os.tmpdir(), 'alerts-state-test-' + Math.random().toString(36).slice(2) + '.json');
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(ROOT, 'scripts/alert-scan.js'), '--limit', '25', '--state', path.relative(ROOT, state), ...extraArgs], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { STOCK_API_BASE: BASE, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' }, env || {})
    });
    let out = '';
    ch.stdout.on('data', d => out += d);
    ch.stderr.on('data', d => out += d);
    const killer = setTimeout(() => ch.kill('SIGKILL'), 180000);
    ch.on('close', code => { clearTimeout(killer); resolve({ r: { status: code }, state, out }); });
  });
}

let BASE = '';
server.listen(0, async () => {
  BASE = 'http://localhost:' + server.address().port;

  group('التشغيل الأساسي');
  const a = await run(['--dry']);

  test('ينتهي بنجاح على بيانات سليمة', () => {
    ok(a.r.status === 0, `رمز الخروج ${a.r.status}\n${a.out.slice(-500)}`);
  });

  test('يجلب البيانات ويفحصها فعلاً', () => {
    ok(requests >= 20, `عدد الطلبات ${requests}`);
    ok(/فُحص \d+/.test(a.out), 'لا سطر إحصاء');
    const m = a.out.match(/فُحص (\d+)/);
    ok(m && +m[1] >= 20, `فُحص ${m ? m[1] : 0} سهماً فقط`);
  });

  test('التجربة الجافّة لا تكتب ملف حالة ولا ترسل', () => {
    ok(!fs.existsSync(a.state), 'كُتب ملف حالة في تجربة جافّة');
    ok(/تجربة جافّة/.test(a.out), 'لا وسم للتجربة الجافّة');
  });

  test('كل رسالة تحمل منطقة الدخول والوقف وتنويه المسؤولية', () => {
    const msgs = a.out.split('--- تجربة جافّة ---').slice(1);
    ok(msgs.length > 0, 'لم تُبنَ أي رسالة — لا شيء يُفحص');
    for (const m of msgs) {
      ok(/منطقة الدخول/.test(m) || /دورة/.test(m), 'رسالة بلا منطقة دخول ولا دورة');
      ok(/ليس توصية/.test(m), 'رسالة بلا تنويه المسؤولية');
    }
  });

  test('لا نسبة عائد/مخاطرة دون الحدّ المعلن 1:1.5', () => {
    /* ظهر فعلاً: 1:1.11 لأن الوقف أُعيد اشتقاقه بعد ترشيح الأهداف. */
    const rr = [...a.out.matchAll(/1:(\d+(?:\.\d+)?)/g)].map(m => +m[1]);
    ok(rr.length > 0, 'لا نسب في المخرَج');
    const bad = rr.filter(v => v < 1.5);
    ok(bad.length === 0, `نسب دون الحدّ: ${bad.join(', ')}`);
  });

  test('لا رقم فاسد في أي رسالة', () => {
    ok(!/NaN|undefined|Infinity|\[object Object\]/.test(a.out), 'قيمة فاسدة في المخرَج');
  });

  group('الحالة ومنع التكرار');
  const b = await run([]);                 /* بلا --dry وبلا رمز بوت */

  test('يكتب ملف الحالة حين لا يكون تجربة جافّة', () => {
    ok(b.r.status === 0, `رمز الخروج ${b.r.status}\n${b.out.slice(-400)}`);
    ok(fs.existsSync(b.state), 'لم يُكتب ملف الحالة');
  });

  test('بلا رمز بوت: لا يدّعي إرسالاً ولا يسجّل مفاتيح', () => {
    const st = JSON.parse(fs.readFileSync(b.state, 'utf8'));
    ok(/بلا رمز بوت/.test(b.out), 'لم يُعلن غياب الرمز');
    ok(st.lastRun && st.lastRun.sent === 0, `سجّل إرسال ${st.lastRun && st.lastRun.sent}`);
    ok(Object.keys(st.store || {}).length === 0,
      `سجّل ${Object.keys(st.store).length} مفتاحاً رغم أنه لم يُرسل — التشغيل التالي سيكتم تنبيهات لم تصل`);
  });

  test('ملف الحالة يحمل تشخيص آخر تشغيل', () => {
    const st = JSON.parse(fs.readFileSync(b.state, 'utf8'));
    ok(st.updatedAt && st.lastRun, 'بلا طابع زمني أو تشخيص');
    ok(typeof st.lastRun.scanned === 'number' && st.lastRun.scanned > 0, 'عدد المفحوص غير مسجّل');
  });

  group('الصمود');
  const c = await run(['--dry'], { STOCK_API_BASE: 'http://localhost:1' });

  test('انقطاع مصدر البيانات يُنهي بخطأ صريح لا بصمت', () => {
    ok(c.r.status !== 0, 'انتهى بنجاح رغم فشل كل الطلبات');
    ok(/لم يصل أي سهم/.test(c.out), 'لا رسالة تشرح السبب');
  });

  try { fs.unlinkSync(b.state); } catch (e) { }
  server.close();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`نجح ${passed} · فشل ${failed}`);
  if (failed) { console.log('\nالفاشلة:'); for (const f of fails) console.log('  • ' + f); }
  console.log('═'.repeat(60));
  process.exit(failed ? 1 : 0);
});
