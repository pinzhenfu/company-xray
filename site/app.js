/* 公司健檢照妖鏡｜Company X-Ray 前端
 * 資料流程：GitHub Actions 每日產生 data/index.json 與 data/s/{代號}.json → 網頁讀取
 * 所有統計、圖表、技術指標與投資評分都在瀏覽器計算，因此即時與備援模式畫面完全一致。
 */
'use strict';

// ------------------------------------------------------------------ 設定
// GitHub 版：沒有後端。GitHub Actions 每天把資料寫進 data/index.json 與 data/s/{代號}.json，網頁直接讀取。
const params = new URLSearchParams(location.search);
const SENT = {
  pos: { name: '正面', color: '#2a78d6' },
  neu: { name: '中性', color: '#b9b8b2' },
  neg: { name: '負面', color: '#eb6834' },
};
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];   // 多股比較：顏色跟著股票走，不跟排名
const MAX_STOCKS = 4;
const CMP_PRESETS = [
  ['晶圓代工', ['2330', '2303', '5347']], ['IC 設計', ['2454', '3034', '2379']], ['AI 伺服器', ['2382', '3231', '6669']],
  ['航運三雄', ['2603', '2609', '2615']], ['金控', ['2881', '2882', '2891']], ['記憶體', ['2408', '2344', '2337']],
  ['市值型 ETF', ['0050', '006208']], ['高股息 ETF', ['0056', '00878', '00919']],
];
let INDEX = null, LOCAL_LIST = [];

const S = { mode: 'checking', days: 30, stocks: [], tab: null, charts: [], table: {}, kw: null };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (n, d = 1, sign = true) => (n == null || isNaN(n) ? '—' : (sign && n > 0 ? '+' : '') + n.toFixed(d) + '%');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const DAY = 86400000;
const dkey = (d) => { const t = new Date(d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const md = (k) => k.slice(5).replace('-', '/');

function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2800); }

async function getJSON(url, ms) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) { let msg = r.status; try { msg = (await r.json()).detail || msg; } catch (e) {} throw new Error(msg); }
    return await r.json();
  } finally { clearTimeout(timer); }
}

if (window.Chart) {
  Chart.defaults.font.family = 'Inter,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#5f6878';
  Chart.defaults.borderColor = '#eef1f6';
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.plugins.tooltip.backgroundColor = '#14213d';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.boxPadding = 4;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation.duration = 300;
}

// ------------------------------------------------------------------ 啟動
async function init() {
  bindUI();
  await XLive.loadMedia();
  try { INDEX = await getJSON('data/index.json?t=' + Date.now(), 10000); } catch (e) { INDEX = null; }
  let all = [];
  try { all = await getJSON('data/all_stocks.json', 15000); } catch (e) {}
  const tracked = new Map(((INDEX && INDEX.stocks) || []).map((s) => [s.code, s]));
  const list = all.map((s) => ({ code: s.c, name: s.n, market: s.m === 'O' ? 'TPEx' : 'TWSE', etf: s.t === 'E' || /^00/.test(s.c), industry: s.i || '' }));
  tracked.forEach((s) => { if (!list.some((x) => x.code === s.code)) list.push({ code: s.code, name: s.name, market: s.market, etf: s.type === 'ETF', industry: s.industry }); });
  list.forEach((s) => { const t = tracked.get(s.code); if (t) Object.assign(s, { tracked: true, price: t.price, articles: t.articles, industry: t.industry || s.industry }); });
  LOCAL_LIST = list.sort((a, b) => (b.tracked ? 1 : 0) - (a.tracked ? 1 : 0) || a.code.localeCompare(b.code));
  S.mode = tracked.size ? 'daily' : 'live-only';
  renderPills(); renderBanner();
  if (params.get('s')) { for (const q of params.get('s').split(',').slice(0, MAX_STOCKS)) await addStock(q, true); }
  else if (tracked.size) { S.tab = 'market'; render(); }
  else await addStock('2330', true);
}

const fmtTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function renderPills() {
  const mp = $('modePill'), ml = $('modelPill');
  if (S.mode === 'daily') { mp.textContent = `● 每日更新 · ${fmtTime(INDEX.updatedAt)}`; mp.className = 'pill live'; }
  else { mp.textContent = '● 僅即時抓取'; mp.className = 'pill fallback'; }
  ml.textContent = INDEX && INDEX.model ? '追蹤股模型：' + (INDEX.model.startsWith('FinBERT') ? 'FinBERT ✓' : '字典法') : '情緒模型：字典法';
}

function renderBanner() {
  const nTracked = LOCAL_LIST.filter((s) => s.tracked).length;
  if (S.mode !== 'daily') { $('banner').innerHTML = `<div class="banner warn">每日資料尚未產生（請確認 GitHub Actions 已執行完成），目前所有股票都用即時抓取＋字典法。</div>`; return; }
  const hours = (Date.now() - new Date(INDEX.updatedAt).getTime()) / 3600000;
  $('banner').innerHTML = hours > 36
    ? `<div class="banner warn"><b>追蹤清單資料已超過 ${Math.floor(hours / 24)} 天沒更新</b>（最後更新 ${fmtTime(INDEX.updatedAt)}）。請到 GitHub 的 Actions 分頁查看自動更新是否失敗。</div>`
    : `<div class="banner info">可查詢全部 ${fmt(LOCAL_LIST.filter((s) => !s.etf).length)} 檔股票＋${fmt(LOCAL_LIST.filter((s) => s.etf).length)} 檔 ETF。<b>★ 追蹤 ${nTracked} 檔</b>（成交值前 100 大個股＋前 10 大 ETF＋自選）：每天自動更新、FinBERT 分析、秒開（最後更新 ${fmtTime(INDEX.updatedAt)}）。<b>其他股票</b>：查詢時即時抓取新聞（通常 10～30 秒），使用金融字典法；查過的股票 12 小時內再查會秒開。</div>`;
}

// ------------------------------------------------------------------ 搜尋與股票清單
let sugIdx = -1, sugItems = [];
function localMatch(q) {
  q = q.trim(); if (!q) return LOCAL_LIST.filter((s) => s.tracked);
  const up = q.toUpperCase();
  const a = LOCAL_LIST.filter((s) => s.code.startsWith(up) || s.name.startsWith(q));
  const b = LOCAL_LIST.filter((s) => !a.includes(s) && s.name.includes(q));
  return a.concat(b).slice(0, 30);
}
function showSuggest(items, q) {
  sugItems = items; sugIdx = -1;
  const box = $('suggest');
  box.innerHTML = (q ? '' : '<div style="padding:8px 13px 4px;font-size:12px;color:var(--faint)">★ 追蹤清單（秒開）。輸入代號或名稱可搜尋全部股票與 ETF</div>')
    + items.map((s, i) => `<button data-i="${i}"><b>${esc(s.code)}</b>${esc(s.name)}<small>${s.etf ? 'ETF · ' : s.industry ? esc(s.industry) + ' · ' : ''}${s.tracked ? `★ 每日 FinBERT${s.price != null ? ' · ' + fmt(s.price, 2) : ''}` : `即時抓取 · ${s.market === 'TPEx' ? '上櫃' : '上市'}`}</small></button>`).join('')
    || (q ? `<div style="padding:10px 13px;font-size:13px;color:var(--muted)">找不到「${esc(q)}」。${/^\d{4,6}[A-Z]?$/i.test(q) ? '按 Enter 仍可嘗試以此代號即時抓取。' : '請確認名稱或改輸入股票代號。'}</div>` : '');
  box.classList.toggle('show', !!box.innerHTML);
}
function bindUI() {
  const inp = $('searchInput');
  inp.placeholder = '輸入任一台股代號或名稱，例如 2330、長榮、6488';
  inp.addEventListener('focus', () => showSuggest(localMatch(inp.value), inp.value.trim()));
  inp.addEventListener('input', () => showSuggest(localMatch(inp.value), inp.value.trim()));
  inp.addEventListener('keydown', (e) => {
    const box = $('suggest'), btns = [...box.querySelectorAll('button')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!sugItems.length) return; e.preventDefault();
      sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length;
      btns.forEach((b, i) => b.classList.toggle('hl', i === sugIdx));
      btns[sugIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = sugIdx >= 0 ? sugItems[sugIdx] : null;
      submit(pick ? pick.code : inp.value);
    } else if (e.key === 'Escape') box.classList.remove('show');
  });
  $('suggest').addEventListener('mousedown', (e) => { const b = e.target.closest('button'); if (b) { e.preventDefault(); submit(sugItems[+b.dataset.i].code); } });
  inp.addEventListener('blur', () => setTimeout(() => $('suggest').classList.remove('show'), 150));
  $('addBtn').onclick = () => submit(inp.value);
  $('cmpBtn').onclick = () => {
    const ok = S.stocks.filter((s) => s.status === 'ok').length;
    const p = $('cmpPanel'); p.classList.toggle('show');
    p.innerHTML = `<div class="cmp-head"><b>⇄ 多股比較</b>：一鍵比較同業，或在上方搜尋框加入 2～4 檔後按「比較目前的股票」。${S.stocks.length >= 2 ? ` <button class="primary sm" id="cmpNow">比較目前的 ${S.stocks.length} 檔</button>` : ''}</div>
      <div class="cmp-presets">${CMP_PRESETS.map((g, i) => `<button data-i="${i}"><b>${g[0]}</b><span>${g[1].map((c) => (LOCAL_LIST.find((s) => s.code === c) || { name: c }).name).join('、')}</span></button>`).join('')}</div>
      <p class="hint-line">比較內容：股價相對表現、每日聲量、情緒組成、各面向評分雷達圖、淨情緒走勢、綜合評分排名與配置建議。★ 追蹤股票秒開；其他股票需即時抓取（通常 10～30 秒）。</p>`;
    if ($('cmpNow')) $('cmpNow').onclick = () => { p.classList.remove('show'); S.wantCompare = true; if (ok >= 2) { S.tab = 'compare'; render(); } };
    p.querySelectorAll('.cmp-presets button').forEach((b) => (b.onclick = async () => {
      p.classList.remove('show');
      S.stocks = []; S.wantCompare = true; S.tab = null;
      for (const c of CMP_PRESETS[+b.dataset.i][1]) addStock(c, true);
    }));
  };
  $('rangeGroup').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#rangeGroup button').forEach((x) => x.classList.toggle('active', x === b));
    S.days = +b.dataset.days;
    render();
  });
}
function submit(q) {
  q = (q || '').trim(); if (!q) return toast('請輸入股票代號或公司名稱');
  $('searchInput').value = ''; $('suggest').classList.remove('show'); $('searchInput').blur();
  addStock(q);
}

async function addStock(q, silent) {
  let local = LOCAL_LIST.find((s) => s.code === q.toUpperCase() || s.name === q) || (q.trim() ? localMatch(q)[0] : null);
  if (!local && /^\d{4,6}[A-Z]?$/i.test(q)) local = { code: q.toUpperCase(), name: q.toUpperCase(), market: 'TWSE' };
  if (!local) { if (!silent) toast(`找不到「${q}」，請改輸入股票代號`); return; }
  if (S.stocks.some((s) => s.code === local.code)) { S.tab = local.code; render(); return; }
  if (S.stocks.length >= MAX_STOCKS) return toast(`最多比較 ${MAX_STOCKS} 檔，請先移除一檔`);
  const used = new Set(S.stocks.map((s) => s.color));
  const st = { code: local.code, name: local.name, market: local.market, etf: !!local.etf, industry: local.industry || '', tracked: !!local.tracked, query: local.code, color: SERIES.find((c) => !used.has(c)), status: 'loading', data: null, error: null, progress: '' };
  S.stocks.push(st); S.tab = st.code;
  render();
  await load(st);
}

