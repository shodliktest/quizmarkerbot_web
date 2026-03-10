/**
 * TestPro — Vercel Edge Proxy
 * Telegram Bot API orqali to'g'ridan ishlaydi
 *
 * Vercel Environment Variables:
 *   BOT_TOKEN          = "123:ABC..."
 *   STORAGE_CHANNEL_ID = "-1001234567890"
 *   ADMIN_IDS          = "123456789"
 *   ADMIN_PASSWORD     = "parol"
 */

export const config = { runtime: 'edge' };

const BOT_TOKEN  = process.env.BOT_TOKEN          || '';
const CHANNEL_ID = process.env.STORAGE_CHANNEL_ID || '';
const ADMIN_IDS  = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_PASS = process.env.ADMIN_PASSWORD     || 'admin123';
const TG         = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TG-ID',
};

// ── Yordamchi funksiyalar ──────────────────────────────────────

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function tgPost(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.json();
}

function normMeta(t) {
  if (!t.id)       t.id       = t.test_id;
  if (!t.authorId) t.authorId = String(t.creator_id || '');
  if (!t.subject)  t.subject  = t.category || 'other';
  return t;
}

async function sha256(message) {
  const buf  = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Multipart form-data body yasash ──────────────────────────

function makeMultipart(boundary, fields) {
  const parts = [];
  for (const [name, value, filename, ct] of fields) {
    parts.push('--' + boundary);
    if (filename) {
      parts.push(`Content-Disposition: form-data; name="${name}"; filename="${filename}"`);
      parts.push(`Content-Type: ${ct || 'application/octet-stream'}`);
    } else {
      parts.push(`Content-Disposition: form-data; name="${name}"`);
    }
    parts.push('');
    parts.push(value);
  }
  parts.push('--' + boundary + '--');
  return parts.join('\r\n');
}

async function sendDoc(filename, jsonData, caption) {
  const boundary = '----FB' + Math.random().toString(36).slice(2);
  const content  = JSON.stringify(jsonData, null, 2);
  const body = makeMultipart(boundary, [
    ['chat_id',              CHANNEL_ID],
    ['document',             content,   filename, 'application/json'],
    ['caption',              caption || filename],
    ['disable_notification', 'true'],
  ]);
  const res  = await fetch(`${TG}/sendDocument`, {
    method:  'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return res.json();
}

// ── Index cache ───────────────────────────────────────────────

let _indexCache   = null;
let _indexCacheTs = 0;

async function getIndex() {
  if (_indexCache && Date.now() - _indexCacheTs < 300_000) return _indexCache;
  try {
    const chat = await tgPost('getChat', { chat_id: CHANNEL_ID });
    const pin  = chat?.result?.pinned_message;
    if (!pin?.document) return null;

    const fileRes  = await tgPost('getFile', { file_id: pin.document.file_id });
    const filePath = fileRes?.result?.file_path;
    if (!filePath) return null;

    const raw  = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    const data = await raw.json();
    if (data?.tests_meta) {
      _indexCache   = data;
      _indexCacheTs = Date.now();
      return data;
    }
  } catch (e) {
    console.error('getIndex:', e);
  }
  return null;
}

async function saveIndex(index) {
  const data = await sendDoc('index.json', index, '📋 INDEX | ' + new Date().toISOString().slice(0, 16));
  if (data?.ok) {
    await tgPost('pinChatMessage', {
      chat_id:              CHANNEL_ID,
      message_id:           data.result.message_id,
      disable_notification: true,
    });
    _indexCache   = index;
    _indexCacheTs = Date.now();
  }
  return data?.ok || false;
}

// ── Test to'liq yuklab olish ──────────────────────────────────

async function getTestFull(msgId) {
  try {
    // Faylni to'g'ridan forward qilib file_id olamiz
    const fwd = await tgPost('forwardMessage', {
      chat_id:      CHANNEL_ID,
      from_chat_id: CHANNEL_ID,
      message_id:   parseInt(msgId),
    });
    const doc = fwd?.result?.document;
    if (!doc) return null;

    // Asinxron o'chirish (kutmaymiz)
    tgPost('deleteMessage', { chat_id: CHANNEL_ID, message_id: fwd.result.message_id });

    // file_id va getFile parallel
    const fileRes  = await tgPost('getFile', { file_id: doc.file_id });
    const filePath = fileRes?.result?.file_path;
    if (!filePath) return null;

    const raw = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    return raw.json();
  } catch (e) {
    console.error('getTestFull:', e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  const ep  = url.searchParams.get('endpoint') || '';

  // ── tests/public ─────────────────────────────────────────────
  if (ep === 'tests/public') {
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const meta = (index.tests_meta || [])
      .filter(t => t.visibility === 'public' && t.is_active !== false)
      .map(({ questions, ...t }) => normMeta(t));
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
    return jsonResp(meta.sort((a, b) => (b.created_at || '') > (a.created_at || '') ? 1 : -1).reverse());
  }

  // ── tests/my?uid=X ───────────────────────────────────────────
  if (ep === 'tests/my') {
    const uid   = url.searchParams.get('uid') || '';
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const mine = (index.tests_meta || [])
      .filter(t => String(t.creator_id) === uid)
      .map(({ questions, ...t }) => normMeta(t));
    return jsonResp(mine);
  }

  // ── test/{id}/full ───────────────────────────────────────────
  if (ep.startsWith('test/') && ep.endsWith('/full')) {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });

    const msgId = index[`test_${tid}`];
    if (!msgId) return jsonResp({ error: 'Test topilmadi' });

    const full = await getTestFull(msgId);
    if (!full?.questions?.length) return jsonResp({ error: 'Savollar yuklanmadi' });

    const meta  = (index.tests_meta || []).find(t => t.test_id === tid) || {};
    const tData = { ...meta, ...full, questions: undefined };
    tData.id       = tData.id       || tData.test_id;
    tData.authorId = tData.authorId || String(tData.creator_id || '');
    tData.subject  = tData.subject  || tData.category || 'other';
    return jsonResp({ testData: tData, questions: full.questions, total: full.questions.length });
  }

  // ── test/{id}/meta ───────────────────────────────────────────
  if (ep.startsWith('test/') && ep.endsWith('/meta')) {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    const meta  = (index?.tests_meta || []).find(t => t.test_id === tid);
    if (!meta) return jsonResp({ error: 'Topilmadi' }, 404);
    return jsonResp(normMeta({ ...meta }));
  }

  // ── test/{id} — bare meta (fallback) ─────────────────────────
  if (ep.match(/^test\/[^/]+$/) && request.method === 'GET') {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    const meta  = (index?.tests_meta || []).find(t => t.test_id === tid);
    if (!meta) return jsonResp({ error: 'Topilmadi' }, 404);
    return jsonResp(normMeta({ ...meta }));
  }

  // ── test/{id}/questions GET ───────────────────────────────────
  if (ep.match(/^test\/[^/]+\/questions$/) && request.method === 'GET') {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    const msgId = index?.[`test_${tid}`];
    if (!msgId) return jsonResp([]);
    const full = await getTestFull(msgId);
    return jsonResp(full?.questions || []);
  }

  // ── test/{id}/questions POST ──────────────────────────────────
  if (ep.match(/^test\/[^/]+\/questions$/) && request.method === 'POST') {
    const tid = ep.split('/')[1];
    let body = {};
    try { body = await request.json(); } catch {}
    const questions = body.questions || [];

    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    const msgId = index[`test_${tid}`];
    if (!msgId) return jsonResp({ error: 'Test topilmadi' });

    const old = await getTestFull(msgId);
    if (!old) return jsonResp({ error: 'Test yuklanmadi' });

    const updated = { ...old, questions, question_count: questions.length };
    const meta = (index.tests_meta || []).find(t => t.test_id === tid);
    if (meta) meta.question_count = questions.length;

    const tgData = await sendDoc(`test_${tid}.json`, updated, `📝 TEST_UPDATE | ${tid}`);
    if (tgData?.ok) {
      index[`test_${tid}`] = tgData.result.message_id;
      await saveIndex(index);
    }
    return jsonResp({ ok: true, question_count: questions.length });
  }

  // ── test/create ───────────────────────────────────────────────
  if (ep === 'test/create') {
    let body = {};
    try { body = await request.json(); } catch {}

    const {
      authorId, title, description, subject, category,
      visibility, timeLimit, passScore, shuffleQuestions, showResult,
      questionCount, authorName, questions, difficulty, poll_time, max_attempts,
    } = body;

    if (!title) return jsonResp({ error: 'Title kerak' }, 400);

    const tid = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const now = new Date().toISOString();

    const testDoc = {
      test_id:           tid,
      creator_id:        parseInt(authorId) || 0,
      creator_name:      authorName || '',
      title:             title || 'Nomsiz',
      category:          category || subject || 'Boshqa',
      difficulty:        difficulty || 'medium',
      visibility:        visibility || 'public',
      time_limit:        parseInt(timeLimit)    || 0,
      poll_time:         parseInt(poll_time)    || 30,
      passing_score:     parseInt(passScore)    || 60,
      max_attempts:      parseInt(max_attempts) || 0,
      questions:         questions || [],
      question_count:    (questions || []).length || parseInt(questionCount) || 0,
      solve_count:       0,
      avg_score:         0.0,
      is_active:         true,
      is_paused:         false,
      created_at:        now,
      description:       description || '',
      shuffle_questions: !!shuffleQuestions,
      show_result:       showResult !== false,
      source:            'web',
    };

    const tgData = await sendDoc(`test_${tid}.json`, testDoc, `📝 TEST | ${title} | ${tid} | web`);
    if (!tgData?.ok) {
      return jsonResp({ error: 'Kanalga yuborishda xato: ' + (tgData?.description || '?') }, 500);
    }

    const msgId = tgData.result.message_id;
    const index = await getIndex();
    if (index) {
      const meta = { ...testDoc };
      delete meta.questions;
      (index.tests_meta = index.tests_meta || []).unshift(meta);
      index[`test_${tid}`] = msgId;
      await saveIndex(index);
    }

    return jsonResp({ ok: true, id: tid, test_id: tid });
  }

  // ── test/{id}/update ─────────────────────────────────────────
  if (ep.match(/^test\/[^/]+\/update$/) && request.method === 'POST') {
    const tid = ep.split('/')[1];
    let body = {};
    try { body = await request.json(); } catch {}

    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    const meta = (index.tests_meta || []).find(t => t.test_id === tid);
    if (meta) {
      Object.assign(meta, {
        title:         body.title        || meta.title,
        description:   body.description  ?? meta.description,
        category:      body.category     || body.subject || meta.category,
        visibility:    body.visibility   || meta.visibility,
        time_limit:    body.timeLimit    ?? meta.time_limit,
        passing_score: body.passScore    ?? meta.passing_score,
        is_paused:     body.is_paused    ?? meta.is_paused,
      });
      await saveIndex(index);
    }
    return jsonResp({ ok: true });
  }

  // ── test/{id}/delete ─────────────────────────────────────────
  if (ep.match(/^test\/[^/]+\/delete$/) && request.method === 'POST') {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    index.tests_meta = (index.tests_meta || []).filter(t => t.test_id !== tid);
    delete index[`test_${tid}`];
    await saveIndex(index);
    return jsonResp({ ok: true, deleted: true });
  }

  // ── user/{uid} ───────────────────────────────────────────────
  if (ep.startsWith('user/') && ep.split('/').length === 2) {
    const uid = ep.split('/')[1];
    if (!/^\d+$/.test(uid)) return jsonResp({ error: "Noto'g'ri ID" });
    const res = await tgPost('getChat', { chat_id: parseInt(uid) });
    if (res?.ok && res.result) {
      const u = res.result;
      return jsonResp({
        id:       u.id,
        uid:      String(u.id),
        name:     [u.first_name, u.last_name].filter(Boolean).join(' ') || `User${uid}`,
        username: u.username || '',
        is_admin: ADMIN_IDS.includes(String(u.id)),
        role:     ADMIN_IDS.includes(String(u.id)) ? 'admin' : 'user',
      });
    }
    return jsonResp({ error: 'Topilmadi' }, 404);
  }

  // ── admin/login ───────────────────────────────────────────────
  if (ep === 'admin/login') {
    let body = {};
    try { body = await request.json(); } catch {}
    if (!ADMIN_IDS.includes(String(body.uid)))   return jsonResp({ ok: false, error: 'Siz admin emassiz' });
    if (body.password !== ADMIN_PASS)             return jsonResp({ ok: false, error: "Parol noto'g'ri" });
    return jsonResp({ ok: true });
  }

  // ── admin/tests ───────────────────────────────────────────────
  if (ep === 'admin/tests') {
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
    return jsonResp(tests);
  }

  // ── admin/stats ───────────────────────────────────────────────
  if (ep === 'admin/stats') {
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    const tests       = index.tests_meta || [];
    const totalTests  = tests.length;
    const activeTests = tests.filter(t => t.is_active !== false).length;
    const pubTests    = tests.filter(t => t.visibility === 'public').length;
    const totalSolve  = tests.reduce((s, t) => s + (t.solve_count || 0), 0);
    const scored      = tests.filter(t => t.avg_score);
    const avgScore    = scored.length
      ? Math.round(scored.reduce((s, t) => s + t.avg_score, 0) / scored.length) : 0;

    const byCategory = {};
    tests.forEach(t => {
      const cat = t.category || t.subject || 'other';
      if (!byCategory[cat]) byCategory[cat] = { count: 0, solves: 0, avg: [] };
      byCategory[cat].count++;
      byCategory[cat].solves += t.solve_count || 0;
      if (t.avg_score) byCategory[cat].avg.push(t.avg_score);
    });
    const categories = Object.entries(byCategory).map(([name, d]) => ({
      name, count: d.count, solves: d.solves,
      avg: d.avg.length ? Math.round(d.avg.reduce((a, b) => a + b) / d.avg.length) : 0,
    })).sort((a, b) => b.solves - a.solves);

    const topTests = [...tests]
      .filter(t => t.is_active !== false)
      .sort((a, b) => (b.solve_count || 0) - (a.solve_count || 0))
      .slice(0, 5)
      .map(({ questions, ...t }) => normMeta(t));

    const now   = Date.now();
    const days7 = Array.from({ length: 7 }, (_, i) => {
      return new Date(now - i * 86400000).toISOString().slice(0, 10);
    }).reverse();
    const byDay = {};
    days7.forEach(d => { byDay[d] = { created: 0, solves: 0 }; });
    tests.forEach(t => {
      const day = (t.created_at || '').slice(0, 10);
      if (byDay[day]) { byDay[day].created++; byDay[day].solves += t.solve_count || 0; }
    });
    const timeline = days7.map(d => ({ date: d, ...byDay[d] }));

    return jsonResp({ totalTests, activeTests, pubTests, totalSolve, avgScore, categories, topTests, timeline });
  }

  // ── admin/test/{id}/pause ─────────────────────────────────────
  if (ep.match(/^admin\/test\/.+\/pause$/)) {
    const tid = ep.split('/')[2];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    const meta = (index.tests_meta || []).find(t => t.test_id === tid);
    if (meta) { meta.is_paused = !meta.is_paused; await saveIndex(index); }
    return jsonResp({ ok: true, is_paused: meta?.is_paused ?? false });
  }

  // ── admin/test/{id}/delete ────────────────────────────────────
  if (ep.match(/^admin\/test\/.+\/delete$/)) {
    const tid = ep.split('/')[2];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    index.tests_meta = (index.tests_meta || []).filter(t => t.test_id !== tid);
    delete index[`test_${tid}`];
    await saveIndex(index);
    return jsonResp({ ok: true });
  }

  // ── otp/verify ────────────────────────────────────────────────
  if (ep === 'otp/verify') {
    let body = {};
    try { body = await request.json(); } catch {}
    const code = (body.code || '').toUpperCase().trim();
    if (!code) return jsonResp({ ok: false, error: 'Kod kerak' });

    const parts = code.split(':');
    if (parts.length !== 3) return jsonResp({ ok: false, error: "Noto'g'ri format" });

    const [testId, ts, hash] = parts;
    if (Date.now() - parseInt(ts) > 600_000) return jsonResp({ ok: false, error: 'Kod muddati tugagan' });

    const expected = await sha256(`${testId}:${ts}:${BOT_TOKEN.slice(-8)}`);
    if (expected.slice(0, 8).toUpperCase() !== hash) return jsonResp({ ok: false, error: "Noto'g'ri kod" });

    const index = await getIndex();
    const meta  = (index?.tests_meta || []).find(t => t.test_id === testId);
    return jsonResp({ ok: true, test_id: testId, meta: meta || {} });
  }

  // ── result/save ───────────────────────────────────────────────
  if (ep === 'result/save') {
    let body = {};
    try { body = await request.json(); } catch {}
    const { userId, testId, userName, userUsername,
            score, total, percentage, passing_score, detailed_results, completedAt } = body;

    if (!userId || !testId) return jsonResp({ error: 'userId va testId kerak' });

    const now = new Date().toISOString();
    const rid = `${userId}_${testId}_${Date.now()}`;
    const resultDoc = {
      result_id: rid, user_id: String(userId),
      user_name: userName || '', user_username: userUsername || '',
      test_id: testId, score: score || 0, total: total || 0,
      percentage: parseFloat(percentage) || 0,
      passing_score: passing_score || 60,
      passed: (parseFloat(percentage) || 0) >= (passing_score || 60),
      detailed_results: detailed_results || [],
      completed_at: completedAt ? new Date(completedAt).toISOString() : now,
      source: 'web',
    };

    // fire-and-forget
    sendDoc(`result_${rid}.json`, resultDoc,
      `📊 RESULT | ${userName || userId} | ${testId} | ${Math.round(percentage || 0)}%`
    ).catch(() => {});

    // Test statistikasini yangilash
    const index = await getIndex();
    if (index) {
      const meta = (index.tests_meta || []).find(t => t.test_id === testId);
      if (meta) {
        const sc  = (meta.solve_count || 0) + 1;
        const avg = ((meta.avg_score || 0) * (sc - 1) + (parseFloat(percentage) || 0)) / sc;
        meta.solve_count = sc;
        meta.avg_score   = Math.round(avg * 10) / 10;
        saveIndex(index).catch(() => {});
      }
    }

    return jsonResp({ ok: true, result_id: rid });
  }

  // ── results/{uid} ─────────────────────────────────────────────
  if (ep.match(/^results\/\d+/)) {
    return jsonResp([]);  // localStorage fallback client tomonda
  }

  return jsonResp({ error: "Noma'lum endpoint" }, 404);
}
