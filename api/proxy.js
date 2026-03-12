/**
 * TestPro — Vercel Edge Proxy (Hybrid)
 *
 * Meta so'rovlar  → TG kanal (tez, cache 5 daqiqa)
 * test/{id}/full  → Streamlit API (savollar RAM da)
 * result/save     → TG kanalga yuboradi
 *
 * Vercel env vars:
 *   BOT_TOKEN          = "123:ABC..."
 *   STORAGE_CHANNEL_ID = "-1001234567890"
 *   STREAMLIT_URL      = "https://webapiquizmarkerbot.streamlit.app"
 *   ADMIN_IDS          = "123456789"
 *   ADMIN_PASSWORD     = "parol"
 */

export const config = { runtime: 'edge' };

const BOT_TOKEN   = process.env.BOT_TOKEN          || '';
const CHANNEL_ID  = process.env.STORAGE_CHANNEL_ID || '';
const ADMIN_IDS   = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_PASS  = process.env.ADMIN_PASSWORD     || 'admin123';
const TG          = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TG-ID',
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function tgPost(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function normMeta(t) {
  const out = { ...t };
  delete out.questions;
  out.id       = out.id       || out.test_id;
  out.authorId = out.authorId || String(out.creator_id || '');
  out.subject  = out.subject  || out.category || 'other';
  out.creator_name = out.creator_name || out.authorName || '';
  return out;
}

// ── Index cache (5 daqiqa) ──────────────────────────────────────
let _idx = null, _idxTs = 0;

async function getIndex() {
  if (_idx && Date.now() - _idxTs < 300_000) return _idx;
  try {
    const chat = await tgPost('getChat', { chat_id: CHANNEL_ID });
    const pin  = chat?.result?.pinned_message;
    if (!pin?.document) return null;
    const f = await tgPost('getFile', { file_id: pin.document.file_id });
    const p = f?.result?.file_path;
    if (!p) return null;
    const raw  = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${p}`);
    const data = await raw.json();
    if (data?.tests_meta) { _idx = data; _idxTs = Date.now(); }
    return _idx;
  } catch { return null; }
}

// ── Streamlit dan test/full olish ──────────────────────────────
// ── TG dan test fayl yuklab olish (fallback) ───────────────────
async function tgGetFull(msgId) {
  try {
    const fwd = await tgPost('forwardMessage', {
      chat_id: CHANNEL_ID, from_chat_id: CHANNEL_ID, message_id: parseInt(msgId),
    });
    const doc = fwd?.result?.document;
    if (!doc) return null;
    tgPost('deleteMessage', { chat_id: CHANNEL_ID, message_id: fwd.result.message_id });
    const f = await tgPost('getFile', { file_id: doc.file_id });
    const p = f?.result?.file_path;
    if (!p) return null;
    const raw = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${p}`);
    return raw.json();
  } catch { return null; }
}

// ── Multipart yuborish ─────────────────────────────────────────
async function sendDoc(filename, data, caption) {
  const boundary = '----FB' + Math.random().toString(36).slice(2);
  const content  = JSON.stringify(data, null, 2);
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHANNEL_ID}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/json\r\n\r\n${content}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="disable_notification"\r\n\r\ntrue`,
    `--${boundary}--`,
  ].join('\r\n');
  const res = await fetch(`${TG}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: parts,
  });
  return res.json();
}

async function saveIndex(index) {
  const d = await sendDoc('index.json', index, '📋 INDEX | ' + new Date().toISOString().slice(0, 16));
  if (d?.ok) {
    await tgPost('pinChatMessage', { chat_id: CHANNEL_ID, message_id: d.result.message_id, disable_notification: true });
    _idx = index; _idxTs = Date.now();
  }
  return d?.ok || false;
}