function removeStock(code) {
  S.stocks = S.stocks.filter((s) => s.code !== code);
  if (S.tab === code || (S.tab === 'compare' && S.stocks.length < 2)) S.tab = S.stocks[0] ? S.stocks[0].code : INDEX ? 'market' : null;
  render();
}

const LIVE_CACHE = {};
async function load(st) {
  st.status = 'loading'; st.progress = ''; renderChips();
  if (S.tab === st.code) render();
  try {
    if (st.tracked) {
      st.data = await getJSON(`data/s/${encodeURIComponent(st.code)}.json?t=${encodeURIComponent(INDEX.updatedAt)}`, 20000);
      st.source = 'daily';
    } else {
      const hit = LIVE_CACHE[st.code];
      st.data = hit && Date.now() - hit.t < 15 * 60000 ? hit.d : await XLive.collect(st, (msg) => { st.progress = msg; const el = $('loadMsg'); if (el && S.tab === st.code) el.textContent = msg; });
      LIVE_CACHE[st.code] = { t: Date.now(), d: st.data };
      st.source = 'live';
    }
    st.name = st.data.name; st.status = 'ok';
  } catch (e) { st.status = 'error'; st.error = e.message; }
  render();
  if (S.wantCompare && S.stocks.filter((s) => s.status === 'ok').length >= Math.min(2, S.stocks.length) && !S.stocks.some((s) => s.status === 'loading')) { S.wantCompare = false; if (S.stocks.length >= 2) { S.tab = 'compare'; render(); } }
  if (st.status === 'ok' && st.source === 'live' && st.data.articles.some((a) => a.evidencePending)) {
    XLive.fetchEvidence(st.data, () => { if (S.tab === st.code) refreshTop(st); }).then(() => { if (S.tab === st.code) refreshTop(st); });
  }
}

// ------------------------------------------------------------------ 分析核心
function refDate(d) { return new Date(d.fetchedAt); }
const GROUP_ORDER = ['財經媒體', '綜合媒體', '電視新聞', '科技媒體', '論壇'];
function normalize(arts) {
  // 舊版資料沒有媒體分類：套用知名媒體白名單，不在名單上的來源不列入
  return arts.filter((a) => {
    if (GROUP_ORDER.includes(a.channel)) return true;
    const m = XLive.canon(a.source, a.url || ''); if (!m) return false;
    a.source = m[0]; a.channel = m[1]; return true;
  });
}

function analyze(d, days) {
  const ref = refDate(d), end = ref.getTime(), start = end - days * DAY, pstart = start - days * DAY;
  const arts = normalize(d.articles).map((a) => ({ ...a, t: new Date(a.date).getTime() }));
  const cur = arts.filter((a) => a.t > start && a.t <= end + DAY);
  const prev = arts.filter((a) => a.t > pstart && a.t <= start);
  const cnt = (list) => { const c = { pos: 0, neu: 0, neg: 0 }; list.forEach((a) => c[a.sentiment]++); return c; };
  const c = cnt(cur), pc = cnt(prev), total = cur.length;
  const net = total ? ((c.pos - c.neg) / total) * 100 : 0;
  const pnet = prev.length ? ((pc.pos - pc.neg) / prev.length) * 100 : null;
  const favor = c.neg ? c.pos / c.neg : c.pos ? c.pos : null;

  // 每日聲量
  const dates = [];
  for (let t = start + DAY; t <= end + 1; t += DAY) dates.push(dkey(t));
  const daily = Object.fromEntries(dates.map((k) => [k, { pos: 0, neu: 0, neg: 0 }]));
  cur.forEach((a) => { const k = dkey(a.t); if (daily[k]) daily[k][a.sentiment]++; });

  // 來源
  const bySrc = {}, byCh = {};
  cur.forEach((a) => {
    (bySrc[a.source] = bySrc[a.source] || { pos: 0, neu: 0, neg: 0, n: 0 })[a.sentiment]++; bySrc[a.source].n++;
    (byCh[a.channel] = byCh[a.channel] || { pos: 0, neu: 0, neg: 0, n: 0 })[a.sentiment]++; byCh[a.channel].n++;
  });
  const sources = Object.entries(bySrc).sort((a, b) => b[1].n - a[1].n);
  const channels = Object.entries(byCh).sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]));

  // 關鍵字
  const kw = {};
  cur.forEach((a) => (a.keywords || []).forEach((w) => { (kw[w] = kw[w] || { n: 0, pos: 0, neu: 0, neg: 0 }).n++; kw[w][a.sentiment]++; }));
  const words = Object.entries(kw).filter(([, v]) => v.n >= 2 || total < 15).sort((a, b) => b[1].n - a[1].n).slice(0, 40);
  const hot = (s) => Object.entries(kw).filter(([, v]) => v[s] >= 1).sort((a, b) => b[1][s] - a[1][s] || b[1].n - a[1].n).slice(0, 10);

  // 熱門文章：有瀏覽量就依瀏覽量，否則依最新
  const top = (s) => {
    const g = cur.filter((a) => a.sentiment === s);
    const hasViews = g.some((a) => a.views != null);
    g.sort(hasViews ? (a, b) => (b.views ?? -1) - (a.views ?? -1) || b.t - a.t : (a, b) => b.t - a.t);
    return { list: g.slice(0, 5), basis: (hasViews ? '依瀏覽量排序' : '來源未提供瀏覽量，依發布時間排序（最新五篇）') + '。判斷依據為內文逐句分析後最具代表性的句子。' };
  };

  const tech = technicals(d.prices);
  const corr = correlation(daily, d.prices);
  const recent7 = arts.filter((a) => a.t > end - 7 * DAY && a.t <= end + DAY);
  const r7 = cnt(recent7);
  const net7 = recent7.length ? ((r7.pos - r7.neg) / recent7.length) * 100 : null;
  const res = { d, ref, days, cur, prev, c, pc, total, net, pnet, favor, dates, daily, sources, channels, words, hotPos: hot('pos'), hotNeg: hot('neg'), topPos: top('pos'), topNeg: top('neg'), tech, corr, net7 };
  res.esg = esgAnalyze(cur);
  res.score = scoreIt(res);
  return res;
}

function technicals(p) {
  if (!p || p.length < 2) return null;
  const c = p.map((x) => x.c), v = p.map((x) => x.v), n = c.length, last = c[n - 1];
  const ma = (k) => (n >= k ? c.slice(-k).reduce((a, b) => a + b, 0) / k : null);
  const ret = (k) => (n > k ? (last / c[n - 1 - k] - 1) * 100 : null);
  let g = 0, l = 0;
  if (n > 15) {
    for (let i = 1; i <= 14; i++) { const ch = c[i] - c[i - 1]; ch > 0 ? (g += ch) : (l -= ch); }
    g /= 14; l /= 14;
    for (let i = 15; i < n; i++) { const ch = c[i] - c[i - 1]; g = (g * 13 + Math.max(ch, 0)) / 14; l = (l * 13 + Math.max(-ch, 0)) / 14; }
  }
  const rsi = n > 15 ? (l === 0 ? 100 : 100 - 100 / (1 + g / l)) : null;
  const lr = []; for (let i = Math.max(1, n - 20); i < n; i++) lr.push(Math.log(c[i] / c[i - 1]));
  const mean = lr.reduce((a, b) => a + b, 0) / (lr.length || 1);
  const vol = lr.length > 2 ? Math.sqrt(lr.reduce((a, b) => a + (b - mean) ** 2, 0) / (lr.length - 1)) * Math.sqrt(252) * 100 : null;
  const yr = c.slice(-250), hi = Math.max(...yr), lo = Math.min(...yr);
  const av = (k) => v.slice(-k).reduce((a, b) => a + b, 0) / Math.min(k, n);
  return { last, ma5: ma(5), ma20: ma(20), ma60: ma(60), rsi, ret5: ret(5), ret20: ret(20), ret60: ret(60), vol, hi, lo, fromHi: (last / hi - 1) * 100, volRatio: av(20) ? av(5) / av(20) : null, lastDate: p[n - 1].d };
}

// 每日淨情緒 vs 下一個交易日報酬（呼應論文：文字對股價的資訊含量）
function correlation(daily, prices) {
  if (!prices || prices.length < 3) return null;
  const idx = prices.map((p) => p.d), xs = [], ys = [];
  for (const [k, v] of Object.entries(daily)) {
    const n = v.pos + v.neu + v.neg; if (!n) continue;
    const j = idx.findIndex((d) => d > k); if (j < 1) continue;
    xs.push((v.pos - v.neg) / n); ys.push(prices[j].c / prices[j - 1].c - 1);
  }
  if (xs.length < 8) return { n: xs.length, r: null };
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let sxy = 0, sx = 0, sy = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sx += (x - mx) ** 2; sy += (ys[i] - my) ** 2; });
  return { n: xs.length, r: sx && sy ? sxy / Math.sqrt(sx * sy) : null };
}

// 綜合評分：六個面向加權（0～100）
function scoreIt(a) {
  const t = a.tech, v = a.d.valuation || {};
  const F = [];
  const add = (key, name, w, s, val, note) => F.push({ key, name, w, s: s == null ? null : clamp(Math.round(s), 0, 100), val, note });
  add('sent', '新聞情緒', 30, a.total ? 50 + a.net * 0.8 : null,
    a.total ? `淨情緒 ${a.net > 0 ? '+' : ''}${a.net.toFixed(0)}` : '無文章',
    a.total ? `${a.total} 篇中正面 ${a.c.pos}、負面 ${a.c.neg}` : '期間內沒有相關文章');
  const dn = a.net7 != null && a.total ? a.net7 - a.net : a.pnet != null ? a.net - a.pnet : null;
  add('mom', '情緒動能', 10, dn == null ? null : 50 + dn, dn == null ? '—' : `${dn > 0 ? '+' : ''}${dn.toFixed(0)}`,
    dn == null ? '資料不足' : dn > 8 ? '近期情緒轉好' : dn < -8 ? '近期情緒轉差' : '情緒變化不大');
  if (t) {
    let tr = 50;
    if (t.ma20) tr += t.last > t.ma20 ? 12 : -12;
    if (t.ma20 && t.ma60) tr += t.ma20 > t.ma60 ? 12 : -12;
    if (t.ret20 != null) tr += clamp(t.ret20 * 1.5, -20, 20);
    add('trend', '價格趨勢', 25, tr, t.ret20 != null ? `20日 ${pct(t.ret20)}` : '—',
      t.ma60 ? `${t.last > t.ma20 ? '站上' : '跌破'}月線，${t.ma20 > t.ma60 ? '月線在季線之上（多頭排列）' : '月線在季線之下（空頭排列）'}` : '價格資料不足');
    const rs = t.rsi == null ? null : t.rsi > 75 ? 30 : t.rsi > 65 ? 45 : t.rsi < 25 ? 55 : t.rsi < 35 ? 60 : 65;
    add('rsi', '動能／過熱', 10, rs, t.rsi == null ? '—' : `RSI ${t.rsi.toFixed(0)}`,
      t.rsi == null ? '—' : t.rsi > 70 ? '短線過熱，追高風險高' : t.rsi < 30 ? '短線超賣，留意反彈或續弱' : '動能中性');
    add('risk', '波動風險', 10, t.vol == null ? null : 100 - t.vol * 1.6, t.vol == null ? '—' : `年化波動 ${t.vol.toFixed(0)}%`,
      t.vol == null ? '—' : t.vol > 45 ? '波動很大，部位宜小' : t.vol > 28 ? '波動中等' : '波動相對平穩');
  } else ['trend', 'rsi', 'risk'].forEach((k, i) => add(k, ['價格趨勢', '動能／過熱', '波動風險'][i], [25, 10, 10][i], null, '—', '無股價資料'));
  const pe = v.pe, vs = pe == null || pe <= 0 ? null : pe < 12 ? 72 : pe < 18 ? 62 : pe < 25 ? 50 : pe < 35 ? 40 : 30;
  add('val', '估值', 15, vs == null ? null : vs + (v.yield > 4 ? 6 : 0), pe ? `本益比 ${pe.toFixed(1)}` : '—',
    pe ? `${pe < 15 ? '本益比偏低' : pe < 25 ? '本益比合理區間' : '本益比偏高，需高成長支撐'}${v.yield ? `；殖利率 ${v.yield.toFixed(2)}%` : ''}` : '無估值資料（ETF 或資料源未提供）');
  const used = F.filter((f) => f.s != null), wsum = used.reduce((x, f) => x + f.w, 0);
  const total = wsum >= 40 ? Math.round(used.reduce((x, f) => x + f.s * f.w, 0) / wsum) : null;
  if (total == null) return { total: null, rating: '資料不足', tone: 'neu', factors: F };
  const rating = total >= 65 ? ['偏多', 'pos'] : total >= 55 ? ['中性偏多', 'pos'] : total >= 45 ? ['中性', 'neu'] : total >= 35 ? ['中性偏空', 'neg'] : ['偏空', 'neg'];
  return { total, rating: rating[0], tone: rating[1], factors: F };
}

