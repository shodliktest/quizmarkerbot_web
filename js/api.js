/* ================================================================
   TestPro — api.js  v3.0
   Firebase o'chirildi → Telegram Login + Streamlit API
   ================================================================

   SOZLASH (ikki joy):
   1. BOT_USERNAME  → sizning bot @username
   2. API_URL       → Streamlit app URL (deploy qilgandan keyin)
   ================================================================ */

const BOT_USERNAME = window.TESTPRO_BOT  || 'Quizmarkerbot';   // ← o'zgartiring
const API_URL      = (window.TESTPRO_API || 'https://webapiquizmarkerbot.streamlit.app').replace(/\/$/, '');

/* ── Navigation ── */
const BASE_PATH = (() => {
  const p = window.location.pathname;
  return p.substring(0, p.lastIndexOf('/') + 1);
})();
function goTo(page) { window.location.href = BASE_PATH + page; }

/* ── Subject map ── */
const SUBJECTS = {
  english:  { label: 'English',    emoji: '🇬🇧' },
  arabic:   { label: 'Arabcha',    emoji: '🕌'  },
  russian:  { label: 'Ruscha',     emoji: '🇷🇺' },
  turkish:  { label: 'Turkcha',    emoji: '🇹🇷' },
  math:     { label: 'Matematika', emoji: '🧮'  },
  it:       { label: 'IT / CS',    emoji: '💻'  },
  science:  { label: 'Fanlar',     emoji: '🔬'  },
  religion: { label: 'Din',        emoji: '📖'  },
  other:    { label: 'Boshqa',     emoji: '📚'  },
};
function getSubject(k) { return SUBJECTS[k] || { label: k || 'Boshqa', emoji: '📚' }; }

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
    return new Date(ms).toLocaleDateString('uz-UZ', { day:'numeric', month:'short', year:'numeric' });
  } catch { return '—'; }
}
function fmtTime(secs) {
  secs = secs || 0;
  return String(Math.floor(secs/60)).padStart(2,'0') + ':' + String(secs%60).padStart(2,'0');
}
function randCode(n=6) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:n}, () => c[Math.floor(Math.random()*c.length)]).join('');
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
  clear() { localStorage.removeItem(this._k); },

  /* Telegram Login Widget bu funkisyani chaqiradi */
  onLogin(user) {
    TGAuth.save(user);
    const next = new URLSearchParams(location.search).get('next') || 'dashboard.html';
    goTo(next);
  }
};

/* ── AuthHelpers — Firebase bilan mos interfeys ── */
const AuthHelpers = {
  getCurrentUser()  { return Promise.resolve(TGAuth.get()); },
  async requireAuth(fallback = 'login.html') {
    const u = TGAuth.get();
    if (!u) { goTo(fallback + '?next=' + encodeURIComponent(location.href)); return null; }
    return u;
  }
};

/* ── auth stub — eski kod auth.signOut() ishlatadi ── */
const auth = {
  signOut() { TGAuth.clear(); goTo('index.html'); return Promise.resolve(); },
  currentUser: null
};

/* ════════════════════════════════════════════
   LOCAL CACHE (testlar uchun)
   ════════════════════════════════════════════ */
const Cache = {
  _key(id)    { return 'tp_test_' + id; },
  _ansKey(id) { return 'tp_answers_' + id; },

  saveTest(id, testData, questions) {
    try { localStorage.setItem(this._key(id), JSON.stringify({ testData, questions, savedAt: Date.now() })); }
    catch(e) { console.warn('Cache:', e); }
  },
  loadTest(id) {
    try {
      const d = JSON.parse(localStorage.getItem(this._key(id)));
      if (!d) return null;
      if (Date.now() - d.savedAt > 86400_000) { this.clearTest(id); return null; }
      return d;
    } catch { return null; }
  },
  clearTest(id) {
    localStorage.removeItem(this._key(id));
    localStorage.removeItem(this._ansKey(id));
  },
  saveAnswers(id, a) {
    try { localStorage.setItem(this._ansKey(id), JSON.stringify(a)); } catch {}
  },
  loadAnswers(id) {
    try { return JSON.parse(localStorage.getItem(this._ansKey(id))); } catch { return null; }
  }
};

/* ════════════════════════════════════════════
   HTTP — Streamlit API ga so'rovlar
   ════════════════════════════════════════════ */
