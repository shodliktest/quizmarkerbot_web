/**
 * TestPro — Vercel Edge Proxy (Hybrid)
 *
 * Meta so'rovlar  → TG kanal (tez, cache 60 soniya)
 * test/{id}/full  → TG kanaldan yuklab olish
 * result/save     → TG kanalga yuboradi
 *
 * Vercel env vars:
 *   BOT_TOKEN          = "123:ABC..."
 *   STORAGE_CHANNEL_ID = "-1001234567890"
 *   ADMIN_IDS          = "123456789"
 *   ADMIN_PASSWORD     = "parol"
 */

export const config = { runtime: 'edge' };

const BOT_TOKEN      = process.env.BOT_TOKEN          || '';
const STREAMLIT_URL      = process.env.STREAMLIT_URL      || '';
const BOT_INTERNAL_URL   = process.env.BOT_INTERNAL_URL   || '';  // http://bot-host:8080
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


// ══ FORMAT KONVERTATSIYA ═══════════════════════════════════════
function webToBot(q) {
  const opts   = (q.options || []).map(String);
  const labels = ['A','B','C','D','E','F','G','H'];
  const fmtOpts = opts.map((o, i) => {
    const lbl = labels[i] || String.fromCharCode(65 + i);
    return /^[A-H]\s*[).]/.test(o) ? o : `${lbl}) ${o}`;
  });
  let correctStr = '';
  if (typeof q.correct === 'number') {
    correctStr = fmtOpts[q.correct] || fmtOpts[0] || '';
  } else if (typeof q.correct === 'string') {
    correctStr = q.correct;
  }
  const typeMap = { multiple: 'multiple_choice', truefalse: 'true_false', 'true_false': 'true_false', multiple_choice: 'multiple_choice' };
  const photoId = q.photo || q.image || null;
  const result = {
    type:        typeMap[q.type] || q.type || 'multiple_choice',
    question:    q.question || q.text || '',
    options:     fmtOpts,
    correct:     correctStr,
    explanation: q.explanation || '',
    points:      q.points || 1,
    poll_time:   q.poll_time || 30,
  };
  // photo field — bot test yechganda rasmni ko'rsatadi
  if (photoId && !photoId.startsWith('data:')) {
    result.photo = photoId;
  }
  return result;
}

function botToWeb(q, idx) {
  const opts = (q.options || []).map(String);
  const typeMap = { multiple_choice: 'multiple', true_false: 'truefalse', truefalse: 'truefalse', multiple: 'multiple' };
  let correctIdx = 0;
  if (typeof q.correct === 'number') {
    correctIdx = q.correct;
  } else if (typeof q.correct === 'string') {
    const m = q.correct.match(/^([A-H])\s*[).]/i);
    if (m) {
      correctIdx = m[1].toUpperCase().charCodeAt(0) - 65;
    } else {
      const ci = opts.findIndex(o => o === q.correct || o.includes(q.correct) || q.correct.includes(o.replace(/^[A-H][).] */, '')));
      correctIdx = ci >= 0 ? ci : 0;
    }
  }
  return {
    type:        typeMap[q.type] || q.type || 'multiple',
    text:        q.text || q.question || '',
    question:    q.text || q.question || '',
    options:     opts,
    correct:     correctIdx,
    explanation: q.explanation || '',
    points:      q.points || 1,
    poll_time:   q.poll_time || 30,
    photo:       q.photo || null,   // TG file_id
    image:       q.image || null,   // base64 preview
  };
}

function normMeta(t) {
  const out = { ...t };
  delete out.questions;
  out.id           = out.id       || out.test_id;
  out.test_id      = out.test_id  || out.id;
  out.authorId     = out.authorId || String(out.creator_id || '');
  out.subject      = out.subject  || out.category || 'other';
  out.category     = out.category || out.subject  || 'other';
  out.creator_name = out.creator_name || out.authorName || '';
  out.is_active    = out.is_active !== false;
  out.is_paused    = out.is_paused || false;
  out.question_count = out.question_count || out.questionCount || 0;
  return out;
}