function adviceText(a) {
  const { score, tech: t, d } = a, name = d.name, out = [], risks = [];
  const s = score.total;
  if (a.total) out.push(`近 ${a.days} 天共 ${a.total} 篇相關文章，正面 ${a.c.pos} 篇（${pct((a.c.pos / a.total) * 100, 0, false)}）、負面 ${a.c.neg} 篇（${pct((a.c.neg / a.total) * 100, 0, false)}），整體${a.net > 15 ? '偏正面' : a.net < -15 ? '偏負面' : '多空交雜'}。`);
  if (a.pnet != null && a.prev.length >= 5) out.push(`與前 ${a.days} 天相比，聲量${a.total >= a.prev.length ? '增加' : '減少'} ${pct(Math.abs((a.total / a.prev.length - 1) * 100), 0, false)}，淨情緒${a.net >= a.pnet ? '上升' : '下降'} ${Math.abs(a.net - a.pnet).toFixed(0)} 點。`);
  if (t) {
    out.push(`股價 ${fmt(t.last, 2)} 元，${t.ma20 ? (t.last > t.ma20 ? '站上' : '低於') + `月線（${fmt(t.ma20, 1)}）` : ''}${t.ma60 ? '、' + (t.last > t.ma60 ? '站上' : '低於') + `季線（${fmt(t.ma60, 1)}）` : ''}，距一年高點 ${pct(t.fromHi)}。`);
    if (t.rsi > 70) risks.push(`RSI ${t.rsi.toFixed(0)} 偏高，短線漲多，避免追價。`);
    if (t.rsi < 30) risks.push(`RSI ${t.rsi.toFixed(0)} 偏低，可能超跌，也可能代表趨勢轉弱。`);
    if (t.vol > 40) risks.push(`年化波動 ${t.vol.toFixed(0)}%，單日大幅震盪機率高。`);
    if (a.net > 20 && t.ret20 < -3) risks.push('新聞偏正面但股價走弱——市場可能已提前反映，或正面消息不被買單，留意「情緒與價格背離」。');
    if (a.net < -20 && t.ret20 > 3) risks.push('新聞偏負面但股價上漲——可能利空出盡，也可能是短線反彈，宜觀察後續量能。');
  }
  if (a.c.neg && a.hotNeg.length) risks.push(`負面文章常出現：${a.hotNeg.slice(0, 4).map((x) => '「' + x[0] + '」').join('、')}，建議點開負面熱門文章確認。`);
  if (a.total < 10) risks.push('文章數量偏少，情緒統計的代表性有限。');
  let action;
  if (s == null) action = '<b>資料不足。</b>目前沒有足夠的文章或股價資料可以評分，請等下次自動更新或改看其他股票。';
  else if (s >= 65) action = `<b>綜合偏多。</b>長線投資人可考慮分批布局${t && t.ma20 ? `，回檔接近月線 ${fmt(t.ma20, 1)} 元附近較有安全邊際` : ''}；短線操作者${t && t.rsi > 70 ? '因指標過熱，宜等待拉回' : '可順勢但需設停損'}。`;
  else if (s >= 55) action = `<b>中性偏多。</b>基本面與情緒尚可，但訊號不夠強。已持有者可續抱；尚未持有者建議小量試單或等待更明確的突破訊號。`;
  else if (s >= 45) action = `<b>中性觀望。</b>多空訊號互相抵銷，建議持有者維持部位、未持有者先觀察，等待情緒或價格趨勢明朗。`;
  else if (s >= 35) action = `<b>中性偏空。</b>負面訊號較多，持有者可考慮降低部位或設定停損${t && t.ma60 ? `（參考季線 ${fmt(t.ma60, 1)} 元）` : ''}；尚未持有者不宜急著進場。`;
  else action = `<b>偏空。</b>情緒與價格訊號皆偏弱，建議避開或嚴設停損，等待負面消息消化、股價重新站回月線再評估。`;
  const stop = t ? t.last * 0.92 : null;
  return { out, risks, action, stop, name };
}

// ------------------------------------------------------------------ 畫面
function destroyCharts() { S.charts.forEach((c) => c.destroy()); S.charts = []; }
function chart(id, cfg) { const el = $(id); if (el && window.Chart) S.charts.push(new Chart(el, cfg)); }

function render() {
  renderChips(); renderTabs(); destroyCharts();
  const v = $('view');
  v.onclick = null;
  if (S.tab === 'market' && INDEX) return renderMarket(v);
  if (!S.stocks.length) { v.innerHTML = '<div class="empty">輸入一檔股票開始健檢。</div>'; return; }
  if (S.tab === 'compare') return renderCompare(v);
  const st = S.stocks.find((s) => s.code === S.tab) || S.stocks[0];
  S.tab = st.code;
  if (st.status === 'loading') {
    v.innerHTML = `<div class="panel loading-box"><div class="spinner"></div>${st.tracked ? `正在讀取「${esc(st.name)}」的資料…` : `「${esc(st.name)}」不在追蹤清單，正在即時抓取新聞（通常 10～30 秒）<br><b id="loadTimer" style="font-size:20px">已等待 0 秒</b><br><small id="loadMsg">${esc(st.progress || '準備中…')}</small><br><small style="color:var(--faint)">結果出來後，熱門文章的「判斷依據」句子會再陸續補上</small>`}</div>`;
    if (!st.tracked) { st.t0 = st.t0 || Date.now(); clearInterval(S.timer); S.timer = setInterval(() => { const el = $('loadTimer'); if (!el || st.status !== 'loading') return clearInterval(S.timer); el.textContent = `已等待 ${Math.round((Date.now() - st.t0) / 1000)} 秒`; }, 1000); }
    return;
  }
  if (st.status === 'error') {
    v.innerHTML = `<div class="panel box nodata"><h4>暫時抓不到「${esc(st.name)}」（${esc(st.code)}）的資料</h4>
      <p class="sub">${esc(st.error)}</p>
      <ul class="adv-list">
        <li><b>最常見原因：暫時連不上新聞與股價來源。</b>不在追蹤清單的股票，網站要透過免費的第三方連線服務即時抓取，這類服務偶爾會沒有回應。請稍後再按「重新抓取」。</li>
        <li>請確認代號是否正確（例如 2330、0050）。已下市或剛上市的股票可能沒有資料。</li>
        <li>想立即查看：首頁「📊 市場總覽」裡的 ★ 追蹤股票（成交值前 100 大＋前 10 大 ETF）資料已預先抓好，不受影響、可秒開。</li>
      </ul>
      <button class="primary" onclick="retry('${esc(st.code)}', true)">重新抓取</button></div>`;
    return;
  }
  renderStock(v, st);
}
window.retry = async (code, fresh) => {
  const s = S.stocks.find((x) => x.code === code); if (!s) return;
  if (fresh) { delete LIVE_CACHE[code]; XLive.clearCache(code); XLive.resetProxies(); }   // 手動重試：清掉快取，也讓所有連線服務重新嘗試
  const before = s.data ? s.data.articles.length : 0;
  s.t0 = null;
  await load(s);
  if (s.status === 'ok') {
    const nErr = (s.data.errors || []).length, after = s.data.articles.length;
    toast(nErr ? `已重新抓取：${after > before ? `多抓到 ${after - before} 篇，` : ''}仍有 ${nErr} 個來源沒有回應，請稍後再試` : `重新抓取成功，共 ${after} 篇文章`);
  } else toast('仍然連不上，請稍後再試');
};

function renderChips() {
  $('chips').innerHTML = S.stocks.map((s) => `<span class="chip ${s.status === 'loading' ? 'loading' : ''}"><i style="background:${s.color}"></i>${esc(s.name)} <small style="color:var(--muted)">${esc(s.code)}</small>${s.status === 'loading' ? ' …' : s.status === 'error' ? ' ⚠' : ''}<button aria-label="移除 ${esc(s.name)}" onclick="removeStock('${esc(s.code)}')">×</button></span>`).join('');
}
function renderTabs() {
  const ok = S.stocks.filter((s) => s.status === 'ok').length;
  $('tabs').innerHTML = (INDEX ? `<button class="${S.tab === 'market' ? 'active' : ''}" data-tab="market">📊 市場總覽</button>` : '') + S.stocks.map((s) => `<button class="${S.tab === s.code ? 'active' : ''}" data-tab="${esc(s.code)}">${esc(s.name)}</button>`).join('')
    + (S.stocks.length >= 2 ? `<button class="${S.tab === 'compare' ? 'active' : ''}" data-tab="compare" ${ok < 2 ? 'disabled title="至少需兩檔載入完成"' : ''}>⇄ 多股比較</button>` : '');
  $('tabs').onclick = (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { S.tab = b.dataset.tab; S.kw = null; render(); } };
}

function chgHTML(ch, p) {
  const cls = ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat', ar = ch > 0 ? '▲' : ch < 0 ? '▼' : '－';
  return `<span class="chg ${cls}">${ar} ${fmt(Math.abs(ch), 2)}（${pct(p, 2)}）</span>`;
}
function segBar(c, n) {
  return ['pos', 'neu', 'neg'].filter((k) => c[k]).map((k) => `<div class="fill" title="${SENT[k].name} ${c[k]}" style="width:${(c[k] / n) * 100}%;background:${SENT[k].color};border-radius:0"></div>`).join('');
}
function markHits(text, hits) {
  let h = esc(text);
  const words = [...(hits?.pos || []).map((w) => [w, 'p']), ...(hits?.neg || []).map((w) => [w, 'n'])].sort((x, y) => y[0].length - x[0].length);
  words.forEach(([w, c]) => { h = h.split(esc(w)).join(`\u0001${c}${esc(w)}\u0002`); });
  return h.replace(/\u0001p/g, '<em>').replace(/\u0001n/g, '<em class="n">').replace(/\u0002/g, '</em>');
}
function artHTML(a) {
  const sc = a.scores || {}, lab = a.sentiment;
  const confBar = `<div class="conf" title="正面 ${Math.round((sc.pos || 0) * 100)}% / 中性 ${Math.round((sc.neu || 0) * 100)}% / 負面 ${Math.round((sc.neg || 0) * 100)}%">${['pos', 'neu', 'neg'].map((k) => `<span style="width:${(sc[k] || 0) * 100}%;background:${SENT[k].color}"></span>`).join('')}</div>`;
  let why;
  if (a.evidencePending) {
    why = `<div class="evi"><div class="evi-h">⏳ 正在讀取內文、逐句找出判斷依據…</div><ol><li>「${markHits(a.title, a.hints)}」<span class="badge ${lab}">標題 ${SENT[lab].name}</span></li></ol></div>`;
  } else if (a.evidence && a.evidence.length) {
    why = `<div class="evi"><div class="evi-h">判斷依據：從內文 ${a.nSentences} 句中，最能代表「${SENT[lab].name}」的句子</div><ol>${a.evidence.map((e) => `<li>「${markHits(e.text, e.hits)}」<span class="badge ${e.label}">${SENT[e.label].name} ${Math.round(e.p * 100)}%</span></li>`).join('')}</ol>
      <div class="evi-f">整篇判定：${SENT[lab].name} ${Math.round((sc[lab] || 0) * 100)}%（標題 40%＋內文各句平均 60%）· ${a.model === 'finbert' ? 'FinBERT' : '字典法'}</div></div>`;
  } else {
    const reason = a.bodyTried ? '無法擷取此篇內文' : a.url.includes('news.google.com') ? '此來源僅提供標題' : '此篇未分析內文';
    why = `<div class="evi"><div class="evi-h">判斷依據（${reason}，依標題判斷）</div><ol><li>「${markHits(a.title, a.hints)}」<span class="badge ${lab}">${SENT[lab].name} ${Math.round((sc[lab] || 0) * 100)}%</span></li></ol></div>`;
  }
  return `<div class="art ${lab}">
    <a class="t" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)} ↗</a>
    <div class="m"><span><b>${esc(a.source)}</b></span><span>${esc(a.channel)}</span><span>${esc(a.date.slice(0, 10))}</span>${a.views != null ? `<span>瀏覽 ${fmt(a.views)}</span>` : ''}${a.push != null ? `<span>推文 ${a.push}</span>` : ''}</div>
    ${why}${confBar}</div>`;
}

