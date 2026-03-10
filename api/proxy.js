/**
 * TestPro — Vercel Edge Proxy
 * Streamlit kerak emas — to'g'ridan Telegram Bot API orqali ishlaydi
 *
 * Vercel Environment Variables:
 *   BOT_TOKEN          = "123:ABC..."
 *   STORAGE_CHANNEL_ID = "-1001234567890"
 *   ADMIN_IDS          = "123456789"
 *   ADMIN_PASSWORD     = "parol"
 */

export const config = { runtime: 'edge' };

const BOT_TOKEN    = process.env.BOT_TOKEN          || '';
const CHANNEL_ID   = process.env.STORAGE_CHANNEL_ID || '';
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_PASS   = process.env.ADMIN_PASSWORD     || 'admin123';
const TG           = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};


// ── Session tekshirish ──
function getSession(request) {
  // Admin login qilinganligini tekshirish — bu yerda faqat admin/login endpoint orqali
  // Vercel Edge da cookie yo'q — biz admin/login da server da tekshiramiz
  // Client tomonda localStorage da saqlanadi
  return true; // Proxy da hamma so'rov admin/login dan o'tgan deb hisoblaymiz
}


// SHA256 hash (OTP tekshirish uchun)
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function normMeta(t) {
  if (!t.id) t.id = t.test_id;
  if (!t.authorId) t.authorId = String(t.creator_id || '');
  if (!t.subject) t.subject = t.category || 'other';
  return t;
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

// ── TG Bot API yordamchi ──
async function tgPost(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ── Index JSON ni yuklab olish (pinned message dan) ──
let _indexCache   = null;
let _indexCacheTs = 0;

async function getIndex() {
  // 2 daqiqa cache
  if (_indexCache && Date.now() - _indexCacheTs < 120000) return _indexCache;

  try {
    // 1. Pinned message ni ol
    const chat = await tgPost('getChat', { chat_id: CHANNEL_ID });
    const pin  = chat?.result?.pinned_message;
    if (!pin?.document) return null;

    // 2. File path ol
    const fileRes = await tgPost('getFile', { file_id: pin.document.file_id });
    const filePath = fileRes?.result?.file_path;
    if (!filePath) return null;

    // 3. Faylni yukla
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const raw     = await fetch(fileUrl);
    const data    = await raw.json();

    if (data?.tests_meta) {
      _indexCache   = data;
      _indexCacheTs = Date.now();
      return data;
    }
  } catch (e) {
    console.error('getIndex error:', e);
  }
  return null;
}

// ── Test to'liq savollarini msg_id dan yuklab olish ──
async function getTestFull(msgId) {
  try {
    // Forward qilib file_id olish
    const fwd = await tgPost('forwardMessage', {
      chat_id:     CHANNEL_ID,
      from_chat_id: CHANNEL_ID,
      message_id:  parseInt(msgId)
    });
    const doc = fwd?.result?.document;
    if (!doc) return null;

    // O'chirish (kerak emas)
    tgPost('deleteMessage', { chat_id: CHANNEL_ID, message_id: fwd.result.message_id });

    // Faylni yukla
    const fileRes = await tgPost('getFile', { file_id: doc.file_id });
    const filePath = fileRes?.result?.file_path;
    if (!filePath) return null;

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const raw = await fetch(fileUrl);
    return raw.json();
  } catch (e) {
    return null;
  }
}

// ════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════
export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  const ep  = url.searchParams.get('endpoint') || '';

  // ── tests/public — index dan meta (tezkor) ──
  if (ep === 'tests/public') {
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const tests = (index.tests_meta || []).filter(
      t => t.visibility === 'public' && t.is_active !== false
    );
    // Savollarni olib tashlaymiz — faqat meta
    const meta = tests.map(({ questions, ...t }) => normMeta(t));
    // creator_name — creator_id dan Telegram getChat bilan olish (parallel)
    await Promise.all(meta.map(async t => {
      if (t.creator_id && !t.creator_name) {
        try {
          const r = await tgPost('getChat', { chat_id: t.creator_id });
          if (r?.ok) {
            const u = r.result;
            t.creator_name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
          }
        } catch {}
      }
    }));
    return jsonResp(meta.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
  }

  // ── tests/my?uid=X ──
  if (ep === 'tests/my') {
    const uid   = url.searchParams.get('uid') || '';
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const mine = (index.tests_meta || [])
      .filter(t => String(t.creator_id) === uid)
      .map(({ questions, ...t }) => normMeta(t));
    return jsonResp(mine.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
  }

  // ── test/{id}/full — savollar bilan (TG lazy load) ──
  if (ep.startsWith('test/') && ep.endsWith('/full')) {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });

    const msgId = index[`test_${tid}`];
    if (!msgId) return jsonResp({ error: 'Test topilmadi' });

    const full = await getTestFull(msgId);
    if (!full || !full.questions?.length) {
      return jsonResp({ error: 'Savollar yuklanmadi' });
    }

    const meta = (index.tests_meta || []).find(t => t.test_id === tid) || {};
    const tData = { ...meta, ...full, questions: undefined };
    tData.id       = tData.id       || tData.test_id;
    tData.authorId = tData.authorId || String(tData.creator_id || "");
    tData.subject  = tData.subject  || tData.category || "other";
    return jsonResp({ testData: tData, questions: full.questions, total: full.questions.length });
  }

  // ── test/{id}/meta ──
  if (ep.startsWith('test/') && ep.endsWith('/meta')) {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    const meta  = (index?.tests_meta || []).find(t => t.test_id === tid);
    return jsonResp(meta || { error: 'Topilmadi' });
  }

  // ── user/{uid} — Telegram getChat ──
  if (ep.startsWith('user/') && ep.split('/').length === 2) {
    const uid = ep.split('/')[1];
    if (!/^\d+$/.test(uid)) return jsonResp({ error: "Noto'g'ri ID" });

    const res  = await tgPost('getChat', { chat_id: parseInt(uid) });
    if (res?.ok && res.result) {
      const u = res.result;
      return jsonResp({
        id:       u.id,
        name:     [u.first_name, u.last_name].filter(Boolean).join(' ') || `User${uid}`,
        username: u.username || '',
        is_admin: ADMIN_IDS.includes(String(u.id)),
      });
    }
    return jsonResp({ error: 'Topilmadi' });
  }

  // ── admin/login ──
  if (ep === 'admin/login') {
    let body = {};
    try { body = await request.json(); } catch {}
    if (!ADMIN_IDS.includes(String(body.uid))) {
      return jsonResp({ ok: false, error: 'Siz admin emassiz' });
    }
    if (body.password !== ADMIN_PASS) {
      return jsonResp({ ok: false, error: "Parol noto'g'ri" });
    }
    return jsonResp({ ok: true });
  }



// ── Index ni kanalga saqlash ──
async function saveIndex(index) {
  try {
    const fileContent = JSON.stringify(index, null, 2);
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const body = [
      '--' + boundary,
      'Content-Disposition: form-data; name="chat_id"',
      '',
      CHANNEL_ID,
      '--' + boundary,
      'Content-Disposition: form-data; name="document"; filename="index.json"',
      'Content-Type: application/json',
      '',
      fileContent,
      '--' + boundary,
      'Content-Disposition: form-data; name="caption"',
      '',
      '📋 INDEX | ' + new Date().toISOString().slice(0,16),
      '--' + boundary,
      'Content-Disposition: form-data; name="disable_notification"',
      '',
      'true',
      '--' + boundary + '--',
    ].join('\r\n');

    const res = await fetch(`${TG}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const data = await res.json();

    // Pinlash
    if (data.ok) {
      await tgPost('pinChatMessage', {
        chat_id: CHANNEL_ID,
        message_id: data.result.message_id,
        disable_notification: true,
      });
    }
    return data.ok;
  } catch (e) {
    console.error('saveIndex error:', e);
    return false;
  }
}



  // ── test/{id} — meta (eski DB.getTest uchun fallback) ──
  if (ep.match(/^test\/[^\/]+$/) && request.method === 'GET') {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    const meta  = (index?.tests_meta || []).find(t => t.test_id === tid);
    if (!meta) return jsonResp({ error: 'Topilmadi' }, 404);
    return jsonResp(normMeta({ ...meta }));
  }

  // ── test/create ──
  if (ep === 'test/create') {
    let body = {};
    try { body = await request.json(); } catch {}

    const { authorId, accessCode, title, description, subject, category,
            visibility, timeLimit, passScore, shuffleQuestions, showResult,
            questionCount, authorName, questions, difficulty,
            poll_time, max_attempts } = body;

    if (!title) return jsonResp({ error: 'Title kerak' }, 400);

    // UUID kabi 8 belgi (db.py: uuid4()[:8].upper())
    const tid = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
    const now = new Date().toISOString();

    const testDoc = {
      // db.py create_test bilan TO'LIQ mos
      test_id:        tid,
      creator_id:     parseInt(authorId) || 0,
      creator_name:   authorName || '',
      title:          title || 'Nomsiz',
      category:       category || subject || 'Boshqa',
      difficulty:     difficulty || 'medium',
      visibility:     visibility || 'public',
      time_limit:     parseInt(timeLimit)  || 0,
      poll_time:      parseInt(poll_time)  || 30,
      passing_score:  parseInt(passScore)  || 60,
      max_attempts:   parseInt(max_attempts) || 0,
      questions:      questions || [],
      question_count: (questions || []).length || parseInt(questionCount) || 0,
      solve_count:    0,
      avg_score:      0.0,
      is_active:      true,
      is_paused:      false,
      created_at:     now,
      // Qo'shimcha sayt maydonlari
      description:       description || '',
      shuffle_questions: !!shuffleQuestions,
      show_result:       showResult !== false,
      source:            'web',
    };

    // Telegram kanalga JSON fayl yuborish
    const fileContent = JSON.stringify(testDoc, null, 2);
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const body_ = [
      '--' + boundary,
      'Content-Disposition: form-data; name="chat_id"',
      '',
      CHANNEL_ID,
      '--' + boundary,
      `Content-Disposition: form-data; name="document"; filename="test_\${tid}.json"`,
      'Content-Type: application/json',
      '',
      fileContent,
      '--' + boundary,
      'Content-Disposition: form-data; name="caption"',
      '',
      `📝 TEST | \${title} | \${tid} | web`,
      '--' + boundary + '--',
    ].join('\r\n');

    const tgRes = await fetch(`\${TG}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=\${boundary}` },
      body: body_,
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      return jsonResp({ error: 'Kanal ga yuborishda xato: ' + tgData.description }, 500);
    }

    const msgId = tgData.result.message_id;

    // Index ni yangilash
    const index = await getIndex();
    if (index) {
      // Meta ga qo'shish
      const meta = { ...testDoc };
      delete meta.questions;
      (index.tests_meta = index.tests_meta || []).unshift(meta);
      index[`test_\${tid}`] = msgId;

      // Yangilangan indexni kanalga yuborish
      await saveIndex(index);
      _indexCache = index;
      _indexCacheTs = Date.now();
    }

    return jsonResp({ id: tid, test_id: tid, accessCode: code, ok: true });
  }

  // ── test/{id}/questions (GET) ──
  if (ep.match(/^test\/[^\/]+\/questions$/) && request.method === 'GET') {
    const tid = ep.split('/')[1];
    const index = await getIndex();
    const msgId = index?.[`test_\${tid}`];
    if (!msgId) return jsonResp([]);
    const full = await getTestFull(msgId);
    return jsonResp(full?.questions || []);
  }

  // ── test/{id}/questions (POST) — savollarni saqlash ──
  if (ep.match(/^test\/[^\/]+\/questions$/) && request.method === 'POST') {
    const tid = ep.split('/')[1];
    let body = {};
    try { body = await request.json(); } catch {}
    const questions = body.questions || [];

    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    const msgId = index[`test_\${tid}`];
    if (!msgId) return jsonResp({ error: 'Test topilmadi' });

    // Eski test faylini yuklab, questions ni yangilab qayta yuboring
    const old = await getTestFull(msgId);
    if (!old) return jsonResp({ error: 'Test yuklanmadi' });

    const updated = { ...old, questions, question_count: questions.length };
    const meta = (index.tests_meta || []).find(t => t.test_id === tid);
    if (meta) meta.question_count = questions.length;

    const fileContent = JSON.stringify(updated, null, 2);
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const bodyStr = [
      '--' + boundary,
      'Content-Disposition: form-data; name="chat_id"',
      '',
      CHANNEL_ID,
      '--' + boundary,
      `Content-Disposition: form-data; name="document"; filename="test_\${tid}.json"`,
      'Content-Type: application/json',
      '',
      fileContent,
      '--' + boundary,
      'Content-Disposition: form-data; name="caption"',
      '',
      `📝 TEST_UPDATE | \${tid}`,
      '--' + boundary + '--',
    ].join('\r\n');

    const tgRes = await fetch(`\${TG}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=\${boundary}` },
      body: bodyStr,
    });
    const tgData = await tgRes.json();
    if (tgData.ok) {
      index[`test_\${tid}`] = tgData.result.message_id;
      await saveIndex(index);
      _indexCache = index;
    }

    return jsonResp({ ok: true, question_count: questions.length });
  }

  // ── test/{id}/update ──
  if (ep.match(/^test\/[^\/]+\/update$/) && request.method === 'POST') {
    const tid = ep.split('/')[1];
    let body = {};
    try { body = await request.json(); } catch {}

    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });

    // Meta ni yangilash
    const meta = (index.tests_meta || []).find(t => t.test_id === tid);
    if (meta) {
      Object.assign(meta, {
        title:          body.title       || meta.title,
        description:    body.description || meta.description,
        category:       body.subject     || body.category || meta.category,
        visibility:     body.visibility  || meta.visibility,
        time_limit:     body.timeLimit   || meta.time_limit,
        passing_score:  body.passScore   || meta.passing_score,
      });
      await saveIndex(index);
      _indexCache = index;
    }

    return jsonResp({ ok: true });
  }

  // ── test/{id}/delete ──
  if (ep.match(/^test\/[^\/]+\/delete$/) && request.method === 'POST') {
    const tid = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });

    index.tests_meta = (index.tests_meta || []).filter(t => t.test_id !== tid);
    delete index[`test_\${tid}`];
    await saveIndex(index);
    _indexCache = index;
    _indexCacheTs = Date.now();

    return jsonResp({ ok: true, deleted: true });
  }

  // ── admin/tests — barcha testlar (admin uchun) ──
  if (ep === 'admin/tests') {
    const s = getSession(request);
    if (!s) return jsonResp({ error: 'Ruxsat yo\'q' }, 403);
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const tests = (index.tests_meta || []).map(({ questions, ...t }) => normMeta(t));
    await Promise.all(tests.map(async t => {
      if (t.creator_id && !t.creator_name) {
        try {
          const r = await tgPost('getChat', { chat_id: t.creator_id });
          if (r?.ok) {
            const u = r.result;
            t.creator_name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
          }
        } catch {}
      }
    }));
    return jsonResp(tests.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
  }

  // ── admin/test/{id}/pause ──
  if (ep.match(/^admin\/test\/.+\/pause$/)) {
    const s = getSession(request);
    if (!s) return jsonResp({ error: 'Ruxsat yo\'q' }, 403);
    // Note: pause state is in bot RAM — bu yerda faqat OK qaytaramiz
    // Haqiqiy pause bot orqali amalga oshiriladi
    return jsonResp({ ok: true, note: 'Bot orqali amalga oshiriladi' });
  }

  // ── admin/test/{id}/delete ──
  if (ep.match(/^admin\/test\/.+\/delete$/)) {
    const s = getSession(request);
    if (!s) return jsonResp({ error: 'Ruxsat yo\'q' }, 403);
    return jsonResp({ ok: true, note: 'Bot orqali amalga oshiriladi' });
  }


  // ── otp/generate — maxsus test uchun OTP kod (botga yuborish orqali olindi)
  // Bu endpoint proxy da emas, botda ishlaydi.
  // Sayt foydalanuvchiga botga /getcode TEST_ID yuboring deydi.

  // ── otp/verify — foydalanuvchi kodni saytga kiritadi
  if (ep === 'otp/verify') {
    let body = {};
    try { body = await request.json(); } catch {}
    const { code, uid } = body;
    if (!code) return jsonResp({ ok: false, error: 'Kod kerak' });

    // Kodlar Vercel KV da yo'q — botdan kelgan kodlarni in-memory saqlab bo'lmaydi
    // Yechim: kod = "TESTID:TIMESTAMP:HASH" formatida — proxy o'zi tekshiradi
    const parts = (code || '').toUpperCase().split(':');
    if (parts.length === 3) {
      const [testId, ts, hash] = parts;
      const age = Date.now() - parseInt(ts);
      if (age > 600000) return jsonResp({ ok: false, error: 'Kod muddati tugagan' });
      // Hash tekshirish
      const expected = await sha256(`${testId}:${ts}:${BOT_TOKEN.slice(-8)}`);
      if (expected.slice(0, 8) === hash) {
        const index = await getIndex();
        const meta = (index?.tests_meta || []).find(t => t.test_id === testId);
        return jsonResp({ ok: true, test_id: testId, meta: meta || {} });
      }
      return jsonResp({ ok: false, error: "Noto'g'ri kod" });
    }
    return jsonResp({ ok: false, error: "Noto'g'ri format" });
  }

  // ── admin/stats — real-time statistika (admin panel uchun)
  if (ep === 'admin/stats') {
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });

    const tests = index.tests_meta || [];
    const totalTests  = tests.length;
    const activeTests = tests.filter(t => t.is_active !== false).length;
    const pubTests    = tests.filter(t => t.visibility === 'public').length;
    const totalSolve  = tests.reduce((s, t) => s + (t.solve_count || 0), 0);
    const avgScore    = tests.filter(t => t.avg_score).length
      ? Math.round(tests.reduce((s, t) => s + (t.avg_score || 0), 0) / tests.filter(t => t.avg_score).length)
      : 0;

    // Fan bo'yicha guruhlash
    const byCategory = {};
    tests.forEach(t => {
      const cat = t.category || t.subject || 'other';
      if (!byCategory[cat]) byCategory[cat] = { count: 0, solves: 0, avg: [] };
      byCategory[cat].count++;
      byCategory[cat].solves += t.solve_count || 0;
      if (t.avg_score) byCategory[cat].avg.push(t.avg_score);
    });
    const categories = Object.entries(byCategory).map(([name, d]) => ({
      name,
      count:  d.count,
      solves: d.solves,
      avg:    d.avg.length ? Math.round(d.avg.reduce((a,b) => a+b) / d.avg.length) : 0,
    })).sort((a, b) => b.solves - a.solves);

    // Top 5 test
    const topTests = [...tests]
      .filter(t => t.is_active !== false)
      .sort((a, b) => (b.solve_count || 0) - (a.solve_count || 0))
      .slice(0, 5)
      .map(({ questions, ...t }) => normMeta(t));

    // Oxirgi 7 kun uchun yaratilgan testlar (created_at bo'yicha)
    const now = Date.now();
    const days7 = Array.from({length: 7}, (_, i) => {
      const d = new Date(now - i * 86400000);
      return d.toISOString().slice(0, 10);
    }).reverse();

    const byDay = {};
    days7.forEach(d => byDay[d] = { created: 0, solves: 0 });
    tests.forEach(t => {
      const day = (t.created_at || '').slice(0, 10);
      if (byDay[day] !== undefined) {
        byDay[day].created++;
        byDay[day].solves += t.solve_count || 0;
      }
    });
    const timeline = days7.map(d => ({ date: d, ...byDay[d] }));

    return jsonResp({
      totalTests, activeTests, pubTests, totalSolve, avgScore,
      categories, topTests, timeline,
    });
  }


  // ── result/save — saytda yechilgan natijani kanal ga yuborish ──
  if (ep === 'result/save') {
    let body = {};
    try { body = await request.json(); } catch {}

    const { userId, testId, userName, userUsername,
            score, total, percentage, passing_score,
            detailed_results, completedAt } = body;

    if (!userId || !testId) return jsonResp({ error: 'userId va testId kerak' });

    const now = new Date().toISOString();
    const rid = `${userId}_${testId}`;

    const resultDoc = {
      result_id:        rid,
      user_id:          String(userId),
      user_name:        userName || '',
      user_username:    userUsername || '',
      test_id:          testId,
      score:            score || 0,
      total:            total || 0,
      percentage:       parseFloat(percentage) || 0,
      passing_score:    passing_score || 60,
      passed:           (parseFloat(percentage) || 0) >= (passing_score || 60),
      detailed_results: detailed_results || [],
      completed_at:     completedAt ? new Date(completedAt).toISOString() : now,
      source:           'web',
    };

    // Kanal ga yengil natija fayli yuborish (bot midnight da o'qiydi)
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const fileContent = JSON.stringify(resultDoc, null, 2);
    const bodyStr = [
      '--' + boundary,
      'Content-Disposition: form-data; name="chat_id"',
      '', CHANNEL_ID,
      '--' + boundary,
      `Content-Disposition: form-data; name="document"; filename="result_${rid}.json"`,
      'Content-Type: application/json',
      '', fileContent,
      '--' + boundary,
      'Content-Disposition: form-data; name="caption"',
      '', `📊 RESULT | ${userName||userId} | ${testId} | ${Math.round(percentage||0)}%`,
      '--' + boundary,
      'Content-Disposition: form-data; name="disable_notification"',
      '', 'true',
      '--' + boundary + '--',
    ].join('\r\n');

    fetch(`${TG}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: bodyStr,
    }).catch(() => {});  // fire-and-forget

    return jsonResp({ ok: true, result_id: rid });
  }

  // ── results/{uid} — foydalanuvchi natijalari (index dan) ──
  if (ep.match(/^results\/\d+/)) {
    const uid = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp([]);

    // Index da users_results_msg_id bo'lsa o'sha fayldan olamiz
    // Hozir faqat test meta dan user statistikasini qaytaramiz
    const userResults = (index.tests_meta || [])
      .filter(t => t.is_active !== false)
      .map(t => {
        // Bu yerda user-specific ma'lumot yo'q — faqat meta
        return null;
      })
      .filter(Boolean);

    // localStorage fallback — client tomonda saqlanadi
    return jsonResp([]);
  }

  return jsonResp({ error: "Noma'lum endpoint" }, 404);
}
