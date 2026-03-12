/* ================================================================
   TestPro — api.js  v4.0
   Telegram Login + proxy.js API
   ================================================================ */

const BOT_USERNAME = window.TESTPRO_BOT || 'Quizmarkerbot';
const API_URL      = '/api/proxy';

/* ── Navigation ── */
const BASE_PATH = (() => {
  const p = window.location.pathname;
  return p.substring(0, p.lastIndexOf('/') + 1);
})();
function goTo(page) { window.location.href = BASE_PATH + page; }

/* ── Subject map ── */
const SUBJECTS = {
  english:    { label: 'English',     emoji: '🇬🇧' },
  arabic:     { label: 'Arabcha',     emoji: '🕌'  },
  russian:    { label: 'Ruscha',      emoji: '🇷🇺' },
  turkish:    { label: 'Turkcha',     emoji: '🇹🇷' },
  uzbek:      { label: "O'zbekcha",   emoji: '🇺🇿' },
  math:       { label: 'Matematika',  emoji: '🧮'  },
  it:         { label: 'IT / CS',     emoji: '💻'  },
  science:    { label: 'Fanlar',      emoji: '🔬'  },
  religion:   { label: 'Din',         emoji: '📖'  },
  history:    { label: 'Tarix',       emoji: '🏛️'  },
  biology:    { label: 'Biologiya',   emoji: '🧬'  },
  chemistry:  { label: 'Kimyo',       emoji: '⚗️'  },
  physics:    { label: 'Fizika',      emoji: '⚡'  },
  literature: { label: 'Adabiyot',    emoji: '✍️'  },
  sport:      { label: 'Sport',       emoji: '⚽'  },
  other:      { label: 'Boshqa',      emoji: '📚'  },
};
function getSubject(k) {
  if (!k) return SUBJECTS.other;
  const low = k.toLowerCase().replace(/[\s\-_]/g, '');
  if (SUBJECTS[low]) return SUBJECTS[low];
  const f = Object.entries(SUBJECTS).find(([key]) => low.includes(key));
  return f ? f[1] : { label: k, emoji: '📚' };
}