// 資料完整度：舊新聞是一週一週補抓的，還沒補到的日期要標示出來，避免看起來像「那幾天沒新聞」
function coverageStart(d) {
  if (d.mode === 'live') return null;
  const bf = new Set(d.backfill || []), ref = refDate(d);
  let m = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - ((ref.getDay() + 6) % 7));
  let start = dkey(m);
  for (;;) { m = new Date(m.getTime() - 7 * DAY); const k = dkey(m); if (!bf.has(k)) break; start = k; }
  return start;
}
function dataNotes(st, d, a) {
  const notes = [], live = st.source === 'live';
  const NEWS = ['Google 新聞', 'Yahoo 股市', '鉅亨網', 'PTT'];
  const failed = (d.errors || []).map((e) => e.split('：')[0]);
  const failedNews = failed.filter((x) => NEWS.includes(x));
  const allNewsFailed = failedNews.length === NEWS.length;
  if (live && allNewsFailed) {
    notes.push(`<b>這次沒有連上新聞來源</b>（${failedNews.join('、')}），所以目前看不到「${esc(d.name)}」的新聞——<b>這不代表沒有相關新聞</b>。不在追蹤清單的股票，網站要透過免費的第三方連線服務即時抓新聞，這類服務偶爾會沒有回應。股價與技術分析不受影響（每天預先存好）。建議稍後再按「重新抓取」，或先看 ★ 追蹤清單內的股票（新聞每天預先抓好）。`);
  } else if (failedNews.length) {
    notes.push(live
      ? `以下來源這次沒有回應：<b>${failedNews.join('、')}</b>。其他來源的文章已正常顯示，但文章數可能比實際少。`
      : `以下來源在最近一次自動更新時沒有回應：<b>${failedNews.join('、')}</b>。已保留先前的資料，下次自動更新（每天約 08:17、18:17）會再試。`);
  }
  if (failed.includes('股價') && (!d.prices || !d.prices.length)) notes.push('<b>沒有股價資料</b>：可能是新上市、已下市、暫停交易，或 Yahoo Finance 暫時沒有提供這檔股票的資料，因此技術指標與部分評分無法計算。');
  else if (!d.prices || !d.prices.length) notes.push('<b>沒有股價資料</b>：可能是新上市、已下市或暫停交易，因此技術指標與部分評分無法計算。');
  if (!a.total && !allNewsFailed) notes.push(`近 ${a.days} 天內，24 家知名媒體與 PTT 股板都<b>沒有提到「${esc(d.name)}」</b>。冷門股、小型股或 ETF 常見這種情況，不代表網站故障。${a.days < 90 ? '可以改選「近 90 天」，' : ''}或參考下方的股價與技術面分析。`);
  else if (a.total && a.total < 5) notes.push(`文章只有 ${a.total} 篇，情緒統計的代表性有限，請搭配原文判斷。`);
  if (!notes.length) return '';
  return `<section class="panel box nodata" style="margin-bottom:12px"><h4>ℹ️ 資料說明 <small>為什麼有些資料沒有出現</small></h4><ul class="adv-list">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>${live && failedNews.length ? `<button class="secondary" id="retryBtn" onclick="retry('${esc(st.code)}', true)">重新抓取</button> <span class="meta-small" id="retryMsg"></span>` : ''}</section>`;
}