async function _req(method, path, body) {
  const u = TGAuth.get();
  const headers = { 'Content-Type': 'application/json' };
  if (u) { headers['X-TG-ID'] = String(u.id); }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(API_URL + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const GET  = p     => _req('GET',  p);
const POST = (p,b) => _req('POST', p, b);

/* ════════════════════════════════════════════
   DB — Firebase DB interfeysi bilan to'liq mos
   ════════════════════════════════════════════ */
const DB = {

  /* ── USER ── */
  async getUser(uid) {
    try { return await GET('/api/user/' + uid); } catch { return null; }
  },
  async createUser(uid, data) {
    const u = TGAuth.get() || {};
    return POST('/api/user/create', {
      uid: uid || String(u.id),
      name: data.name || [u.first_name, u.last_name].filter(Boolean).join(' '),
      username: u.username || '',
      photo_url: u.photo_url || '',
      role: 'user', ...data
    });
  },
  async updateUser(uid, data) {
    return POST('/api/user/' + uid + '/update', data).catch(() => {});
  },
  async getAllUsers() {
    try { return await GET('/api/users'); } catch { return []; }
  },

  /* ── TESTS ── */
  async getTest(id) {
    try { return await GET('/api/test/' + id); } catch { return null; }
  },
  async getMyTests(authorId) {
    try { return await GET('/api/tests/my?uid=' + authorId); } catch { return []; }
  },
  async getPublicTests() {
    try { return await GET('/api/tests/public'); } catch { return []; }
  },
  async getAllTests() {
    try { return await GET('/api/tests'); } catch { return []; }
  },
  async getTestByCode(code) {
    try { return await GET('/api/test/code/' + encodeURIComponent(code.toUpperCase().trim())); }
    catch { return null; }
  },
  async createTest(data, authorId) {
    const code = data.accessCode || randCode(6);
    return POST('/api/test/create', { ...data, accessCode: code, authorId });
  },
  async updateTest(id, data) {
    return POST('/api/test/' + id + '/update', data);
  },
  async deleteTest(id) {
    Cache.clearTest(id);
    return POST('/api/test/' + id + '/delete', {});
  },

  /* ── QUESTIONS ── */
  async getQuestions(testId) {
    const c = Cache.loadTest(testId);
    if (c?.questions) return c.questions;
    try { return await GET('/api/test/' + testId + '/questions') || []; }
    catch { return []; }
  },
  async getTestWithQuestions(testId) {
    const c = Cache.loadTest(testId);
    if (c?.questions) return { testData: c.testData, questions: c.questions };
    try {
      const d = await GET('/api/test/' + testId + '/full');
      if (d?.testData) Cache.saveTest(testId, d.testData, d.questions || []);
      return d || { testData: null, questions: [] };
    } catch { return { testData: null, questions: [] }; }
  },
  async saveQuestions(testId, questions) {
    const clean = questions.map((q, i) => ({
      ...q, order: i,
      text:         q.text        || '',
      type:         q.type        || 'multiple',
      options:      q.options     || [],
      correct:      q.correct     ?? 0,
      correctOrder: q.correctOrder|| [],
      blanks:       q.blanks      || [],
      explanation:  q.explanation || '',
      points:       q.points      || 1,
    }));
    const res = await POST('/api/test/' + testId + '/questions', { questions: clean });
    const c = Cache.loadTest(testId);
    if (c) Cache.saveTest(testId, c.testData, clean);
    return res;
  },

  /* ── RESULTS ── */
  async saveResult(data) {
    const result = { ...data, id: 'r_' + Date.now(), completedAt: Date.now() };
    /* localStorage backup */
    try {
      const all = JSON.parse(localStorage.getItem('tp_results') || '[]');
      all.unshift(result);
      if (all.length > 100) all.splice(100);
      localStorage.setItem('tp_results', JSON.stringify(all));
    } catch {}
    /* API ga ham yuborish */
    const u = TGAuth.get();
    if (u) {
      POST('/api/result/save', {
        ...data,
        userId:       String(u.id),
        userName:     [u.first_name, u.last_name].filter(Boolean).join(' '),
        userUsername: u.username || ''
      }).catch(() => {});
    }
    return result.id;
  },

  async getMyResults(userId, limit = 20) {
    try {
      const res = await GET('/api/results/' + userId + '?limit=' + (limit || 20));
      return Array.isArray(res) ? res : [];
    } catch {
      const all = JSON.parse(localStorage.getItem('tp_results') || '[]');
      const mine = all.filter(r => String(r.userId) === String(userId));
      return limit ? mine.slice(0, limit) : mine;
    }
  }
};

/* ── Global export ── */
Object.assign(window, {
  DB, Cache, TGAuth, AuthHelpers, auth,
  SUBJECTS, getSubject, esc, fmtDate, fmtTime, randCode, goTo,
  BOT_USERNAME, API_URL
});