/* ── Helpers ── */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}
function fmtDate(ts) {
  if (!ts) return '—';
  try {
    const ms = (typeof ts === 'number' && ts < 1e12) ? ts * 1000 : ts;
    return new Date(ms).toLocaleDateString('uz-UZ', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}
function fmtTime(secs) {
  secs = secs || 0;
  return String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
}
function randCode(n = 6) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
}
function getIco(s) {
  if (!s) return '📚';
  const k = (s || '').toLowerCase().replace(/[\s\-_]/g, '');
  const ICON = {english:'🇬🇧',arabic:'🕌',russian:'🇷🇺',turkish:'🇹🇷',uzbek:'🇺🇿',math:'🧮',it:'💻',science:'🔬',religion:'📖',history:'🏛️',biology:'🧬',chemistry:'⚗️',physics:'⚡',literature:'✍️',sport:'⚽',other:'📚'};
  return ICON[k] || Object.entries(ICON).find(([x]) => k.includes(x))?.[1] || '📚';
}

/* ════════════════════════════════════════════
   TELEGRAM AUTH
   ════════════════════════════════════════════ */
const TGAuth = {
  _k: 'tp_tg_user',
  save(u) {
    localStorage.setItem(this._k, JSON.stringify({ ...u, _at: Date.now() }));
  },
  get() {
    try {
      const u = JSON.parse(localStorage.getItem(this._k));
      if (!u) return null;
      if (Date.now() - u._at > 30 * 86400_000) { this.clear(); return null; }
      return u;
    } catch { return null; }
  },
  uid() {
    const u = this.get();
    return u ? String(u.id || u.uid || u._tg_id || '') : '';
  },
  clear() { localStorage.removeItem(this._k); },
  onLogin(user) {
    TGAuth.save(user);
    const next = new URLSearchParams(location.search).get('next') || 'dashboard.html';
    goTo(next);
  }
};

const AuthHelpers = {
  getCurrentUser() { return Promise.resolve(TGAuth.get()); },
  async requireAuth(fallback = 'login.html') {
    const u = TGAuth.get();
    if (!u) { goTo(fallback + '?next=' + encodeURIComponent(location.href)); return null; }
    return u;
  }
};

const auth = {
  signOut() { TGAuth.clear(); goTo('index.html'); return Promise.resolve(); },
  currentUser: null
};

/* ════════════════════════════════════════════
   LOCAL CACHE
   ════════════════════════════════════════════ */
const Cache = {
  _key(id)    { return 'tp_test_' + id; },
  _ansKey(id) { return 'tp_ans_'  + id; },
  saveTest(id, testData, questions) {
    try { localStorage.setItem(this._key(id), JSON.stringify({ testData, questions, savedAt: Date.now() })); }
    catch {}
  },
  loadTest(id) {
    try {
      const d = JSON.parse(localStorage.getItem(this._key(id)));
      if (!d || Date.now() - d.savedAt > 86400_000) { this.clearTest(id); return null; }
      return d;
    } catch { return null; }
  },
  clearTest(id) {
    localStorage.removeItem(this._key(id));
    localStorage.removeItem(this._ansKey(id));
  },
  saveAnswers(id, a) { try { localStorage.setItem(this._ansKey(id), JSON.stringify(a)); } catch {} },
  loadAnswers(id)    { try { return JSON.parse(localStorage.getItem(this._ansKey(id))); } catch { return null; } }
};

/* ════════════════════════════════════════════
   HTTP
   ════════════════════════════════════════════ */
async function _req(method, path, body) {
  const u = TGAuth.get();
  const headers = { 'Content-Type': 'application/json' };
  if (u) headers['X-TG-ID'] = String(u.id || u.uid || '');

  let url = API_URL;
  const match = path.match(/^\/api\/(.+)/);
  if (match) {
    const ep = match[1];
    const qIdx = ep.indexOf('?');
    if (qIdx !== -1) url += '?endpoint=' + ep.slice(0, qIdx) + '&' + ep.slice(qIdx + 1);
    else             url += '?endpoint=' + ep;
  } else {
    url += path;
  }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const GET  = p     => _req('GET',  p);
const POST = (p,b) => _req('POST', p, b);

/* ════════════════════════════════════════════
   NORMALIZE QUESTIONS  (bot format → web format)
   ════════════════════════════════════════════ */
function normalizeQ(arr) {
  return (arr || []).map(q => {
    const type =
      q.type === 'multiple_choice' ? 'multiple' :
      q.type === 'true_false'      ? 'truefalse' :
      q.type || 'multiple';
    const text    = q.text || q.question || q.q || '';
    const options = (q.options || []).map(o => String(o));
    let correct = 0;
    if (typeof q.correct === 'number') {
      correct = q.correct;
    } else if (typeof q.correct === 'string') {
      const idx = options.findIndex(o => o === q.correct || o.trim() === q.correct.trim());
      correct = idx >= 0 ? idx : 0;
    }
    return { ...q, type, text, options, correct, explanation: q.explanation || '', points: q.points || 1 };
  });
}

/* ════════════════════════════════════════════
   DB
   ════════════════════════════════════════════ */
const DB = {

  /* ── USER ── */
  async getUser(uid) {
    try { return await GET('/api/user/' + uid); } catch { return null; }
  },
  async updateUser(uid, data) {
    return POST('/api/user/' + uid + '/update', data).catch(() => {});
  },

  /* ── TESTS ── */
  async getMyTests(authorId) {
    try { return await GET('/api/tests/my?uid=' + authorId); } catch { return []; }
  },
  async getPublicTests() {
    try { return await GET('/api/tests/public'); } catch { return []; }
  },
  async getTestByCode(code) {
    const c = code.toUpperCase().trim();
    if (c.includes(':')) {
      const res = await POST('/api/otp/verify', { code: c, uid: TGAuth.get()?.id || 0 });
      if (res?.ok) return { id: res.test_id, test_id: res.test_id, ...(res.meta || {}) };
      throw new Error(res?.error || "Noto'g'ri kod");
    }
    return await GET('/api/test/' + c + '/meta');
  },
  async createTest(data) {
    return POST('/api/test/create', data);
  },
  async updateTest(id, data) {
    return POST('/api/test/' + id + '/update', data);
  },
  async deleteTest(id) {
    Cache.clearTest(id);
    return POST('/api/test/' + id + '/delete', {});
  },

  /* ── QUESTIONS ── */
  async getTestWithQuestions(testId) {
    const c = Cache.loadTest(testId);
    if (c?.questions?.length) return { testData: c.testData, questions: c.questions };
    const d = await GET('/api/test/' + testId + '/full');
    if (d?.testData) Cache.saveTest(testId, d.testData, d.questions || []);
    return d || { testData: null, questions: [] };
  },
  async saveQuestions(testId, questions) {
    const res = await POST('/api/test/' + testId + '/questions', { questions });
    const c = Cache.loadTest(testId);
    if (c) Cache.saveTest(testId, c.testData, questions);
    return res;
  },

  /* ── RESULTS ── */
  async saveResult(data) {
    const u  = TGAuth.get() || {};
    const uid = String(u.id || u.uid || '');
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name || '';

    const resultId = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const result = {
      ...data,
      id:          resultId,
      userId:      uid,
      user_id:     uid,   // alias — ikki format uchun
      userName:    name,
      userUsername: u.username || '',
      completedAt: Date.now(),
      // testTitle ni saqlaymiz
      testTitle:   data.testTitle || data.title || data.testId || '',
      subject:     data.subject || 'other',
    };

    /* localStorage saqlash */
    try {
      const all = JSON.parse(localStorage.getItem('tp_results') || '[]');
      all.unshift(result);
      if (all.length > 300) all.splice(300);
      localStorage.setItem('tp_results', JSON.stringify(all));
    } catch {}

    /* Kanalga yuborish */
    if (uid) {
      POST('/api/result/save', {
        userId:          uid,
        testId:          data.testId || data.test_id || '',
        userName:        name,
        userUsername:    u.username || '',
        score:           data.correct || 0,
        total:           data.total || 0,
        percentage:      data.percentage || data.score || 0,
        passing_score:   data.passing_score || data.passScore || 60,
        detailed_results: data.detailed_results || data.userAnswers || [],
        completedAt:     result.completedAt,
      }).catch(() => {});
    }
    return result.id;
  },

  async getMyResults(userId, limit = 100) {
    const all  = JSON.parse(localStorage.getItem('tp_results') || '[]');
    let mine;
    if (userId) {
      mine = all.filter(r => {
        const rid = String(r.userId || r.user_id || '');
        return rid === String(userId) || rid === '';  // uid yo'q eskilar ham
      });
    } else {
      mine = all;
    }
    return limit ? mine.slice(0, limit) : mine;
  },

  /* ── ADMIN ── */
  async adminGetTests() {
    try { return await GET('/api/admin/tests'); } catch { return []; }
  },
  async adminGetStats() {
    try { return await GET('/api/admin/stats'); } catch { return {}; }
  },
  async adminTogglePause(id) {
    return POST('/api/admin/test/' + id + '/pause', {});
  },
  async adminDeleteTest(id) {
    Cache.clearTest(id);
    return POST('/api/admin/test/' + id + '/delete', {});
  },
};

/* ── Global export ── */
Object.assign(window, {
  DB, Cache, TGAuth, AuthHelpers, auth,
  SUBJECTS, getSubject, getIco, normalizeQ,
  esc, fmtDate, fmtTime, randCode, goTo,
  BOT_USERNAME, API_URL
});