function renderStock(v, st) {
  const d = st.data, a = analyze(d, S.days), q = d.quote || {}, val = d.valuation || {}, t = a.tech, sc = a.score;
  const adv = adviceText(a);
  const pvol = a.prev.length ? (a.total / a.prev.length - 1) * 100 : null;
  const srcNote = st.source === 'live' ? `即時抓取 · ${fmtTime(d.fetchedAt)}` : `每日更新 · ${fmtTime(d.fetchedAt)}`;
  v.innerHTML = `
  <section class="panel stock-head">
    <div>
      <h3>${esc(d.name)}<small>${esc(d.code)} · ${d.market === 'TPEx' ? '上櫃' : '上市'}${st.etf ? ' · ETF' : st.industry ? ' · ' + esc(st.industry) : ''}</small></h3>
      <div class="price-line">${q.price != null ? `<span class="price">${fmt(q.price, 2)}</span>${chgHTML(q.change, q.changePct)}` : '<span class="meta-small">無股價資料</span>'}</div>
      <div class="meta-small">${q.source ? `股價來源：${esc(q.source)}${q.time ? ' · ' + esc(String(q.time).slice(0, 16).replace('T', ' ')) : ''}` : ''}　情緒模型：${esc(d.model)}　資料：${esc(srcNote)}</div>

    </div>
    <div style="display:flex;gap:18px;align-items:flex-end;flex-wrap:wrap">
      <div class="val-grid"><div><span>本益比</span><b>${fmt(val.pe, 1)}</b></div><div><span>殖利率</span><b>${val.yield != null ? fmt(val.yield, 2) + '%' : '—'}</b></div><div><span>股價淨值比</span><b>${fmt(val.pb, 2)}</b></div></div>
      <button class="secondary" id="exportBtn">匯出分析摘要</button>
    </div>
  </section>

  ${dataNotes(st, d, a)}

  <div class="cards">
    <div class="metric"><div class="label">總聲量</div><div class="value">${fmt(a.total)}</div><div class="hint">${pvol == null ? `近 ${a.days} 天文章數` : `較前期 ${pct(pvol, 0)}`}</div></div>
    <div class="metric"><div class="label">好感度（正／負）</div><div class="value">${a.favor == null ? '—' : a.favor.toFixed(2)}</div><div class="hint">${a.favor == null ? '無文章' : a.favor >= 1 ? '正面聲量多於負面' : '負面聲量多於正面'}</div></div>
    <div class="metric"><div class="label">正面佔比</div><div class="value" style="color:${SENT.pos.color}">${a.total ? pct((a.c.pos / a.total) * 100, 0, false) : '—'}</div><div class="hint">${a.c.pos} 篇</div></div>
    <div class="metric"><div class="label">負面佔比</div><div class="value" style="color:#c4521f">${a.total ? pct((a.c.neg / a.total) * 100, 0, false) : '—'}</div><div class="hint">${a.c.neg} 篇</div></div>
    <div class="metric"><div class="label">淨情緒指數</div><div class="value">${a.total ? (a.net > 0 ? '+' : '') + a.net.toFixed(0) : '—'}</div><div class="hint">−100 全負面 ～ +100 全正面</div></div>
    <div class="metric feature"><div class="label">綜合評分</div><div class="value">${sc.total ?? '—'}<small style="font-size:14px;font-weight:700"> / 100</small></div><div class="hint">${sc.rating}</div></div>
  </div>

  <div class="grid g21">
    <section class="panel box">
      <h4>聲量與情緒趨勢 <small>每日文章數，依情緒堆疊</small></h4>
      ${(() => { const cs = coverageStart(d); if (st.source === 'live') return '<p class="cov-note">即時抓取只能取得各來源「最新」約 100 篇文章，較早日期的文章數會偏少（不是那幾天沒有新聞）。★ 追蹤股票有完整的每日歷史。</p>'; if (cs && cs > a.dates[0]) return `<p class="cov-note">灰底區（${md(cs)} 以前）的舊新聞仍在補抓中，文章數偏少不代表沒有新聞；每次自動更新都會補齊更多。</p>`; return '<p class="sub" style="margin:2px 0 6px">每日文章來自 Google 新聞逐日歸檔；最近兩天另外加上 Yahoo 股市、鉅亨網、PTT 的即時來源，所以最新一兩天的篇數可能略多。</p>'; })()}
      <div class="legend">${['pos', 'neu', 'neg'].map((k) => `<span><i class="dot" style="background:${SENT[k].color}"></i>${SENT[k].name}</span>`).join('')}</div>
      <div class="chart md"><canvas id="cVolume"></canvas></div>
      <h4 style="margin-top:14px">同期間收盤價 <small>與上圖日期對齊；虛線為 20 日均線</small></h4>
      <div class="chart sm"><canvas id="cPrice"></canvas></div>
    </section>
    <section class="panel box">
      <h4>情緒佔比</h4>
      <div class="chart md" style="height:190px"><canvas id="cDonut"></canvas></div>
      <div class="legend" style="justify-content:center">${['pos', 'neu', 'neg'].map((k) => `<span><i class="dot" style="background:${SENT[k].color}"></i>${SENT[k].name} ${a.c[k]}（${a.total ? Math.round((a.c[k] / a.total) * 100) : 0}%）</span>`).join('')}</div>
      <h4 style="margin-top:12px">媒體類型</h4>
      ${a.channels.map(([k, c]) => `<div class="hbar"><span>${esc(k)}</span><div class="track">${segBar(c, Math.max(...a.channels.map((x) => x[1].n)))}</div><b>${c.n}</b></div>`).join('') || '<p class="sub">無資料</p>'}
    </section>
  </div>

  <div class="grid g12">
    <section class="panel box">
      <h4>熱門來源網站 <small>長度＝文章數，顏色＝情緒組成</small></h4>
      ${a.sources.slice(0, 9).map(([k, c]) => `<div class="hbar"><span title="${esc(k)}">${esc(k)}</span><div class="track">${segBar(c, a.sources[0][1].n)}</div><b>${c.n}</b></div>`).join('') || '<p class="sub">無資料</p>'}
    </section>
    <section class="panel box">
      <h4>熱門關鍵字文字雲 <small>字越大出現越多；藍＝多出現在正面文章、橘＝負面、灰＝中性。點字可篩選下方文章</small></h4>
      <div class="cloud" id="cloud">${cloudHTML(a.words)}</div>
      <div class="grid g2" style="margin:10px 0 0">
        <div><div class="sub" style="margin-bottom:6px"><i class="dot" style="background:${SENT.pos.color}"></i>正面熱詞</div><div class="word-list">${a.hotPos.map(([w, x]) => `<span>${esc(w)}<b>${x.pos}</b></span>`).join('') || '<span>—</span>'}</div></div>
        <div><div class="sub" style="margin-bottom:6px"><i class="dot" style="background:${SENT.neg.color}"></i>負面熱詞</div><div class="word-list">${a.hotNeg.map(([w, x]) => `<span>${esc(w)}<b>${x.neg}</b></span>`).join('') || '<span>—</span>'}</div></div>
      </div>
    </section>
  </div>

  <div class="grid g2">
    <section class="panel box" id="topPos">${topHTML(a, 'pos')}</section>
    <section class="panel box" id="topNeg">${topHTML(a, 'neg')}</section>
  </div>

  ${esgHTML(a)}

  <section class="panel box" style="margin-bottom:12px">
    <h4>投資分析與建議 <small>規則式評分：情緒 30%、價格趨勢 25%、估值 15%、情緒動能 10%、RSI 10%、波動 10%</small></h4>
    <div class="advice" style="margin-top:10px">
      <div class="gauge">
        <div class="score">${sc.total ?? '—'}</div>
        <div class="rating badge ${sc.tone}" style="font-size:15px">${sc.rating}</div>
        <div class="bar"><i style="left:${sc.total ?? 50}%"></i></div>
        <div class="scale"><span>偏空</span><span>中性</span><span>偏多</span></div>
        <div class="callout" style="text-align:left">${adv.action}${adv.stop ? `<br><span class="meta-small">停損參考：現價 −8% ≈ ${fmt(adv.stop, 1)} 元</span>` : ''}</div>
      </div>
      <div>
        <table class="factors"><thead><tr><th>面向</th><th>權重</th><th>數值</th><th>分數</th><th>說明</th></tr></thead><tbody>
        ${sc.factors.map((f) => `<tr><td><b>${f.name}</b></td><td class="num">${f.w}%</td><td class="num">${esc(f.val)}</td><td class="num">${f.s == null ? '—' : `<span class="minibar"><i style="width:${f.s}%"></i></span>${f.s}`}</td><td>${esc(f.note)}</td></tr>`).join('')}
        </tbody></table>
        <ul class="adv-list">${adv.out.map((x) => `<li>${x}</li>`).join('')}</ul>
        ${adv.risks.length ? `<div class="callout"><b>需注意的風險</b><ul class="adv-list" style="margin-top:4px">${adv.risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      </div>
    </div>
    ${t ? `<h4 style="margin-top:18px">近半年股價與成交量 <small>收盤價、20 日與 60 日均線</small></h4>
    <div class="legend"><span><i class="dot" style="background:#14213d"></i>收盤價</span><span><i class="dot" style="background:${SERIES[0]}"></i>20 日均線</span><span><i class="dot" style="background:${SERIES[1]}"></i>60 日均線</span></div>
    <div class="chart"><canvas id="cPrice6"></canvas></div>
    <div class="chart sm" style="height:90px;margin-top:6px"><canvas id="cVol6"></canvas></div>
    <div class="tech" style="margin-top:12px">
      <div><span>5 日均線</span><b>${fmt(t.ma5, 2)}</b></div><div><span>20 日均線（月線）</span><b>${fmt(t.ma20, 2)}</b></div>
      <div><span>60 日均線（季線）</span><b>${fmt(t.ma60, 2)}</b></div><div><span>RSI(14)</span><b>${fmt(t.rsi, 1)}</b></div>
      <div><span>5 日報酬</span><b>${pct(t.ret5)}</b></div><div><span>20 日報酬</span><b>${pct(t.ret20)}</b></div>
      <div><span>60 日報酬</span><b>${pct(t.ret60)}</b></div><div><span>年化波動率</span><b>${t.vol == null ? '—' : t.vol.toFixed(1) + '%'}</b></div>
      <div><span>一年高點</span><b>${fmt(t.hi, 2)}</b></div><div><span>一年低點</span><b>${fmt(t.lo, 2)}</b></div>
      <div><span>距一年高點</span><b>${pct(t.fromHi)}</b></div><div><span>量比（5日／20日）</span><b>${t.volRatio == null ? '—' : t.volRatio.toFixed(2)}</b></div>
    </div>` : ''}
    <div class="callout"><b>情緒與股價的關聯（呼應論文：文字是否帶有股價資訊）</b><br>
      ${a.corr && a.corr.r != null ? `期間內每日淨情緒與「下一個交易日報酬」的相關係數 r = <b>${a.corr.r.toFixed(2)}</b>（樣本 ${a.corr.n} 天）。${Math.abs(a.corr.r) < 0.1 ? '幾乎沒有線性關聯。' : a.corr.r > 0 ? '情緒越正面，隔天股價傾向越好' + (a.corr.r > 0.3 ? '，關聯明顯。' : '，但關聯偏弱。') : '呈反向關係，可能是消息已提前反映。'}樣本少時僅供參考，不代表因果。`
      : `有文章的天數不足 8 天（目前 ${a.corr ? a.corr.n : 0} 天），無法計算可靠的相關係數；請改選較長的期間。`}
    </div>
    <p class="disclaimer">本分析由程式依公開文章與股價自動產生，情緒標籤可能誤判，評分權重為課程示範設計，不構成任何投資建議。投資前請自行查證原始資料並評估風險承受度。</p>
  </section>

  <section class="panel box">
    <h4>全部文章 <small id="tblCount"></small></h4>
    <div class="table-tools">
      <select id="fSent"><option value="">全部情緒</option><option value="pos">正面</option><option value="neu">中性</option><option value="neg">負面</option></select>
      <select id="fCh"><option value="">全部類型</option>${a.channels.map(([k]) => `<option>${esc(k)}</option>`).join('')}</select>
      <select id="fSrc"><option value="">全部來源</option>${a.sources.map(([k]) => `<option>${esc(k)}</option>`).join('')}</select>
      <input id="fText" placeholder="搜尋標題或關鍵字" value="${esc(S.kw || '')}" />
    </div>
    <div class="tbl-wrap"><table class="data"><thead><tr><th>日期</th><th>標題</th><th>來源</th><th>情緒</th><th class="num">信心</th><th>FinBERT vs 字典法</th></tr></thead><tbody id="tblBody"></tbody></table></div>
    <div class="pager" id="pager"></div>
  </section>`;

  // ---- 圖表
  const labels = a.dates.map(md);
  const cs = coverageStart(d), csIdx = cs && cs > a.dates[0] ? a.dates.findIndex((k) => k >= cs) : -1;
  const shade = { id: 'cov', beforeDatasetsDraw(c) { if (csIdx <= 0) return; const { ctx, chartArea: r, scales: { x } } = c; const xe = (x.getPixelForValue(csIdx - 1) + x.getPixelForValue(csIdx)) / 2; ctx.save(); ctx.fillStyle = 'rgba(20,33,61,0.06)'; ctx.fillRect(r.left, r.top, xe - r.left, r.bottom - r.top); ctx.fillStyle = '#8a92a3'; ctx.font = '11px sans-serif'; ctx.fillText('舊新聞補抓中', r.left + 6, r.top + 12); ctx.restore(); } };
  chart('cVolume', {
    plugins: [shade],
    type: 'bar',
    data: { labels, datasets: ['pos', 'neu', 'neg'].map((k) => ({ label: SENT[k].name, data: a.dates.map((x) => a.daily[x][k]), backgroundColor: SENT[k].color, borderColor: '#fff', borderWidth: { top: 1 }, borderRadius: 2, maxBarThickness: 22 })) },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: '篇' } } },
      plugins: { tooltip: { callbacks: { footer: (it) => '合計 ' + it.reduce((s, x) => s + x.parsed.y, 0) + ' 篇' } } } },
  });
  const pmap = Object.fromEntries((d.prices || []).map((p) => [p.d, p.c]));
  const closes = d.prices.map((p) => p.c), ma20s = closes.map((_, i) => (i >= 19 ? closes.slice(i - 19, i + 1).reduce((x, y) => x + y) / 20 : null));
  const mamap = Object.fromEntries(d.prices.map((p, i) => [p.d, ma20s[i]]));
  chart('cPrice', {
    type: 'line',
    data: { labels, datasets: [
      { label: '收盤價', data: a.dates.map((x) => pmap[x] ?? null), borderColor: '#14213d', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true, tension: 0.2 },
      { label: '20 日均線', data: a.dates.map((x) => mamap[x] ?? null), borderColor: '#8a92a3', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, spanGaps: true },
    ] },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { ticks: { maxTicksLimit: 4 }, title: { display: true, text: '元' } } } },
  });
  chart('cDonut', {
    type: 'doughnut',
    data: { labels: ['正面', '中性', '負面'], datasets: [{ data: [a.c.pos, a.c.neu, a.c.neg], backgroundColor: [SENT.pos.color, SENT.neu.color, SENT.neg.color], borderColor: '#fff', borderWidth: 2 }] },
    options: { cutout: '64%', plugins: { tooltip: { callbacks: { label: (x) => ` ${x.label} ${x.parsed} 篇（${a.total ? Math.round((x.parsed / a.total) * 100) : 0}%）` } } } },
    plugins: [{ id: 'center', afterDraw(c) { const { ctx, chartArea: r } = c; ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = '#14213d'; ctx.font = '900 26px Inter,sans-serif'; ctx.fillText(a.total ? (a.net > 0 ? '+' : '') + a.net.toFixed(0) : '—', (r.left + r.right) / 2, (r.top + r.bottom) / 2 + 4); ctx.font = '11px sans-serif'; ctx.fillStyle = '#5f6878'; ctx.fillText('淨情緒', (r.left + r.right) / 2, (r.top + r.bottom) / 2 + 22); ctx.restore(); } }],
  });
  if (t) {
    const p6 = d.prices.slice(-125), off = d.prices.length - p6.length;
    const ma = (k) => p6.map((_, i) => { const j = i + off; return j >= k - 1 ? closes.slice(j - k + 1, j + 1).reduce((x, y) => x + y) / k : null; });
    const l6 = p6.map((p) => md(p.d));
    chart('cPrice6', {
      type: 'line',
      data: { labels: l6, datasets: [
        { label: '收盤價', data: p6.map((p) => p.c), borderColor: '#14213d', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.15 },
        { label: '20 日均線', data: ma(20), borderColor: SERIES[0], borderWidth: 1.5, pointRadius: 0 },
        { label: '60 日均線', data: ma(60), borderColor: SERIES[1], borderWidth: 1.5, pointRadius: 0 },
      ] },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { title: { display: true, text: '元' } } } },
    });
    chart('cVol6', {
      type: 'bar',
      data: { labels: l6, datasets: [{ label: '成交量（張）', data: p6.map((p) => p.v), backgroundColor: p6.map((p, i) => (i && p.c < p6[i - 1].c ? '#9fd09f' : '#eaa5a5')), borderRadius: 1 }] },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { display: false }, y: { ticks: { maxTicksLimit: 2, callback: (x) => (x >= 1000 ? x / 1000 + 'k' : x) } } } },
    });
  }

  // ---- 互動
  S.table = { page: 0, list: a.cur };
  ['fSent', 'fCh', 'fSrc'].forEach((id) => ($(id).onchange = () => { S.table.page = 0; drawTable(); }));
  $('fText').oninput = (e) => { S.kw = e.target.value || null; S.table.page = 0; markCloud(); drawTable(); };
  $('cloud').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.kw = S.kw === b.dataset.w ? null : b.dataset.w; $('fText').value = S.kw || ''; S.table.page = 0; markCloud(); drawTable(); $('fText').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('exportBtn').onclick = () => exportReport(a, adv);
  markCloud(); drawTable();
}

function cloudHTML(words) {
  if (!words.length) return '<p class="sub">文章數不足以產生文字雲</p>';
  const max = words[0][1].n, min = words[words.length - 1][1].n;
  const shuffled = words.map((w, i) => [w, (i * 7919) % words.length]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  return shuffled.map(([w, v]) => {
    const size = 13 + (max === min ? 10 : ((v.n - min) / (max - min)) * 26);
    const dom = v.pos > v.neg && v.pos >= v.neu * 0.6 ? 'pos' : v.neg > v.pos && v.neg >= v.neu * 0.6 ? 'neg' : 'neu';
    const color = dom === 'pos' ? '#2a6fc4' : dom === 'neg' ? '#c4521f' : '#76756f';
    return `<button data-w="${esc(w)}" title="${esc(w)}：${v.n} 篇（正 ${v.pos}／中 ${v.neu}／負 ${v.neg}）" style="font-size:${size.toFixed(0)}px;color:${color}">${esc(w)}</button>`;
  }).join('');
}
function markCloud() { document.querySelectorAll('#cloud button').forEach((b) => b.classList.toggle('on', b.dataset.w === S.kw)); }

function drawTable() {
  const s = $('fSent').value, ch = $('fCh').value, src = $('fSrc').value, kw = ($('fText').value || '').trim();
  const rows = S.table.list.filter((a) => (!s || a.sentiment === s) && (!ch || a.channel === ch) && (!src || a.source === src) && (!kw || a.title.includes(kw) || (a.keywords || []).includes(kw)));
  const per = 12, pages = Math.max(1, Math.ceil(rows.length / per)); S.table.page = Math.min(S.table.page, pages - 1);
  const page = rows.slice(S.table.page * per, (S.table.page + 1) * per);
  $('tblCount').textContent = `${rows.length} 篇`;
  $('tblBody').innerHTML = page.map((a) => `<tr><td style="white-space:nowrap">${esc(a.date.slice(5, 10).replace('-', '/'))}</td><td><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>${a.push != null ? ` <small style="color:var(--muted)">推 ${a.push}</small>` : ''}${a.views != null ? ` <small style="color:var(--muted)">瀏覽 ${fmt(a.views)}</small>` : ''}</td><td style="white-space:nowrap">${esc(a.source)}</td><td><span class="badge ${a.sentiment}">${SENT[a.sentiment].name}</span></td><td class="num">${Math.round((a.scores?.[a.sentiment] || 0) * 100)}%</td><td style="font-size:12px;color:var(--muted)">${a.dictSentiment && a.dictSentiment !== a.sentiment ? `字典法判為${SENT[a.dictSentiment].name}` : '一致'}</td></tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">沒有符合條件的文章</td></tr>';
  $('pager').innerHTML = pages > 1 ? `<button class="secondary" ${S.table.page === 0 ? 'disabled' : ''} id="pgPrev">上一頁</button><span>${S.table.page + 1} / ${pages}</span><button class="secondary" ${S.table.page >= pages - 1 ? 'disabled' : ''} id="pgNext">下一頁</button>` : '';
  if ($('pgPrev')) { $('pgPrev').onclick = () => { S.table.page--; drawTable(); }; $('pgNext').onclick = () => { S.table.page++; drawTable(); }; }
}

function exportReport(a, adv) {
  const d = a.d, t = a.tech || {};
  const lines = [
    '公司健檢照妖鏡｜分析摘要', `公司：${d.name}（${d.code}）`, `期間：近 ${a.days} 天（${a.dates[0]} ～ ${a.dates[a.dates.length - 1]}）`,
    `資料模式：${d.mode}　情緒模型：${d.model}`, '',
    `股價：${fmt(d.quote?.price, 2)}（${pct(d.quote?.changePct, 2)}）　本益比 ${fmt(d.valuation?.pe, 1)}　殖利率 ${fmt(d.valuation?.yield, 2)}%`,
    `總聲量：${a.total} 篇　正面 ${a.c.pos}／中性 ${a.c.neu}／負面 ${a.c.neg}　好感度 ${a.favor == null ? '—' : a.favor.toFixed(2)}　淨情緒 ${a.net.toFixed(0)}`,
    `技術面：MA20 ${fmt(t.ma20, 2)}　MA60 ${fmt(t.ma60, 2)}　RSI ${fmt(t.rsi, 1)}　20日報酬 ${pct(t.ret20)}　年化波動 ${t.vol ? t.vol.toFixed(1) + '%' : '—'}`, '',
    `綜合評分：${a.score.total ?? "—"} / 100（${a.score.rating}）`, ...a.score.factors.map((f) => `  - ${f.name}（${f.w}%）：${f.s ?? '—'} 分，${f.note}`), '',
    '分析：', ...adv.out.map((x) => '  - ' + x.replace(/<[^>]+>/g, '')), '建議：' + adv.action.replace(/<[^>]+>/g, ''),
    ...(adv.risks.length ? ['風險：', ...adv.risks.map((x) => '  - ' + x)] : []), '',
    `ESG：${a.esg.any} 篇涉及（E ${a.esg.esg.E.n}／S ${a.esg.esg.S.n}／G ${a.esg.esg.G.n}）　前瞻性陳述：${a.esg.fls.yes.n} 篇，淨情緒 ${netOf(a.esg.fls.yes) == null ? '—' : netOf(a.esg.fls.yes).toFixed(0)}（現況描述 ${netOf(a.esg.fls.no) == null ? '—' : netOf(a.esg.fls.no).toFixed(0)}）`, '',
    '正面熱門文章：', ...a.topPos.list.map((x) => `  - ${x.title}（${x.source}）${x.url}`),
    '負面熱門文章：', ...a.topNeg.list.map((x) => `  - ${x.title}（${x.source}）${x.url}`), '',
    '提醒：本報告為文字與價格分析輔助，不構成投資建議。',
  ];
  const el = document.createElement('a');
  el.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
  el.download = `company-xray-${d.code}.txt`; el.click(); toast('分析摘要已下載');
}

// ------------------------------------------------------------------ 多股比較
function renderCompare(v) {
  const list = S.stocks.filter((s) => s.status === 'ok').map((s) => ({ s, a: analyze(s.data, S.days) }));
  if (list.length < 2) { v.innerHTML = '<div class="empty">至少需要兩檔載入完成才能比較。</div>'; return; }
  const ranked = [...list].sort((x, y) => (y.a.score.total ?? -1) - (x.a.score.total ?? -1));
  const best = (fn, hi = true) => list.filter((x) => fn(x) != null).sort((x, y) => (hi ? fn(y) - fn(x) : fn(x) - fn(y)))[0];
  const bSent = best((x) => (x.a.total ? x.a.net : null)), bBuzz = best((x) => x.a.total), bTrend = best((x) => x.a.tech?.ret20), bRisk = best((x) => x.a.tech?.vol, false), bVal = best((x) => (x.s.data.valuation?.pe > 0 ? x.s.data.valuation.pe : null), false);
  const sw = (x) => `<i class="compare-sw" style="background:${x.s.color}"></i>${esc(x.s.data.name)}`;
  v.innerHTML = `
  <section class="panel box" style="margin-bottom:12px">
    <h4>多股比較總表 <small>近 ${S.days} 天，依綜合評分排序</small></h4>
    <div class="tbl-wrap"><table class="data"><thead><tr><th>#</th><th>股票</th><th class="num">股價</th><th class="num">漲跌</th><th class="num">聲量</th><th>情緒組成</th><th class="num">好感度</th><th class="num">淨情緒</th><th class="num">20日報酬</th><th class="num">RSI</th><th class="num">本益比</th><th class="num">綜合評分</th><th>評等</th></tr></thead><tbody>
    ${ranked.map((x, i) => { const q = x.s.data.quote || {}, t = x.a.tech || {}; return `<tr><td>${i + 1}</td><td style="white-space:nowrap">${sw(x)} <small style="color:var(--muted)">${esc(x.s.data.code)}</small></td><td class="num">${fmt(q.price, 2)}</td><td class="num">${q.changePct == null ? '—' : `<span class="chg ${q.change > 0 ? 'up' : q.change < 0 ? 'down' : 'flat'}" style="font-size:13px">${q.change > 0 ? '▲' : q.change < 0 ? '▼' : ''}${pct(q.changePct, 2)}</span>`}</td><td class="num">${x.a.total}</td><td style="min-width:120px"><div class="hbar" style="grid-template-columns:1fr;margin:3px 0"><div class="track">${x.a.total ? segBar(x.a.c, x.a.total) : ''}</div></div></td><td class="num">${x.a.favor == null ? '—' : x.a.favor.toFixed(2)}</td><td class="num">${x.a.total ? (x.a.net > 0 ? '+' : '') + x.a.net.toFixed(0) : '—'}</td><td class="num">${pct(t.ret20)}</td><td class="num">${fmt(t.rsi, 0)}</td><td class="num">${fmt(x.s.data.valuation?.pe, 1)}</td><td class="num"><b>${x.a.score.total ?? '—'}</b></td><td><span class="badge ${x.a.score.tone}">${x.a.score.rating}</span></td></tr>`; }).join('')}
    </tbody></table></div>
  </section>

  <div class="grid g2">
    <section class="panel box"><h4>股價相對表現 <small>以期間第一個交易日＝100 指數化，可直接比較漲幅</small></h4>
      <div class="legend">${list.map((x) => `<span><i class="dot" style="background:${x.s.color}"></i>${esc(x.s.data.name)}</span>`).join('')}</div>
      <div class="chart"><canvas id="cmpPrice"></canvas></div></section>
    <section class="panel box"><h4>每日聲量比較 <small>每天相關文章數</small></h4>
      <div class="legend">${list.map((x) => `<span><i class="dot" style="background:${x.s.color}"></i>${esc(x.s.data.name)}</span>`).join('')}</div>
      <div class="chart"><canvas id="cmpBuzz"></canvas></div></section>
  </div>

  <div class="grid g2">
    <section class="panel box"><h4>各面向評分雷達圖 <small>0～100，越外圈越好</small></h4>
      <div class="legend">${list.map((x) => `<span><i class="dot" style="background:${x.s.color}"></i>${esc(x.s.data.name)}</span>`).join('')}</div>
      <div class="chart lg"><canvas id="cmpRadar"></canvas></div></section>
    <section class="panel box"><h4>每日淨情緒走勢 <small>（正面−負面）÷ 當日文章數，7 日移動平均</small></h4>
      <div class="legend">${list.map((x) => `<span><i class="dot" style="background:${x.s.color}"></i>${esc(x.s.data.name)}</span>`).join('')}</div>
      <div class="chart lg"><canvas id="cmpNet"></canvas></div></section>
  </div>

  <section class="panel box">
    <h4>比較結論與配置建議</h4>
    <ul class="adv-list">
      <li>綜合評分最高：${sw(ranked[0])}（${ranked[0].a.score.total} 分，${ranked[0].a.score.rating}）；最低：${sw(ranked[ranked.length - 1])}（${ranked[ranked.length - 1].a.score.total ?? "—"} 分）。</li>
      ${bSent ? `<li>新聞情緒最正面：${sw(bSent)}（淨情緒 ${bSent.a.net > 0 ? '+' : ''}${bSent.a.net.toFixed(0)}）。</li>` : ''}
      ${bBuzz ? `<li>市場討論度最高：${sw(bBuzz)}（${bBuzz.a.total} 篇）。聲量高代表關注度高，但不等於看好。</li>` : ''}
      ${bTrend ? `<li>近 20 日股價表現最強：${sw(bTrend)}（${pct(bTrend.a.tech.ret20)}）。</li>` : ''}
      ${bRisk ? `<li>波動最小、相對穩健：${sw(bRisk)}（年化波動 ${bRisk.a.tech.vol.toFixed(0)}%）。</li>` : ''}
      ${bVal ? `<li>本益比最低：${sw(bVal)}（${bVal.s.data.valuation.pe.toFixed(1)} 倍）。</li>` : ''}
    </ul>
    <div class="callout">${compareAdvice(ranked)}</div>
    <p class="disclaimer">比較結果為程式依公開資料自動計算，評分權重為課程示範設計，不構成投資建議。</p>
  </section>`;

  // 指數化股價
  const span = Math.max(S.days, 60), cutoff = dkey(refDate(list[0].s.data).getTime() - span * DAY);
  const allDates = [...new Set(list.flatMap((x) => x.s.data.prices.filter((p) => p.d > cutoff).map((p) => p.d)))].sort();
  chart('cmpPrice', {
    type: 'line',
    data: { labels: allDates.map(md), datasets: list.map((x) => {
      const m = Object.fromEntries(x.s.data.prices.map((p) => [p.d, p.c])); const base = allDates.map((k) => m[k]).find((c) => c != null);
      return { label: x.s.data.name, data: allDates.map((k) => (m[k] != null ? +((m[k] / base) * 100).toFixed(2) : null)), borderColor: x.s.color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true, tension: 0.15 };
    }) },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { title: { display: true, text: '指數（起點＝100）' } } } },
  });
  const dates = list[0].a.dates;
  chart('cmpBuzz', {
    type: 'line',
    data: { labels: dates.map(md), datasets: list.map((x) => ({ label: x.s.data.name, data: dates.map((k) => { const v = x.a.daily[k]; return v ? v.pos + v.neu + v.neg : 0; }), borderColor: x.s.color, backgroundColor: x.s.color, borderWidth: 2, pointRadius: S.days <= 7 ? 4 : 0, pointHoverRadius: 4, tension: 0.2 })) },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: '篇' } } } },
  });
  const dims = ['sent', 'mom', 'trend', 'rsi', 'risk', 'val'], dimNames = ['新聞情緒', '情緒動能', '價格趨勢', '動能／過熱', '波動風險', '估值'];
  chart('cmpRadar', {
    type: 'radar',
    data: { labels: dimNames, datasets: list.filter((x) => x.a.score.total != null).map((x) => ({ label: x.s.data.name, data: dims.map((k) => x.a.score.factors.find((f) => f.key === k)?.s ?? 50), borderColor: x.s.color, backgroundColor: x.s.color + '22', borderWidth: 2, pointRadius: 3, pointBackgroundColor: x.s.color })) },
    options: { scales: { r: { min: 0, max: 100, ticks: { stepSize: 25, backdropColor: 'transparent' }, pointLabels: { font: { size: 12 } } } } },
  });
  chart('cmpNet', {
    type: 'line',
    data: { labels: dates.map(md), datasets: list.map((x) => {
      const raw = dates.map((k) => x.a.daily[k]);
      return { label: x.s.data.name, borderColor: x.s.color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true, tension: 0.25,
        data: raw.map((_, i) => { let p = 0, n = 0, t = 0; for (let j = Math.max(0, i - 6); j <= i; j++) { p += raw[j].pos; n += raw[j].neg; t += raw[j].pos + raw[j].neu + raw[j].neg; } return t ? +(((p - n) / t) * 100).toFixed(1) : null; }) };
    }) },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { suggestedMin: -50, suggestedMax: 50, title: { display: true, text: '淨情緒' }, grid: { color: (c) => (c.tick.value === 0 ? '#c9cfdb' : '#eef1f6') } } } },
  });
}