// ── Bot Internal API — zahoti RAM yangilash ───────────────────
async function botAPI(params) {
  // Bot ichidagi HTTP server ga murojaat (port 8080)
  // Streamlit API ham zaxira sifatida ishlaydi
  const url  = BOT_INTERNAL_URL || STREAMLIT_URL;
  if (!url) return null;

  try {
    if (BOT_INTERNAL_URL) {
      // Bot HTTP server — to'g'ridan murojaat
      const res = await fetch(
        BOT_INTERNAL_URL.replace(/\/?$/, '') + '/internal?' + new URLSearchParams(params),
        { method: 'POST' }
      );
      return res.json();
    } else {
      // Streamlit fallback
      return await streamlitAPI(params);
    }
  } catch { return null; }
}

// ── Streamlit RAM API ─────────────────────────────────────────
async function streamlitAPI(params) {
  if (!STREAMLIT_URL) return null;
  try {
    const base = STREAMLIT_URL.replace(/\/?$/, '');
    const qs   = new URLSearchParams(params).toString();
    const url  = `${base}/?${qs}`;
    const res  = await fetch(url, {
      headers: { 'Accept': 'text/html,application/json' },
      // Streamlit session cookie kerak emas — query_params API sessiyasiz ishlaydi
    });
    const txt = await res.text();
    // Streamlit <pre> tegi ichidagi JSON ni olish
    const pre = txt.match(/<pre[^>]*>(\{[\s\S]*?\})<\/pre>/i);
    if (pre) return JSON.parse(pre[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
    // Fallback: to'g'ridan JSON topish
    const raw = txt.match(/\{"ok"[\s\S]*?\}/);
    if (raw) return JSON.parse(raw[0]);
    return null;
  } catch (e) {
    console.warn('streamlitAPI error:', e);
    return null;
  }
}

// ── File o'qish yordamchilari ───────────────────────────────────
async function getPhotoUrl(fileId) {
  // TG file_id dan to'g'ridan URL yaratish
  if (!fileId || typeof fileId !== 'string') return null;
  try {
    const f = await tgPost('getFile', { file_id: fileId });
    const p = f?.result?.file_path;
    if (!p) return null;
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${p}`;
  } catch { return null; }
}

async function readFileId(fileId) {
  try {
    const f = await tgPost('getFile', { file_id: fileId });
    const p = f?.result?.file_path;
    if (!p) return null;
    const raw = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${p}`);
    return raw.json();
  } catch { return null; }
}

// ── Index cache (60 soniya) ────────────────────────────────────
let _idx = null, _idxTs = 0;

async function getIndex() {
  if (_idx && Date.now() - _idxTs < 60_000) return _idx;
  try {
    const chat = await tgPost('getChat', { chat_id: CHANNEL_ID });
    const pin  = chat?.result?.pinned_message;
    if (!pin?.document) return null;

    const fname   = pin.document.file_name || '';
    const pinData = await readFileId(pin.document.file_id);
    if (!pinData) return null;

    // ── YANGI FORMAT: index_meta.json (chunked) ──────────────────
    // Pinned fayl "index_chunks" ro'yxatini o'z ichiga oladi.
    // Har bir chunk alohida JSON fayl — tests_meta[] va test_{tid} msg_id lar.
    if (pinData.index_chunks || fname.includes('index_meta')) {
      const chunks = pinData.index_chunks || [];
      const merged = { tests_meta: [] };

      for (const ch of chunks) {
        let chData = null;

        // 1. fid (file_id cache) orqali tez o'qish
        if (ch.fid) {
          chData = await readFileId(ch.fid);
        }

        // 2. fid ishlamasa msg_id orqali forward qilib o'qish
        if (!chData && ch.msg_id) {
          chData = await tgGetFull(ch.msg_id);
        }

        if (!chData) continue;

        // Chunk ichidagi tests_meta ni birlashtirish
        for (const m of (chData.tests_meta || [])) {
          if (!merged.tests_meta.find(x => x.test_id === m.test_id)) {
            merged.tests_meta.push(m);
          }
        }
        // test_{tid} va fid_{msg_id} kalitlarini ko'chirish
        for (const [k, v] of Object.entries(chData)) {
          if (k.startsWith('test_') || k.startsWith('fid_')) {
            merged[k] = v;
          }
        }
      }

      if (merged.tests_meta.length > 0) {
        _idx = merged; _idxTs = Date.now();
        return _idx;
      }
      return null;
    }

    // ── ESKI FORMAT: index.json (tests_meta to'g'ridan bor) ──────
    if (pinData.tests_meta) {
      _idx = pinData; _idxTs = Date.now();
    }
    return _idx;
  } catch { return null; }
}

// ── TG dan test fayl yuklab olish ──────────────────────────────
async function tgGetFull(msgId) {
  try {
    const fwd = await tgPost('forwardMessage', {
      chat_id: CHANNEL_ID, from_chat_id: CHANNEL_ID, message_id: parseInt(msgId),
    });
    const doc = fwd?.result?.document;
    if (!doc) return null;
    tgPost('deleteMessage', { chat_id: CHANNEL_ID, message_id: fwd.result.message_id });
    return readFileId(doc.file_id);
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

  // ── config — frontend uchun env vars ─────────────────────────
  if (ep === 'config') {
    return jsonResp({
      streamlit_url: STREAMLIT_URL || '',
    });
  }

  // ── DEBUG ──────────────────────────────────────────────────────
  if (ep === 'debug') {
    const chat = await tgPost('getChat', { chat_id: CHANNEL_ID });
    const pin  = chat?.result?.pinned_message;
    const pinData = pin?.document ? await readFileId(pin.document.file_id) : null;
    return jsonResp({
      bot_token_set:   !!BOT_TOKEN,
      channel_id:      CHANNEL_ID,
      chat_ok:         chat?.ok,
      chat_error:      chat?.error_code,
      chat_desc:       chat?.description,
      has_pin:         !!pin,
      pin_has_doc:     !!pin?.document,
      pin_file:        pin?.document?.file_name || null,
      pin_format:      pinData?.index_chunks ? 'YANGI (chunked)' : pinData?.tests_meta ? 'ESKI (flat)' : 'NOMA\'LUM',
      chunks_count:    pinData?.index_chunks?.length || 0,
      index_tests:     (await getIndex())?.tests_meta?.length || 0,
    });
  }

  let body = null;
  if (request.method === 'POST') {
    try { body = await request.json(); } catch {}
  }

  // ── tests/public ──────────────────────────────────────────────
  if (ep === 'tests/public') {
    const index = await getIndex();
    if (!index) return jsonResp([]);
    const meta = (index.tests_meta || [])
      .filter(t => t.visibility === 'public' && t.is_active !== false && !t.is_paused)
      .map(({ questions, ...t }) => normMeta(t));
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

  // ── test/{id}/full ────────────────────────────────────────────
  if (ep.startsWith('test/') && ep.endsWith('/full')) {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' }, 500);

    const meta  = (index.tests_meta || []).find(t => t.test_id === tid);
    if (!meta) return jsonResp({ error: 'Test topilmadi' }, 404);

    // Avval fid_* cache dan qidirish
    const msgId = index[`test_${tid}`];
    if (!msgId) return jsonResp({ error: 'Test fayli topilmadi' }, 404);

    // fid cache bor bo'lsa tezroq o'qish
    const fidKey = `fid_${msgId}`;
    let full = null;
    if (index[fidKey]) {
      full = await readFileId(index[fidKey]);
    }
    if (!full?.questions?.length) {
      full = await tgGetFull(msgId);
    }
    if (!full?.questions?.length) return jsonResp({ error: 'Savollar topilmadi' }, 404);

    const t = normMeta({ ...meta, ...full });
    t.id      = t.id      || t.test_id || tid;
    t.test_id = t.test_id || tid;
    t.authorId= t.authorId|| String(t.creator_id || '');
    t.subject = t.subject || t.category || 'other';
    // Savollarni oddiy map - rasm URL lar alohida endpoint orqali olinadi
    const rawQsList = full.questions || [];
    const webQs = rawQsList.map((q, i) => botToWeb(q, i));
    return jsonResp({ testData: t, questions: webQs, total: webQs.length });
  }

  // ── photo/url — file_id dan URL ─────────────────────────────────
  if (ep === 'photo/url' && request.method === 'POST') {
    try {
      const { file_id } = body || {};
      if (!file_id) return jsonResp({ error: 'file_id kerak' }, 400);
      const url = await getPhotoUrl(file_id);
      if (!url) return jsonResp({ error: 'URL topilmadi' }, 404);
      return jsonResp({ ok: true, url });
    } catch(e) {
      return jsonResp({ error: String(e) }, 500);
    }
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
    const { authorId, title, description, subject, category, visibility,
            timeLimit, passScore, shuffleQuestions, showResult, questionCount,
            authorName, questions, difficulty, poll_time, max_attempts } = body || {};
    if (!title) return jsonResp({ error: 'Title kerak' }, 400);
    const tid = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const testDoc = {
      test_id: tid, creator_id: parseInt(authorId) || 0, creator_name: authorName || '',
      title: title || 'Nomsiz', category: category || subject || 'Boshqa',
      difficulty: difficulty || 'medium', visibility: visibility || 'public',
      time_limit: parseInt(timeLimit) || 0, poll_time: parseInt(poll_time) || 30,
      passing_score: parseInt(passScore) || 60, max_attempts: parseInt(max_attempts) || 0,
      questions: (questions || []).map(q => webToBot(q)), question_count: (questions || []).length || parseInt(questionCount) || 0,
      solve_count: 0, avg_score: 0.0, is_active: true, is_paused: false,
      created_at: new Date().toISOString(), description: description || '',
      shuffle_questions: !!shuffleQuestions, show_result: showResult !== false, source: 'web',
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
    const webQs2 = (full?.questions || []).map((q, i) => botToWeb(q, i));
    return jsonResp(webQs2);
  }

  // ── test/{id}/questions POST ──────────────────────────────────
  if (ep.match(/^test\/[^/]+\/questions$/) && request.method === 'POST') {
    const tid2   = ep.split('/')[1];
    const qs2    = (body?.questions || []).map(q => webToBot(q));
    const index2 = await getIndex();
    if (!index2) return jsonResp({ error: 'Index topilmadi' }, 500);

    // Eski TG xabarni o'qib meta olamiz
    const oldMsgId2 = index2[`test_${tid2}`];
    let oldDoc2 = {};
    if (oldMsgId2) {
      const old2 = await tgGetFull(oldMsgId2);
      if (old2) oldDoc2 = old2;
      // Eski xabarni kanaldan o'chirish — bot RAMdan tozalab yangi yuklasin
      try {
        await tgPost('deleteMessage', { chat_id: CHANNEL_ID, message_id: parseInt(oldMsgId2) });
      } catch {}
      // fid cache ni tozalash
      delete index2[`fid_${oldMsgId2}`];
    }

    const meta2   = (index2.tests_meta || []).find(t => t.test_id === tid2) || {};
    const newDoc2 = {
      ...oldDoc2, ...meta2,
      test_id:        tid2,
      questions:      qs2,
      question_count: qs2.length,
      updated_at:     new Date().toISOString(),
    };
    delete newDoc2._id;

    // Yangi fayl TG kanalga
    const tgData2 = await sendDoc(
      `test_${tid2}.json`, newDoc2,
      `📝 TEST | ${meta2.title || tid2} | ${tid2} | ✏️ tahrirlandi`
    );
    if (!tgData2?.ok) return jsonResp({ error: 'Kanalga yuborishda xato' }, 500);

    // Index yangilash — yangi msg_id
    const newMsgId2 = tgData2.result.message_id;
    index2[`test_${tid2}`] = newMsgId2;

    // fid cache — bot tez yuklasin uchun
    try {
      if (tgData2.result.document?.file_id) {
        index2[`fid_${newMsgId2}`] = tgData2.result.document.file_id;
      }
    } catch {}

    const m2 = (index2.tests_meta || []).find(t => t.test_id === tid2);
    if (m2) {
      m2.question_count = qs2.length;
      m2.updated_at     = newDoc2.updated_at;
    }

    // Yangilangan indexni kanalga saqlash
    await saveIndex(index2);

    // Proxy cache tozalash
    _idx   = null;
    _idxTs = 0;

    // Bot ga TG orqali buyruq — zahoti RAM tozalash va xabar
    const oldQc2   = meta2.question_count || 0;
    const creatorId2 = meta2.creator_id || 0;
    if (creatorId2) {
      // Kanalga WEB_CMD xabari — bot ushlab oladi, zahoti ishlaydi
      tgPost('sendMessage', {
        chat_id:              CHANNEL_ID,
        text:                 `WEB_CMD:UPDATE:${tid2}:${creatorId2}:${oldQc2}:${qs2.length}`,
        disable_notification: true,
      }).catch(() => {});
    }

    return jsonResp({ ok: true, count: qs2.length });
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
    const {
      userId, user_id, testId, testTitle, subject,
      userName, user_name, userUsername, user_username,
      score, correct, total, percentage, passing_score, passed,
      elapsed, detailed_results, userAnswers, completedAt, source
    } = body || {};

    const finalUid   = String(userId || user_id || '0');
    const finalName  = userName || user_name || ('User' + finalUid);
    const finalUname = userUsername || user_username || '';
    if (!finalUid || finalUid==='0' || !testId) {
      return jsonResp({ error: 'userId va testId kerak' });
    }

    const rid = `${finalUid}_${testId}_${Date.now()}`;
    const doc = {
      result_id:      rid,
      user_id:        finalUid,
      user_name:      finalName,
      user_username:  finalUname,
      test_id:        testId,
      test_title:     testTitle || testId,
      subject:        subject || '',
      source:         source || 'web',
      score:          parseFloat(score||percentage||0),
      correct:        parseInt(correct||0),
      total:          parseInt(total||0),
      percentage:     parseFloat(percentage||score||0),
      passing_score:  parseFloat(passing_score||60),
      passed:         passed || (parseFloat(percentage||0) >= parseFloat(passing_score||60)),
      elapsed:        parseInt(elapsed||0),
      detailed_results: detailed_results || userAnswers || [],
      completedAt:    completedAt || new Date().toISOString(),
    };

    // TG kanalga saqlash
    const tgRes = await sendDoc(
      `result_${rid}.json`, doc,
      `📊 RESULT | ${finalName} | ${testId} | ${Math.round(parseFloat(percentage||0))}%`
    );

    // Index yangilash
    const idx2 = await getIndex();
    if (idx2) {
      const meta2 = (idx2.tests_meta || []).find(t => t.test_id === testId);
      if (meta2) {
        const sc = (meta2.solve_count || 0) + 1;
        meta2.solve_count = sc;
        meta2.avg_score   = Math.round(((meta2.avg_score||0)*(sc-1) + parseFloat(percentage||0))/sc * 10)/10;
      }
      if (tgRes?.ok) {
        const rmid = tgRes.result.message_id;
        const rfid = tgRes.result.document?.file_id;
        idx2[`result_${testId}_${rid}`] = rmid;
        if (rfid) idx2[`rfid_${rmid}`] = rfid;
      }
      saveIndex(idx2).catch(()=>{});
    }

    return jsonResp({ ok: true, result_id: rid });
  }


  // ── test/{id}/split ──────────────────────────────────────────
  // Bo'lish: {parts:[{from,to},...]} → {ok, created:[{tid,title,count,link}]}
  if (ep.match(/^test\/[^\/]+\/split$/) && request.method === 'POST') {
    const tid   = ep.split('/')[1];
    const index = await getIndex();
    if (!index) return jsonResp({ error: 'Index topilmadi' }, 500);

    const meta = (index.tests_meta || []).find(t => t.test_id === tid);
    if (!meta) return jsonResp({ error: 'Test topilmadi' }, 404);

    // To'liq testni yuklash
    const msgId = index[`test_${tid}`];
    if (!msgId) return jsonResp({ error: 'Test fayli topilmadi' }, 404);

    let full = null;
    const fidKey = `fid_${msgId}`;
    if (index[fidKey]) { full = await readFileId(index[fidKey]); }
    if (!full?.questions?.length) { full = await tgGetFull(msgId); }
    if (!full?.questions?.length) return jsonResp({ error: 'Savollar topilmadi' }, 404);

    const { parts } = body || {};
    if (!parts || !parts.length) return jsonResp({ error: 'parts kerak' }, 400);

    // Raqamni emoji ga aylantirish
    const D = {'0':'0️⃣','1':'1️⃣','2':'2️⃣','3':'3️⃣','4':'4️⃣',
               '5':'5️⃣','6':'6️⃣','7':'7️⃣','8':'8️⃣','9':'9️⃣'};
    function numEmoji(n) {
      if (n === 10) return '🔟';
      if (n === 100) return '💯';
      return String(n).split('').map(c => D[c] || c).join('');
    }

    const baseTitle   = meta.title || 'Test';
    const baseVis     = meta.visibility || 'public';
    const created     = [];

    for (const p of parts) {
      const chunk   = full.questions.slice(p.from - 1, p.to);
      if (!chunk.length) continue;

      const partTitle = `${baseTitle} ${numEmoji(p.from)}➖${numEmoji(p.to)}`;
      const newTid    = Array.from(crypto.getRandomValues(new Uint8Array(4)))
        .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

      const newDoc = {
        test_id:          newTid,
        creator_id:       meta.creator_id || 0,
        creator_name:     meta.creator_name || '',
        creator_username: meta.creator_username || '',
        title:            partTitle,
        category:         meta.category || meta.subject || 'Boshqa',
        difficulty:       meta.difficulty || 'medium',
        visibility:       baseVis,
        time_limit:       meta.time_limit || 0,
        poll_time:        meta.poll_time || 30,
        passing_score:    meta.passing_score || 60,
        max_attempts:     meta.max_attempts || 0,
        questions:        chunk,
        question_count:   chunk.length,
        solve_count:      0,
        avg_score:        0.0,
        is_active:        true,
        is_paused:        false,
        created_at:       new Date().toISOString(),
        source:           'web_split',
      };

      const tgData = await sendDoc(
        `test_${newTid}.json`, newDoc,
        `📝 TEST | ${partTitle} | ${newTid}`
      );
      if (!tgData?.ok) continue;

      // Indexga qo'shish
      const newMeta = { ...newDoc }; delete newMeta.questions;
      (index.tests_meta = index.tests_meta || []).unshift(newMeta);
      index[`test_${newTid}`] = tgData.result.message_id;

      created.push({ tid: newTid, title: partTitle, count: chunk.length });
    }

    if (!created.length) return jsonResp({ error: 'Hech qaysi qism saqlanmadi' }, 500);

    // Yangilangan indexni saqlash
    await saveIndex(index);

    // Bot ga TG orqali buyruq — split xabarlari zahoti keladi
    {
      const origMeta  = (index.tests_meta || []).find(t =>
        created.some(cr => cr.tid === t.test_id)
      ) || {};
      const creatorId = origMeta.creator_id || 0;
      if (creatorId && created.length) {
        // WEB_CMD:SPLIT:{creator_id}:{tid}:{title}:{qc}|{tid}:{title}:{qc}
        const partsStr = created
          .map(cr => `${cr.tid}:${cr.title.replace(/[:|]/g, ' ')}:${cr.count}`)
          .join('|');
        tgPost('sendMessage', {
          chat_id:              CHANNEL_ID,
          text:                 `WEB_CMD:SPLIT:${creatorId}:${partsStr}`,
          disable_notification: true,
        }).catch(() => {});
      }
    }

    return jsonResp({ ok: true, created });
  }

  // ── results/{uid} ─────────────────────────────────────────────
  if (ep.match(/^results\/\d+/)) return jsonResp([]);

  // ── photo/upload — rasmni TG ga yuborib file_id qaytaradi ────
  if (ep === 'photo/upload' && request.method === 'POST') {
    try {
      const { image_b64, filename } = body || {};
      if (!image_b64) return jsonResp({ error: 'image_b64 kerak' }, 400);

      // Base64 dan binary
      const b64data = image_b64.replace(/^data:image\/\w+;base64,/, '');
      const mime    = image_b64.startsWith('data:image/png') ? 'image/png'
                    : image_b64.startsWith('data:image/gif') ? 'image/gif'
                    : 'image/jpeg';
      const ext  = mime.split('/')[1];
      const name = filename || ('photo_' + Date.now() + '.' + ext);

      // Binary decode
      const binaryStr = atob(b64data);
      const bytes     = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mime });

      // FormData bilan TG ga yuborish
      const form = new FormData();
      form.append('chat_id', CHANNEL_ID);
      form.append('photo', blob, name);
      form.append('disable_notification', 'true');

      const res  = await fetch(`${TG}/sendPhoto`, { method: 'POST', body: form });
      const data = await res.json();

      if (!data?.ok) {
        return jsonResp({ error: 'TG xato: ' + (data?.description || JSON.stringify(data)) }, 500);
      }

      // Eng katta o'lchamdagi photo
      const photos  = data.result.photo || [];
      const biggest = photos[photos.length - 1];
      const file_id = biggest?.file_id || '';

      return jsonResp({ ok: true, file_id, message_id: data.result.message_id });
    } catch (e) {
      return jsonResp({ error: 'photo/upload xato: ' + String(e) }, 500);
    }
  }

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