// ════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════
export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const url = new URL(request.url);
  const ep  = url.searchParams.get('endpoint') || '';

  // ── DEBUG ──────────────────────────────────────────────────────
  if (ep === 'debug') {
    const chat = await tgPost('getChat', { chat_id: CHANNEL_ID });
    const pin  = chat?.result?.pinned_message;
    return jsonResp({
      bot_token_set: !!BOT_TOKEN,
      channel_id:    CHANNEL_ID,
      chat_ok:       chat?.ok,
      chat_error:    chat?.error_code,
      chat_desc:     chat?.description,
      has_pin:       !!pin,
      pin_has_doc:   !!pin?.document,
      pin_file:      pin?.document?.file_name || null,
    });
  }
  let body  = null;
  if (request.method === 'POST') {
    try { body = await request.json(); } catch {}
  }

  // ── tests/public ──────────────────────────────────────────────
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
          if (r?.ok) t.creator_name = [r.result.first_name, r.result.last_name].filter(Boolean).join(' ') || r.result.username || '';
        } catch {}
      }
    }));
    return jsonResp(meta.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))));
  }

  // ── tests/my ──────────────────────────────────────────────────
  if (ep === 'tests/my') {
    const uid   = url.searchParams.get('uid') || '';
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const mine = (index.tests_meta || [])
      .filter(t => String(t.creator_id) === uid)
      .map(({ questions, ...t }) => normMeta(t));
    return jsonResp(mine);
  }

  // ── test/{id}/full — TG kanaldan yuklab olish ────────────────────
  if (ep.startsWith('test/') && ep.endsWith('/full')) {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' }, 500);

    const meta  = (index.tests_meta || []).find(t => t.test_id === tid);
    if (!meta) return jsonResp({ error: 'Test topilmadi' }, 404);

    const msgId = index[`test_${tid}`];
    if (!msgId) return jsonResp({ error: 'Test fayli topilmadi' }, 404);

    const full = await tgGetFull(msgId);
    if (!full?.questions?.length) return jsonResp({ error: 'Savollar topilmadi' }, 404);

    const t = normMeta({ ...meta, ...full });
    t.id      = t.id      || t.test_id || tid;
    t.test_id = t.test_id || tid;
    t.authorId= t.authorId|| String(t.creator_id || '');
    t.subject = t.subject || t.category || 'other';
    return jsonResp({ testData: t, questions: full.questions, total: full.questions.length });
  }

  // ── test/{id}/meta ────────────────────────────────────────────
  if (ep.startsWith('test/') && ep.endsWith('/meta')) {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    const meta  = (index?.tests_meta || []).find(t => t.test_id === tid);
    if (!meta) return jsonResp({ error: 'Topilmadi' }, 404);
    return jsonResp(normMeta({ ...meta }));
  }

  // ── test/{id} bare ────────────────────────────────────────────
  if (ep.match(/^test\/[^/]+$/) && request.method === 'GET') {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    const meta  = (index?.tests_meta || []).find(t => t.test_id === tid);
    if (!meta) return jsonResp({ error: 'Topilmadi' }, 404);
    return jsonResp(normMeta({ ...meta }));
  }

  // ── test/create ───────────────────────────────────────────────
  if (ep === 'test/create' && request.method === 'POST') {
    // web va bot format maydonlarini ikkalasini ham qabul qilish
    const {
      authorId, creator_id,
      title, description,
      subject, category,
      visibility,
      timeLimit, time_limit,
      passScore, passing_score,
      shuffleQuestions, shuffle_questions,
      showResult, show_result,
      questionCount, question_count,
      authorName, creator_name,
      questions,
      difficulty,
      poll_time,
      max_attempts,
    } = body || {};
    if (!title) return jsonResp({ error: 'Title kerak' }, 400);
    const tid = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const qs = questions || [];
    const testDoc = {
      test_id:          tid,
      creator_id:       parseInt(authorId || creator_id) || 0,
      creator_name:     authorName || creator_name || '',
      title:            title || 'Nomsiz',
      category:         category || subject || 'Boshqa',
      difficulty:       difficulty || 'medium',
      visibility:       visibility || 'public',
      time_limit:       parseInt(time_limit || timeLimit) || 0,
      poll_time:        parseInt(poll_time) || 30,
      passing_score:    parseInt(passing_score || passScore) || 60,
      max_attempts:     parseInt(max_attempts) || 0,
      questions:        qs,
      question_count:   qs.length || parseInt(question_count || questionCount) || 0,
      solve_count:      0,
      avg_score:        0.0,
      is_active:        true,
      is_paused:        false,
      created_at:       new Date().toISOString(),
      description:      description || '',
      shuffle_questions: !!(shuffle_questions || shuffleQuestions),
      show_result:      (show_result ?? showResult) !== false,
      source:           'web',
    };
    const tgData = await sendDoc(`test_${tid}.json`, testDoc, `📝 TEST | ${title} | ${tid}`);
    if (!tgData?.ok) return jsonResp({ error: 'Kanalga yuborishda xato' }, 500);
    const index = await getIndex();
    if (index) {
      const meta = { ...testDoc }; delete meta.questions;
      (index.tests_meta = index.tests_meta || []).unshift(meta);
      index[`test_${tid}`] = tgData.result.message_id;
      await saveIndex(index);
    }
    return jsonResp({ ok: true, id: tid, test_id: tid });
  }

  // ── test/{id}/questions GET ───────────────────────────────────
  if (ep.match(/^test\/[^/]+\/questions$/) && request.method === 'GET') {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    const msgId = index?.[`test_${tid}`];
    if (!msgId) return jsonResp([]);
    const full = await tgGetFull(msgId);
    return jsonResp(full?.questions || []);
  }

  // ── test/{id}/update ──────────────────────────────────────────
  if (ep.match(/^test\/[^/]+\/update$/) && request.method === 'POST') {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    const meta = (index.tests_meta || []).find(t => t.test_id === tid);
    if (meta) {
      Object.assign(meta, {
        title:         body?.title        || meta.title,
        category:      body?.category     || body?.subject || meta.category,
        visibility:    body?.visibility   || meta.visibility,
        time_limit:    body?.timeLimit    ?? meta.time_limit,
        passing_score: body?.passScore    ?? meta.passing_score,
        is_paused:     body?.is_paused    ?? meta.is_paused,
      });
      await saveIndex(index);
    }
    return jsonResp({ ok: true });
  }

  // ── test/{id}/delete ──────────────────────────────────────────
  if (ep.match(/^test\/[^/]+\/delete$/) && request.method === 'POST') {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    index.tests_meta = (index.tests_meta || []).filter(t => t.test_id !== tid);
    delete index[`test_${tid}`];
    await saveIndex(index);
    return jsonResp({ ok: true });
  }

  // ── user/{uid} ────────────────────────────────────────────────
  if (ep.startsWith('user/') && ep.split('/').length === 2) {
    const uid = ep.split('/')[1];
    if (!/^\d+$/.test(uid)) return jsonResp({ error: "Noto'g'ri ID" }, 400);
    const res = await tgPost('getChat', { chat_id: parseInt(uid) });
    if (!res?.ok) return jsonResp({ error: 'Topilmadi' }, 404);
    const u = res.result;
    return jsonResp({
      id: String(u.id), uid: String(u.id),
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || `User${uid}`,
      username: u.username || '',
      is_admin: ADMIN_IDS.includes(String(u.id)),
      role: ADMIN_IDS.includes(String(u.id)) ? 'admin' : 'user',
    });
  }

  // ── admin/login ───────────────────────────────────────────────
  if (ep === 'admin/login') {
    if (!ADMIN_IDS.includes(String(body?.uid)))  return jsonResp({ ok: false, error: 'Admin emassiz' });
    if (body?.password !== ADMIN_PASS)           return jsonResp({ ok: false, error: "Parol noto'g'ri" });
    return jsonResp({ ok: true });
  }

  // ── admin/tests ───────────────────────────────────────────────
  if (ep === 'admin/tests') {
    const index = await getIndex();
    if (!index) return jsonResp([]);
    return jsonResp((index.tests_meta || []).map(({ questions, ...t }) => normMeta(t)));
  }

  // ── admin/stats ───────────────────────────────────────────────
  if (ep === 'admin/stats') {
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' });
    const tests  = index.tests_meta || [];
    const active = tests.filter(t => t.is_active !== false);
    const pub    = active.filter(t => t.visibility === 'public');
    const totalSolve = tests.reduce((s, t) => s + (t.solve_count || 0), 0);
    const scored = tests.filter(t => t.avg_score);
    const avgScore = scored.length ? Math.round(scored.reduce((s,t) => s+t.avg_score, 0) / scored.length) : 0;
    const byCategory = {};
    tests.forEach(t => {
      const cat = t.category || t.subject || 'other';
      if (!byCategory[cat]) byCategory[cat] = { count: 0, solves: 0, avg: [] };
      byCategory[cat].count++; byCategory[cat].solves += t.solve_count || 0;
      if (t.avg_score) byCategory[cat].avg.push(t.avg_score);
    });
    const categories = Object.entries(byCategory).map(([name, d]) => ({
      name, count: d.count, solves: d.solves,
      avg: d.avg.length ? Math.round(d.avg.reduce((a,b)=>a+b)/d.avg.length) : 0,
    })).sort((a,b) => b.solves - a.solves);
    const now   = Date.now();
    const days7 = Array.from({length:7},(_,i) => new Date(now-i*86400000).toISOString().slice(0,10)).reverse();
    const byDay = {}; days7.forEach(d => { byDay[d] = {created:0,solves:0}; });
    tests.forEach(t => { const d=(t.created_at||'').slice(0,10); if(byDay[d]){byDay[d].created++;byDay[d].solves+=t.solve_count||0;} });
    return jsonResp({
      totalTests: tests.length, activeTests: active.length, pubTests: pub.length,
      totalSolve, avgScore, categories,
      topTests: [...active].sort((a,b)=>(b.solve_count||0)-(a.solve_count||0)).slice(0,5).map(({questions,...t})=>normMeta(t)),
      timeline: days7.map(d=>({date:d,...byDay[d]})),
    });
  }

  // ── admin/test/{id}/pause ─────────────────────────────────────
  if (ep.match(/^admin\/test\/.+\/pause$/)) {
    const tid   = ep.split('/')[2];
    const index = await getIndex();
    const meta  = (index?.tests_meta || []).find(t => t.test_id === tid);
    if (meta) { meta.is_paused = !meta.is_paused; await saveIndex(index); }
    return jsonResp({ ok: true, is_paused: meta?.is_paused ?? false });
  }

  // ── admin/test/{id}/delete ────────────────────────────────────
  if (ep.match(/^admin\/test\/.+\/delete$/)) {
    const tid   = ep.split('/')[2];
    const index = await getIndex();
    if (index) {
      index.tests_meta = (index.tests_meta || []).filter(t => t.test_id !== tid);
      delete index[`test_${tid}`];
      await saveIndex(index);
    }
    return jsonResp({ ok: true });
  }

  // ── result/save ───────────────────────────────────────────────
  if (ep === 'result/save' && request.method === 'POST') {
    const { userId, testId, userName, userUsername,
            score, total, percentage, passing_score, detailed_results, completedAt } = body || {};
    if (!userId || !testId) return jsonResp({ error: 'userId va testId kerak' });
    const rid = `${userId}_${testId}_${Date.now()}`;
    const doc = {
      result_id: rid, user_id: String(userId), user_name: userName || '',
      user_username: userUsername || '', test_id: testId,
      score: score || 0, total: total || 0, percentage: parseFloat(percentage) || 0,
      passing_score: passing_score || 60,
      passed: (parseFloat(percentage) || 0) >= (passing_score || 60),
      detailed_results: detailed_results || [],
      completed_at: completedAt ? new Date(completedAt).toISOString() : new Date().toISOString(),
      source: 'web',
    };
    sendDoc(`result_${rid}.json`, doc, `📊 RESULT | ${userName||userId} | ${testId} | ${Math.round(percentage||0)}%`).catch(()=>{});
    // Index da stats yangilash
    const index = await getIndex();
    if (index) {
      const meta = (index.tests_meta||[]).find(t=>t.test_id===testId);
      if (meta) {
        const sc=(meta.solve_count||0)+1;
        meta.solve_count=sc;
        meta.avg_score=Math.round(((meta.avg_score||0)*(sc-1)+(parseFloat(percentage)||0))/sc*10)/10;
        saveIndex(index).catch(()=>{});
      }
    }
    return jsonResp({ ok: true, result_id: rid });
  }

  // ── results/{uid} ─────────────────────────────────────────────
  if (ep.match(/^results\/\d+/)) return jsonResp([]);

  // ── otp/verify ────────────────────────────────────────────────
  if (ep === 'otp/verify') {
    const code = (body?.code || '').toUpperCase().trim();
    if (!code) return jsonResp({ ok: false, error: 'Kod kerak' });
    const parts = code.split(':');
    if (parts.length !== 3) return jsonResp({ ok: false, error: "Noto'g'ri format" });
    const [testId, ts, hash] = parts;
    if (Date.now() - parseInt(ts) > 600_000) return jsonResp({ ok: false, error: 'Muddati tugagan' });
    const buf  = new TextEncoder().encode(`${testId}:${ts}:${BOT_TOKEN.slice(-8)}`);
    const hb   = await crypto.subtle.digest('SHA-256', buf);
    const exp  = Array.from(new Uint8Array(hb)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,8).toUpperCase();
    if (exp !== hash) return jsonResp({ ok: false, error: "Noto'g'ri kod" });
    const index = await getIndex();
    const meta  = (index?.tests_meta||[]).find(t=>t.test_id===testId);
    return jsonResp({ ok: true, test_id: testId, meta: meta||{} });
  }

  return jsonResp({ error: "Noma'lum endpoint" }, 404);
}