function compareAdvice(r) {
  const top = r[0], bull = r.filter((x) => x.a.score.total >= 55), bear = r.filter((x) => x.a.score.total != null && x.a.score.total < 45);
  const n = (x) => x.s.data.name;
  let s = `<b>配置思路：</b>`;
  if (bull.length) s += `目前訊號較佳的是 ${bull.map(n).join('、')}，若要在這幾檔中挑選，可優先研究${n(top)}；`;
  else s += `所有標的評分都未達「中性偏多」，整體建議保守、降低持股或分批觀察；`;
  if (bear.length) s += `${bear.map(n).join('、')} 負面訊號較多，持有者應檢視是否需要減碼或設定停損；`;
  s += `分散投資可降低單一公司消息面風險，建議單一個股不超過可投資資金的 20～30%，並搭配自身風險承受度調整。`;
  return s;
}

// ------------------------------------------------------------------ 熱門文章區塊（可單獨更新）
function topHTML(a, lab) {
  const t = lab === 'pos' ? a.topPos : a.topNeg, pend = t.list.filter((x) => x.evidencePending).length;
  return `<h4>${lab === 'pos' ? '正面' : '負面'}熱門文章 Top 5 ${pend ? `<small>⏳ 判斷依據分析中（剩 ${pend} 篇）</small>` : ''}</h4><p class="rank-note">${t.basis}</p>`
    + (t.list.map((x) => artHTML(x)).join('') || `<p class="sub">期間內沒有${lab === 'pos' ? '正面' : '負面'}文章</p>`);
}
function refreshTop(st) {
  if (!$('topPos') || !st.data) return;
  const a = analyze(st.data, S.days);
  $('topPos').innerHTML = topHTML(a, 'pos'); $('topNeg').innerHTML = topHTML(a, 'neg');
}

