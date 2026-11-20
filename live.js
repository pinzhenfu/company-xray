/* 即時抓取引擎（不在追蹤清單的股票用）
 * 瀏覽器不能直接讀別的網站，所以透過「公共轉址服務」(CORS proxy) 代抓。
 * 這些服務是第三方免費提供，偶爾會變慢或失效；程式會自動輪流嘗試。
 * 情緒分析使用金融字典法（FinBERT 無法在瀏覽器即時執行），並同樣做逐句分析找出判斷依據。
 */
'use strict';
window.XLive = (() => {
  const PROXIES = [
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    (u) => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u),
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  ];
  let best = 0;   // 上一次成功的轉址服務先試

  async function fetchText(url, check, ms = 15000) {
    let lastErr;
    for (let k = 0; k < PROXIES.length; k++) {
      const i = (best + k) % PROXIES.length;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
      try {
        const r = await fetch(PROXIES[i](url), { signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const txt = await r.text();
        if (check && !check(txt)) throw new Error('內容不正確');
        best = i; return txt;
      } catch (e) { lastErr = e; } finally { clearTimeout(t); }
    }
    throw lastErr || new Error('轉址服務皆失敗');
  }
  const fetchJSON = async (url, ms) => JSON.parse(await fetchText(url, (t) => /^\s*[{[]/.test(t), ms));

  // ---------------------------------------------------------------- 媒體白名單
  let MEDIA = [];
  async function loadMedia() { if (!MEDIA.length) { try { MEDIA = await (await fetch('media.json')).json(); } catch (e) {} } return MEDIA; }
  function canon(source, url = '') {
    const text = (source + ' ' + url).toLowerCase();
    for (const [name, group, keys] of MEDIA) if (keys.some((k) => text.includes(k.toLowerCase()))) return [name, group];
    return null;
  }

  // ---------------------------------------------------------------- 金融字典（與 sentiment.py 相同）
  const POS = ['成長', '增長', '創新高', '新高', '看好', '上修', '調升', '優於預期', '超乎預期', '強勁', '大漲', '漲停', '攻頂', '轉盈', '獲利', '賺', '受惠', '利多', '買超', '加碼', '樂觀', '回溫', '復甦', '擴產', '接單', '訂單滿', '滿載', '亮眼', '飆', '噴', '突破', '旺', '暢旺', '穩健', '韌性', '改善', '提升', '股利', '配息', '目標價上調', '上漲', '反彈', '雙位數成長', '創高', '看多', '多頭', '營收增', '年增', '季增'];
  const NEG = ['衰退', '下滑', '下修', '調降', '低於預期', '不如預期', '疲弱', '大跌', '跌停', '重挫', '崩', '虧損', '轉虧', '利空', '賣超', '減碼', '悲觀', '放緩', '砍單', '延後', '庫存', '去化', '壓力', '風險', '不確定', '審慎', '保守', '警訊', '裁員', '訴訟', '罰', '停工', '跌破', '下跌', '走弱', '疑慮', '看空', '空頭', '年減', '季減', '失守', '跳水', '賣壓', '降評', '目標價下調', '地緣政治', '關稅'];
  const NEGATORS = ['不', '未', '沒有', '無', '非', '免'];
  const VOCAB = ['營收', '毛利率', '獲利', 'EPS', '法說會', '財報', '外資', '投信', '自營商', '法人', '目標價', '股利', '除息', '殖利率', '本益比', 'AI', '伺服器', '半導體', '晶圓', '先進製程', 'CoWoS', '封裝', '記憶體', 'DRAM', '面板', '電動車', '航運', '運價', '貨櫃', '金控', '升息', '降息', '匯率', '美元', '新台幣', '關稅', '川普', '輝達', 'NVIDIA', '蘋果', 'iPhone', '庫存', '擴產', '新廠', '資本支出', '訂單', '客戶', '需求', '漲價', '降價', '併購', '董事會', '股東會', '庫藏股', '增資', '減資', 'ETF', '台股', '加權指數', '季線', '月線', '融資', '融券', '當沖', '大盤', '美股', '費半', '景氣', '通膨', '出口', '中國', '美國', '日本', '歐洲'];

  function dictScore(text) {
    const pos = [], neg = [];
    const scan = (words, mine, other) => words.forEach((w) => { let i = text.indexOf(w); while (i >= 0) { const before = text.slice(Math.max(0, i - 2), i); (NEGATORS.some((n) => before.includes(n)) ? other : mine).push(w); i = text.indexOf(w, i + w.length); } });
    scan(POS, pos, neg); scan(NEG, neg, pos);
    const p = pos.length, n = neg.length;
    let probs;
    if (!p && !n) probs = { pos: 0.15, neu: 0.7, neg: 0.15 };
    else { const lean = (p - n) / (p + n); probs = { pos: Math.max(0.05, 0.45 + 0.45 * lean), neg: Math.max(0.05, 0.45 - 0.45 * lean) }; probs.neu = Math.max(0, 1 - probs.pos - probs.neg); }
    for (const k in probs) probs[k] = Math.round(probs[k] * 1000) / 1000;
    return { probs, hits: { pos: [...new Set(pos)].sort(), neg: [...new Set(neg)].sort() } };
  }
  const labelOf = (p) => Object.keys(p).reduce((a, b) => (p[b] > p[a] ? b : a));
  const keywords = (text, exclude) => [...new Set(VOCAB.concat(POS, NEG).filter((w) => text.includes(w) && !exclude.some((x) => x && (w.includes(x) || x.includes(w)))))].slice(0, 8);

  // ---------------------------------------------------------------- 逐句分析（判斷依據）
  const BOILER = /訂閱|版權|著作權|延伸閱讀|責任編輯|免責|下載|加入.*(LINE|Line|好友)|©|請點|點我|追蹤我們|廣告|看更多|圖／|圖\/|記者.{0,6}／|本文不代表/;
  function splitSentences(text, limit = 25) {
    const out = [];
    for (let s of text.split(/(?<=[。！？!?；])|\n+/)) {
      s = s.replace(/\s+/g, ' ').trim();
      if (s.length >= 10 && s.length <= 160 && !BOILER.test(s) && !out.includes(s)) out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }
  function analyzeBody(a, sentences) {
    a.bodyTried = true;
    if (!sentences.length) return;
    const probs = sentences.map((s) => dictScore(s).probs), t = a.scores;
    const mean = {}; ['pos', 'neu', 'neg'].forEach((k) => (mean[k] = probs.reduce((x, p) => x + p[k], 0) / probs.length));
    const combo = {}; ['pos', 'neu', 'neg'].forEach((k) => (combo[k] = Math.round((0.4 * t[k] + 0.6 * mean[k]) * 1000) / 1000));
    a.scores = combo; a.sentiment = labelOf(combo);
    const sp = Math.max(...probs.map((p) => p.pos)), sn = Math.max(...probs.map((p) => p.neg));
    if (a.sentiment === 'neu' && Math.max(sp, sn) > 0.8 && Math.abs(sp - sn) > 0.3) a.sentiment = sp > sn ? 'pos' : 'neg';
    const lab = a.sentiment;
    a.evidence = sentences.map((s, i) => [s, probs[i]]).sort((x, y) => y[1][lab] - x[1][lab]).slice(0, 3)
      .filter(([, p]) => lab === 'neu' || p[lab] >= 0.4)
      .map(([s, p]) => ({ text: s, label: labelOf(p), p: Math.round(p[lab] * 1000) / 1000, hits: dictScore(s).hits }));
    a.nSentences = sentences.length;
  }
  function extractText(html, url) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,nav,footer,aside,header,form,figure,noscript').forEach((e) => e.remove());
    if (url.includes('ptt.cc')) {
      const m = doc.querySelector('#main-content'); if (!m) return '';
      m.querySelectorAll('.article-metaline,.article-metaline-right,.push,span.f2').forEach((e) => e.remove());
      return m.textContent.split('--\n※')[0];
    }
    const root = doc.querySelector('.caas-body') || doc.querySelector('[itemprop=articleBody]') || doc.querySelector('#article-container') || doc.querySelector('article') || doc.querySelector('main') || doc.body;
    return [...root.querySelectorAll('p')].map((p) => p.textContent.trim()).filter((p) => p.length >= 15 && !BOILER.test(p)).join('\n');
  }
  async function articleText(a) {
    try {
      const m = /news\.cnyes\.com\/news\/id\/(\d+)/.exec(a.url);
      if (m) { const j = await fetchJSON('https://api.cnyes.com/media/api/v1/news/' + m[1], 12000); const it = j.items || j.data || {}; return extractText('<article>' + (it.content || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') + '</article>', a.url); }
      if (a.url.includes('news.google.com')) return '';   // Google 轉址無法在瀏覽器解開
      return extractText(await fetchText(a.url, (t) => t.length > 200, 12000), a.url);
    } catch (e) { return ''; }
  }

  // ---------------------------------------------------------------- 資料來源
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };
  const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  function parseRSS(xml, prefix, defSource) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml'), out = [];
    doc.querySelectorAll('item').forEach((it) => {
      const g = (t) => it.querySelector(t)?.textContent || '';
      let title = clean(g('title')); const link = g('link').trim(); const srcEl = it.querySelector('source');
      const source = srcEl ? clean(srcEl.textContent) : defSource, srcUrl = srcEl ? srcEl.getAttribute('url') || '' : link;
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(' - ' + source).length);
      const d = new Date(g('pubDate')); if (isNaN(d)) return;
      const m = canon(source, srcUrl); if (!m || !title) return;
      out.push({ id: prefix + hash(link || title), title, url: link, source: m[0], channel: m[1], date: d.toISOString(), summary: prefix === 'y' ? clean(g('description')).slice(0, 160) : '', views: null, push: null });
    });
    return out;
  }
  const isRSS = (t) => /<rss|<item>/i.test(t);
  const FIN_SITES = ['money.udn.com', 'ctee.com.tw', 'news.cnyes.com', 'moneydj.com', 'cna.com.tw', 'ltn.com.tw', 'wealth.com.tw', 'businesstoday.com.tw', 'digitimes.com', 'technews.tw'];
  async function googleNews(name, code, days) {
    const base = name !== code ? `"${name}"` : `${code} 股票`;
    const qs = [`${base} when:${days}d`, `${base} (${FIN_SITES.map((s) => 'site:' + s).join(' OR ')}) when:${days}d`];
    const res = await Promise.allSettled(qs.map((q) => fetchText('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', isRSS)));
    const out = res.filter((r) => r.status === 'fulfilled').flatMap((r) => parseRSS(r.value, 'g', ''));
    if (!out.length && res.every((r) => r.status === 'rejected')) throw new Error('Google 新聞');
    return out;
  }
  async function yahooNews(code, days) {
    const since = Date.now() - days * 864e5;
    for (const sym of [code + '.TW', code + '.TWO']) {
      try { const items = parseRSS(await fetchText('https://tw.stock.yahoo.com/rss?s=' + sym, isRSS), 'y', 'Yahoo股市').filter((a) => new Date(a.date) >= since); if (items.length) return items; } catch (e) {}
    }
    throw new Error('Yahoo 股市');
  }
  async function cnyesNews(name, days) {
    const since = Date.now() / 1000 - days * 86400;
    const j = await fetchJSON('https://ess.api.cnyes.com/ess/api/v1/news/keyword?q=' + encodeURIComponent(name) + '&limit=50&page=1');
    const find = (o) => (Array.isArray(o) ? o : o && typeof o === 'object' ? ['items', 'data', 'news'].map((k) => find(o[k])).find((x) => x && x.length) : null);
    return (find(j) || []).filter((it) => it.newsId && it.title && it.publishAt >= since).map((it) => ({
      id: 'c' + it.newsId, title: clean(it.title), url: 'https://news.cnyes.com/news/id/' + it.newsId, source: '鉅亨網', channel: '財經媒體',
      date: new Date(it.publishAt * 1000).toISOString(), summary: clean(it.summary).slice(0, 160),
      views: ['hitCount', 'hit', 'viewCount', 'views', 'pageView', 'pv'].map((k) => it[k]).find((v) => v != null) ?? null, push: null,
    }));
  }
  async function ptt(name, days) {
    const out = [], now = new Date(), since = Date.now() - days * 864e5;
    for (let p = 1; p <= 2; p++) {
      const html = await fetchText(`https://www.ptt.cc/bbs/Stock/search?page=${p}&q=${encodeURIComponent(name)}`, (t) => t.includes('r-ent') || t.includes('沒有'));
      const doc = new DOMParser().parseFromString(html, 'text/html'), rows = doc.querySelectorAll('div.r-ent');
      if (!rows.length) break;
      let stop = false;
      rows.forEach((r) => {
        const a = r.querySelector('div.title a'); if (!a) return;
        const [m, d] = r.querySelector('div.date').textContent.trim().split('/').map(Number);
        let dt = new Date(now.getFullYear(), m - 1, d, 12); if (dt > now.getTime() + 864e5) dt.setFullYear(now.getFullYear() - 1);
        if (dt < since) { stop = true; return; }
        const nrec = r.querySelector('div.nrec').textContent.trim();
        const push = nrec === '爆' ? 100 : nrec.startsWith('X') ? -(parseInt(nrec.slice(1)) || 10) : parseInt(nrec) || 0;
        const href = 'https://www.ptt.cc' + a.getAttribute('href');
        out.push({ id: 'p' + hash(href), title: a.textContent.trim(), url: href, source: 'PTT 股板', channel: '論壇', date: dt.toISOString(), summary: '', views: null, push });
      });
      if (stop) break;
    }
    return out;
  }
  async function prices(code) {
    for (const [suf, mk] of [['.TW', 'TWSE'], ['.TWO', 'TPEx']]) {
      try {
        const j = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${code}${suf}?range=1y&interval=1d`);
        const res = j.chart.result[0], q = res.indicators.quote[0], rows = [];
        (res.timestamp || []).forEach((ts, i) => { const c = q.close[i]; if (c == null) return; const d = new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10); const r2 = (x) => Math.round((x ?? c) * 100) / 100; rows.push({ d, o: r2(q.open[i]), h: r2(q.high[i]), l: r2(q.low[i]), c: r2(c), v: Math.round((q.volume[i] || 0) / 1000) }); });
        if (!rows.length) continue;
        const price = res.meta.regularMarketPrice || rows.at(-1).c, prev = rows.length > 1 ? rows.at(-2).c : price;
        return { rows, market: mk, quote: { price, prevClose: prev, change: Math.round((price - prev) * 100) / 100, changePct: prev ? Math.round(((price - prev) / prev) * 10000) / 100 : 0, time: new Date((res.meta.regularMarketTime || Date.now() / 1000) * 1000).toISOString(), source: 'Yahoo Finance' } };
      } catch (e) {}
    }
    throw new Error('股價');
  }
  let VAL = null;
  async function valuation(code) {
    if (!VAL) { try { VAL = await (await fetch('data/valuation.json')).json(); } catch (e) { VAL = {}; } }
    const v = VAL[code] || {}, num = (x) => (x == null || x === '' || isNaN(parseFloat(x)) ? null : parseFloat(x));
    return { pe: num(v.pe), yield: num(v.yield), pb: num(v.pb) };
  }

  // ---------------------------------------------------------------- 主流程
  async function collect(stock, progress = () => {}) {
    await loadMedia();
    const days = 90, errors = [];
    progress('正在透過公共轉址服務抓取新聞、PTT 與股價…');
    const settle = (p, label) => p.catch((e) => { errors.push(label + '：無法取得'); return null; });
    const [g, y, cn, pt, pr, val] = await Promise.all([
      settle(googleNews(stock.name, stock.code, days), 'Google 新聞'), settle(yahooNews(stock.code, days), 'Yahoo 股市'),
      settle(cnyesNews(stock.name, days), '鉅亨網'), settle(ptt(stock.name, days), 'PTT'), settle(prices(stock.code), '股價'), valuation(stock.code),
    ]);
    // 去重：同標題留可直接開啟的版本
    const seen = new Set(), all = [];
    [...(cn || []), ...(y || []), ...(g || []), ...(pt || [])].sort((a, b) => (a.url.includes('news.google.com') - b.url.includes('news.google.com'))).forEach((a) => {
      const k = a.title.replace(/[\s\p{P}\p{S}_]+/gu, '').slice(0, 40); if (k && !seen.has(k)) { seen.add(k); all.push(a); }
    });
    all.sort((a, b) => (a.date < b.date ? 1 : -1));
    const exclude = [stock.name, stock.code, stock.name.slice(0, 2)];
    all.forEach((a) => { const t = (a.title + '。' + a.summary).slice(0, 300), d = dictScore(t); Object.assign(a, { scores: d.probs, sentiment: labelOf(d.probs), dictSentiment: labelOf(d.probs), hints: d.hits, keywords: keywords(t, exclude), model: 'dict' }); });
    // 正負面最新各 6 篇抓內文、逐句分析
    const since30 = Date.now() - 30 * 864e5, todo = [];
    ['pos', 'neg'].forEach((lab) => todo.push(...all.filter((a) => a.sentiment === lab && new Date(a.date) >= since30 && !a.url.includes('news.google.com')).slice(0, 6)));
    if (todo.length) {
      progress(`正在讀取 ${todo.length} 篇熱門文章內文，逐句找出判斷依據…`);
      const texts = await Promise.all(todo.map(articleText));
      todo.forEach((a, i) => analyzeBody(a, splitSentences(texts[i])));
    }
    if (!all.length && !pr) throw new Error('所有來源都抓不到（' + errors.join('、') + '）。公共轉址服務可能暫時失效，請稍後再試');
    return {
      code: stock.code, name: stock.name, market: pr ? pr.market : stock.market, articles: all,
      prices: pr ? pr.rows : [], quote: pr ? pr.quote : {}, valuation: val, errors,
      model: '金融字典法（即時抓取，非 FinBERT）', days, fetchedAt: new Date().toISOString(), mode: 'live',
    };
  }
  return { collect, canon, loadMedia };
})();