// ------------------------------------------------------------------ ESG 與前瞻性陳述
const ESG_WORDS = {
  E: ['ESG', '永續', '淨零', '碳排', '減碳', '碳中和', '碳費', '碳權', '碳盤查', '再生能源', '綠電', '太陽能', '風電', '節能', '節電', '環保', '氣候', '溫室氣體', '污染', '汙染', '廢棄物', '廢水', '水資源', '循環經濟', '綠色'],
  S: ['員工', '勞工', '加薪', '調薪', '裁員', '職安', '工安', '人權', '性別', '社會責任', '公益', '捐贈', '消費者', '食安', '罷工', '薪資', '福利', '傷亡', '人才', '培訓', '社區', '童工', '職災'],
  G: ['董事會', '公司治理', '治理', '內控', '稽核', '掏空', '弊案', '違約', '裁罰', '罰款', '罰鍰', '訴訟', '經營權', '股東會', '獨立董事', '獨董', '內線', '財報不實', '會計師', '資訊揭露', '背信', '董事長', '接班', '庫藏股'],
};
const ESG_NAME = { E: '環境 E', S: '社會 S', G: '治理 G' };
const FLS_RE = /(預計|(?<!優於|低於|不如|超乎|符合|高於|超出|不及)預期|預估|展望|可望|有望|將(會|於|持續|擴|推|進|再|可|在)|計畫|規劃|目標|未來|明年|下半年|下季|下一季|估計|預料|力拼|後市)/g;
const artTexts = (a) => [a.title, a.summary || '', ...((a.evidence || []).map((e) => e.text))].join('。');

function esgAnalyze(cur) {
  const esg = { E: { n: 0, pos: 0, neu: 0, neg: 0, words: {}, arts: [] }, S: { n: 0, pos: 0, neu: 0, neg: 0, words: {}, arts: [] }, G: { n: 0, pos: 0, neu: 0, neg: 0, words: {}, arts: [] } };
  let any = 0;
  const fls = { yes: { n: 0, pos: 0, neu: 0, neg: 0 }, no: { n: 0, pos: 0, neu: 0, neg: 0 }, samples: [] };
  cur.forEach((a) => {
    const txt = artTexts(a); let hit = false;
    for (const k of ['E', 'S', 'G']) {
      const ws = ESG_WORDS[k].filter((w) => txt.includes(w));
      if (ws.length) { hit = true; const g = esg[k]; g.n++; g[a.sentiment]++; ws.forEach((w) => (g.words[w] = (g.words[w] || 0) + 1)); if (g.arts.length < 3) g.arts.push(a); }
    }
    if (hit) any++;
    const isF = FLS_RE.test(txt); FLS_RE.lastIndex = 0;
    const b = isF ? fls.yes : fls.no; b.n++; b[a.sentiment]++;
    if (isF && fls.samples.length < 5) {
      const sents = [a.title, ...((a.evidence || []).map((e) => e.text))];
      const s = sents.find((x) => { const r = FLS_RE.test(x); FLS_RE.lastIndex = 0; return r; });
      if (s && !fls.samples.some((x) => x.text === s)) fls.samples.push({ text: s, a });
    }
  });
  return { esg, any, fls };
}
const netOf = (g) => (g.n ? ((g.pos - g.neg) / g.n) * 100 : null);
function flsMark(text) { return esc(text).replace(FLS_RE, (m) => `<em class="f">${m}</em>`); }

function esgHTML(a) {
  const { esg, any, fls } = a.esg;
  const maxN = Math.max(1, ...['E', 'S', 'G'].map((k) => esg[k].n));
  const fy = netOf(fls.yes), fn = netOf(fls.no);
  const verdict = fy == null || fn == null || fls.yes.n < 3 ? '前瞻性陳述數量不足，暫不比較。'
    : fy - fn > 10 ? `談到<b>未來</b>的文章比描述<b>現況</b>的更樂觀（淨情緒 ${fy.toFixed(0)} vs ${fn.toFixed(0)}）：市場對後市有期待，但需留意期待是否落空。`
    : fy - fn < -10 ? `談到<b>未來</b>的文章比描述<b>現況</b>的更保守（淨情緒 ${fy.toFixed(0)} vs ${fn.toFixed(0)}）：現況尚可，但對後市有疑慮。`
    : `對未來與現況的看法差不多（淨情緒 ${fy.toFixed(0)} vs ${fn.toFixed(0)}）。`;
  return `<div class="grid g2">
    <section class="panel box">
      <h4>ESG 議題分析 <small>${a.total ? `${any} 篇（${Math.round((any / a.total) * 100)}%）涉及 ESG` : ''}</small></h4>
      <p class="sub">FinBERT 論文指出模型也能辨識 ESG 討論。作者的 FinBERT-ESG 只有英文版，本站以中文 ESG 詞庫分類，情緒沿用 FinBERT 判斷。</p>
      ${['E', 'S', 'G'].map((k) => { const g = esg[k], n = netOf(g); return `<div class="hbar" style="grid-template-columns:70px 1fr 92px"><span><b>${ESG_NAME[k]}</b></span><div class="track" style="max-width:${(g.n / maxN) * 100}%">${g.n ? segBar(g, g.n) : ''}</div><b>${g.n} 篇${n == null ? '' : `・${n > 0 ? '+' : ''}${n.toFixed(0)}`}</b></div>`; }).join('')}
      <div class="word-list" style="margin:10px 0 4px">${['E', 'S', 'G'].flatMap((k) => Object.entries(esg[k].words).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([w, c]) => `<span>${k}・${esc(w)}<b>${c}</b></span>`)).join('') || '<span>期間內沒有 ESG 相關文章</span>'}</div>
      ${['E', 'S', 'G'].flatMap((k) => esg[k].arts.slice(0, 2).map((x) => `<div class="mini-art"><span class="badge ${x.sentiment}">${SENT[x.sentiment].name}</span><span class="esg-tag">${k}</span><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a><small>${esc(x.source)}</small></div>`)).join('')}
    </section>
    <section class="panel box">
      <h4>前瞻性陳述分析 <small>${a.total ? `${fls.yes.n} 篇（${Math.round((fls.yes.n / a.total) * 100)}%）談到未來` : ''}</small></h4>
      <p class="sub">論文作者另有 FinBERT-FLS 模型辨識「前瞻性陳述」（對未來的預測與計畫），同樣只有英文版。本站以「預計、展望、明年、可望…」等詞辨識。</p>
      <div class="hbar" style="grid-template-columns:92px 1fr 70px"><span><b>談未來</b></span><div class="track">${fls.yes.n ? segBar(fls.yes, fls.yes.n) : ''}</div><b>${fy == null ? '—' : (fy > 0 ? '+' : '') + fy.toFixed(0)}</b></div>
      <div class="hbar" style="grid-template-columns:92px 1fr 70px"><span><b>描述現況</b></span><div class="track">${fls.no.n ? segBar(fls.no, fls.no.n) : ''}</div><b>${fn == null ? '—' : (fn > 0 ? '+' : '') + fn.toFixed(0)}</b></div>
      <div class="callout" style="margin-top:8px">${verdict}</div>
      ${fls.samples.map((x) => `<div class="mini-art"><span class="badge ${x.a.sentiment}">${SENT[x.a.sentiment].name}</span><span>「${flsMark(x.text)}」</span><small>${esc(x.a.source)}</small></div>`).join('')}
    </section>
  </div>`;
}

// ------------------------------------------------------------------ 市場總覽
function heatColor(net) {
  if (net == null) return ['#f1f3f8', '#14213d'];
  const t = clamp(Math.abs(net) / 60, 0, 1), mix = (a, b) => '#' + [0, 2, 4].map((i) => Math.round(parseInt(a.substr(i + 1, 2), 16) * (1 - t) + parseInt(b.substr(i + 1, 2), 16) * t).toString(16).padStart(2, '0')).join('');
  const bg = net >= 0 ? mix('#f1f3f8', '#2a78d6') : mix('#f1f3f8', '#e0601f');
  return [bg, t > 0.5 ? '#fff' : '#14213d'];
}
function renderMarket(v) {
  const list = INDEX.stocks, days = INDEX.days || [];
  const sum = (k) => [0, 1, 2].map((i) => list.reduce((x, s) => x + (s[k] ? s[k][i] : 0), 0));
  const c7 = sum('c7'), p7 = sum('p7'), n7 = c7[0] + c7[1] + c7[2], np7 = p7[0] + p7[1] + p7[2];
  const net = (c) => { const n = c[0] + c[1] + c[2]; return n ? ((c[0] - c[2]) / n) * 100 : null; };
  const mNet = net(c7), mPrev = net(p7);
  const rows = list.map((s) => ({ ...s, n7: s.c7[0] + s.c7[1] + s.c7[2], np7: s.p7[0] + s.p7[1] + s.p7[2], net7: net(s.c7), netp7: net(s.p7) }));
  // 產業
  const inds = {};
  rows.forEach((s) => { const k = s.industry || '其他'; const g = (inds[k] = inds[k] || { name: k, n: 0, c: [0, 0, 0], stocks: [] }); g.n++; g.stocks.push(s); s.c7.forEach((x, i) => (g.c[i] += x)); });
  const indList = Object.values(inds).map((g) => ({ ...g, vol: g.c[0] + g.c[1] + g.c[2], net: net(g.c) })).sort((a, b) => b.vol - a.vol);
  const hottest = indList[0];
  const MIN = 3;
  const rank = (arr, fn, desc = true) => arr.filter((s) => fn(s) != null).sort((a, b) => (desc ? fn(b) - fn(a) : fn(a) - fn(b))).slice(0, 10);
  const rPos = rank(rows.filter((s) => s.n7 >= MIN), (s) => s.net7);
  const rNeg = rank(rows.filter((s) => s.n7 >= MIN), (s) => s.net7, false);
  const rBuzz = rank(rows.filter((s) => s.n7 >= MIN), (s) => s.n7 / Math.max(1, s.np7));
  const rTurn = rank(rows.filter((s) => s.n7 >= MIN && s.np7 >= MIN), (s) => Math.abs(s.net7 - s.netp7));
  const rowHTML = (s, val) => `<button class="rank-row" data-code="${esc(s.code)}"><span><b>${esc(s.name)}</b> <small>${esc(s.code)}</small></span><span class="rv">${val}</span></button>`;
  const sgn = (x) => (x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(0));
  const chg = (s) => (s.changePct == null ? '' : `<span class="chg ${s.changePct > 0 ? 'up' : s.changePct < 0 ? 'down' : 'flat'}" style="font-size:12px">${s.changePct > 0 ? '▲' : s.changePct < 0 ? '▼' : ''}${pct(s.changePct, 2)}</span>`);
  v.innerHTML = `
  <div class="cards">
    <div class="metric"><div class="label">追蹤檔數</div><div class="value">${list.length}</div><div class="hint">成交值前 100＋前 10 大 ETF＋自選</div></div>
    <div class="metric"><div class="label">近 7 日總聲量</div><div class="value">${fmt(n7)}</div><div class="hint">${np7 ? `較前 7 日 ${pct((n7 / np7 - 1) * 100, 0)}` : '篇'}</div></div>
    <div class="metric"><div class="label">市場淨情緒</div><div class="value">${sgn(mNet)}</div><div class="hint">${mPrev == null ? '近 7 日' : `前 7 日 ${sgn(mPrev)}`}</div></div>
    <div class="metric"><div class="label">正面佔比</div><div class="value" style="color:${SENT.pos.color}">${n7 ? Math.round((c7[0] / n7) * 100) + '%' : '—'}</div><div class="hint">${c7[0]} 篇</div></div>
    <div class="metric"><div class="label">負面佔比</div><div class="value" style="color:#c4521f">${n7 ? Math.round((c7[2] / n7) * 100) + '%' : '—'}</div><div class="hint">${c7[2]} 篇</div></div>
    <div class="metric feature"><div class="label">最熱門產業</div><div class="value" style="font-size:22px">${hottest ? esc(hottest.name) : '—'}</div><div class="hint">${hottest ? `${hottest.vol} 篇・淨情緒 ${sgn(hottest.net)}` : ''}</div></div>
  </div>

  <section class="panel box" style="margin-bottom:12px">
    <h4>產業情緒熱力圖 <small>近 7 日；顏色＝淨情緒（藍正面、橘負面），點方塊看產業內個股</small></h4>
    <div class="heat">${indList.map((g) => { const [bg, fg] = heatColor(g.net); return `<button class="heat-tile" data-ind="${esc(g.name)}" style="background:${bg};color:${fg};flex-grow:${Math.max(1, Math.sqrt(g.vol))}"><b>${esc(g.name)}</b><span>${g.n} 檔・${g.vol} 篇</span><span class="hn">${sgn(g.net)}</span></button>`; }).join('')}</div>
    <div class="legend" style="margin-top:8px"><span><i class="dot" style="background:#e0601f"></i>偏負面</span><span><i class="dot" style="background:#f1f3f8;border:1px solid #ddd"></i>中性／無資料</span><span><i class="dot" style="background:#2a78d6"></i>偏正面</span></div>
  </section>

  <div class="grid g2">
    <section class="panel box"><h4>市場每日聲量與情緒 <small>全部追蹤股票合計，近 30 天</small></h4>
      <div class="legend">${['pos', 'neu', 'neg'].map((k) => `<span><i class="dot" style="background:${SENT[k].color}"></i>${SENT[k].name}</span>`).join('')}</div>
      <div class="chart md"><canvas id="mkVol"></canvas></div></section>
    <section class="panel box"><h4>市場淨情緒 vs 元大台灣50（0050） <small>上：每日淨情緒；下：0050 收盤價，日期對齊</small></h4>
      <div class="chart sm"><canvas id="mkNet"></canvas></div><div class="chart sm"><canvas id="mk50"></canvas></div></section>
  </div>

  <div class="grid g2">
    <section class="panel box rank"><h4>😀 情緒最正面 <small>近 7 日、至少 ${MIN} 篇</small></h4>${rPos.map((s) => rowHTML(s, `${sgn(s.net7)}・${s.n7} 篇`)).join('') || '<p class="sub">資料不足</p>'}</section>
    <section class="panel box rank"><h4>😟 情緒最負面 <small>近 7 日、至少 ${MIN} 篇</small></h4>${rNeg.map((s) => rowHTML(s, `${sgn(s.net7)}・${s.n7} 篇`)).join('') || '<p class="sub">資料不足</p>'}</section>
    <section class="panel box rank"><h4>🔥 聲量暴增 <small>近 7 日 ÷ 前 7 日</small></h4>${rBuzz.map((s) => rowHTML(s, `${s.np7 ? '×' + (s.n7 / s.np7).toFixed(1) : '新增'}・${s.n7} 篇`)).join('') || '<p class="sub">資料不足</p>'}</section>
    <section class="panel box rank"><h4>🔄 情緒轉折 <small>近 7 日 vs 前 7 日淨情緒變化</small></h4>${rTurn.map((s) => rowHTML(s, `${sgn(s.netp7)} → ${sgn(s.net7)} ${s.net7 > s.netp7 ? '↑' : '↓'}`)).join('') || '<p class="sub">資料不足</p>'}</section>
  </div>

  <section class="panel box">
    <h4>全部追蹤股票 <small id="mkCount"></small></h4>
    <div class="table-tools"><select id="mkInd"><option value="">全部產業</option>${indList.map((g) => `<option>${esc(g.name)}</option>`).join('')}</select><span class="meta-small">點標題排序、點列加入健檢</span></div>
    <div class="tbl-wrap"><table class="data" id="mkTable"><thead><tr>${[['code', '代號'], ['name', '名稱'], ['industry', '產業'], ['price', '股價', 1], ['changePct', '漲跌', 1], ['n7', '7日聲量', 1], ['net7', '淨情緒', 1], ['ret20', '20日報酬', 1]].map(([k, t, n]) => `<th class="sortable ${n ? 'num' : ''}" data-k="${k}">${t}</th>`).join('')}</tr></thead><tbody></tbody></table></div>
  </section>`;

  // 圖表
  const lab = days.map(md);
  const daily = days.map((_, i) => [0, 1, 2].map((j) => list.reduce((x, s) => x + (s.daily && s.daily[i] ? s.daily[i][j] : 0), 0)));
  chart('mkVol', { type: 'bar', data: { labels: lab, datasets: ['pos', 'neu', 'neg'].map((k, j) => ({ label: SENT[k].name, data: daily.map((d) => d[j]), backgroundColor: SENT[k].color, borderColor: '#fff', borderWidth: { top: 1 }, borderRadius: 2 })) },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: '篇' } } } } });
  chart('mkNet', { type: 'line', data: { labels: lab, datasets: [{ label: '淨情緒', data: daily.map((d) => { const n = d[0] + d[1] + d[2]; return n ? +(((d[0] - d[2]) / n) * 100).toFixed(1) : null; }), borderColor: '#14213d', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true, tension: 0.25 }] },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { title: { display: true, text: '淨情緒' }, grid: { color: (c) => (c.tick.value === 0 ? '#c9cfdb' : '#eef1f6') } } } } });
  fetch('data/p/0050.json').then((r) => r.json()).then((j) => {
    const m = Object.fromEntries(j.d.map((d, i) => [d, j.c[i]]));
    chart('mk50', { type: 'line', data: { labels: lab, datasets: [{ label: '0050 收盤', data: days.map((d) => m[d] ?? null), borderColor: SERIES[2], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true }] },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { title: { display: true, text: '元' } } } } });
  }).catch(() => {});

  // 表格
  let sortK = 'n7', desc = true, ind = '';
  const draw = () => {
    const r = rows.filter((s) => !ind || (s.industry || '其他') === ind).sort((a, b) => { const x = a[sortK], y = b[sortK]; return (typeof x === 'string' ? String(x).localeCompare(y) : (x ?? -1e9) - (y ?? -1e9)) * (desc ? -1 : 1); });
    $('mkCount').textContent = `${r.length} 檔`;
    $('mkTable').querySelector('tbody').innerHTML = r.map((s) => `<tr class="click" data-code="${esc(s.code)}"><td>${esc(s.code)}</td><td><b>${esc(s.name)}</b>${s.auto ? '' : ' <small style="color:var(--muted)">自選</small>'}</td><td>${esc(s.industry || '')}</td><td class="num">${fmt(s.price, 2)}</td><td class="num">${chg(s)}</td><td class="num">${s.n7}</td><td class="num">${sgn(s.net7)}</td><td class="num">${pct(s.ret20)}</td></tr>`).join('');
  };
  $('mkTable').querySelector('thead').onclick = (e) => { const th = e.target.closest('th'); if (!th) return; if (sortK === th.dataset.k) desc = !desc; else { sortK = th.dataset.k; desc = true; } draw(); };
  $('mkInd').onchange = (e) => { ind = e.target.value; draw(); };
  v.querySelectorAll('.heat-tile').forEach((b) => (b.onclick = () => { ind = b.dataset.ind; $('mkInd').value = ind; draw(); $('mkTable').scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
  v.onclick = (e) => { const r = e.target.closest('[data-code]'); if (r) addStock(r.dataset.code); };
  draw();
}

window.removeStock = removeStock;
init();
