"""資料來源：新聞（Google 新聞 RSS、鉅亨網）、論壇（PTT 股板）、股價（Yahoo Finance / TWSE）、股票清單與估值。

所有函式都「失敗不拋例外」：抓不到就回傳空資料並把錯誤記在 errors，讓網站其他部分照常運作。
"""
from __future__ import annotations

import asyncio
import email.utils
import hashlib
import html
import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
from xml.etree import ElementTree as ET

import httpx
from bs4 import BeautifulSoup

TW = timezone(timedelta(hours=8))
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}
TIMEOUT = httpx.Timeout(12.0, connect=6.0)
DATA_DIR = Path(__file__).parent


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(headers=UA, timeout=TIMEOUT, follow_redirects=True)


def _id(*parts: str) -> str:
    return hashlib.md5("|".join(parts).encode()).hexdigest()[:12]


def _clean(s: str | None) -> str:
    if not s:
        return ""
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", " ", s).strip()


def _to_int(x) -> int | None:
    try:
        return int(str(x).replace(",", ""))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- 股票清單
_stock_cache: dict = {"t": 0, "list": []}


def _fallback_stocks() -> list[dict]:
    try:
        return json.loads((DATA_DIR / "stocks.json").read_text(encoding="utf-8"))
    except Exception:
        return []


async def stock_list() -> list[dict]:
    """上市（TWSE）＋上櫃（TPEx）完整清單，一天更新一次；抓不到就用內建熱門清單。"""
    if _stock_cache["list"] and time.time() - _stock_cache["t"] < 86400:
        return _stock_cache["list"]
    merged: dict[str, dict] = {s["code"]: s for s in _fallback_stocks()}
    async with client() as c:
        try:
            r = await c.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL")
            for row in r.json():
                code, name = row.get("Code"), row.get("Name")
                if code and name:
                    merged[code] = {"code": code, "name": name.strip(), "market": "TWSE"}
        except Exception:
            pass
        try:
            r = await c.get("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes")
            for row in r.json():
                code, name = row.get("SecuritiesCompanyCode"), row.get("CompanyName")
                if code and name:
                    merged[code] = {"code": code, "name": name.strip(), "market": "TPEx"}
        except Exception:
            pass
    _stock_cache.update(t=time.time(), list=sorted(merged.values(), key=lambda s: s["code"]))
    return _stock_cache["list"]


async def resolve(query: str) -> dict | None:
    q = query.strip().upper().replace(".TW", "").replace(".TWO", "")
    stocks = await stock_list()
    for s in stocks:
        if s["code"] == q or s["name"] == query.strip():
            return s
    for s in stocks:
        if query.strip() in s["name"]:
            return s
    if re.fullmatch(r"\d{4,6}[A-Z]?", q):
        return {"code": q, "name": q, "market": "TWSE"}
    return None


async def search_stocks(query: str, limit: int = 10) -> list[dict]:
    q = query.strip()
    if not q:
        return []
    stocks = await stock_list()
    starts = [s for s in stocks if s["code"].startswith(q.upper()) or s["name"].startswith(q)]
    contains = [s for s in stocks if s not in starts and q in s["name"]]
    return (starts + contains)[:limit]


# ---------------------------------------------------------------- 知名媒體白名單
MEDIA = json.loads((Path(__file__).parent / "site" / "media.json").read_text(encoding="utf-8"))
FINANCE_SITES = ["money.udn.com", "ctee.com.tw", "news.cnyes.com", "moneydj.com", "cna.com.tw",
                 "ltn.com.tw", "wealth.com.tw", "businesstoday.com.tw", "digitimes.com", "technews.tw"]


def canon(source: str, url: str = "") -> tuple[str, str] | None:
    """把來源名稱對應到白名單媒體 → (正式名稱, 類別)；不在白名單回傳 None。"""
    text = f"{source} {url}"
    for name, group, keys in MEDIA:
        if any(k.lower() in text.lower() for k in keys):
            return name, group
    return None


def _parse_rss(content: bytes, prefix: str, default_source: str = "") -> list[dict]:
    root = ET.fromstring(content)
    out = []
    for item in root.iter("item"):
        title = _clean(item.findtext("title"))
        link = item.findtext("link") or ""
        src_el = item.find("source")
        source = _clean(src_el.text) if src_el is not None else default_source
        src_url = src_el.get("url", "") if src_el is not None else link
        if source and title.endswith(" - " + source):
            title = title[: -len(" - " + source)]
        try:
            dt = email.utils.parsedate_to_datetime(item.findtext("pubDate")).astimezone(TW)
        except Exception:
            continue
        m = canon(source, src_url)
        if not m or not title:
            continue
        out.append({
            "id": _id(prefix, link or title), "title": title, "url": link,
            "source": m[0], "channel": m[1], "date": dt.isoformat(),
            "summary": _clean(item.findtext("description"))[:160] if prefix == "y" else "",
            "views": None, "push": None,
        })
    return out


# ---------------------------------------------------------------- 新聞：Google 新聞 RSS（只留白名單媒體）
async def google_news(name: str, code: str, days: int) -> tuple[list[dict], str | None]:
    base = f'"{name}"' if name != code else f"{code} 股票"
    queries = [
        f"{base} when:{days}d",
        f"{base} ({' OR '.join('site:' + s for s in FINANCE_SITES)}) when:{days}d",
    ]
    out, err = [], None
    async with client() as c:
        for q in queries:
            try:
                r = await c.get("https://news.google.com/rss/search?q=" + quote(q) + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant")
                r.raise_for_status()
                out += _parse_rss(r.content, "g")
            except Exception as e:
                err = f"Google 新聞：{type(e).__name__}"
    return out, (err if not out else None)


# ---------------------------------------------------------------- 新聞：Yahoo 股市個股新聞 RSS
async def yahoo_news(code: str, days: int) -> tuple[list[dict], str | None]:
    since = (datetime.now(TW) - timedelta(days=days)).isoformat()
    async with client() as c:
        for sym in (f"{code}.TW", f"{code}.TWO", code):
            try:
                r = await c.get(f"https://tw.stock.yahoo.com/rss?s={sym}")
                if r.status_code != 200 or b"<item>" not in r.content:
                    continue
                items = [a for a in _parse_rss(r.content, "y", "Yahoo股市") if a["date"] >= since]
                if items:
                    return items, None
            except Exception:
                continue
    return [], "Yahoo 股市：無法取得"


# ---------------------------------------------------------------- 文章內文（用來找判斷依據句）
BOILER = re.compile(r"訂閱|版權|著作權|延伸閱讀|責任編輯|免責|下載|加入.*(LINE|Line|好友)|©|請點|點我|追蹤我們|廣告|看更多|圖／|圖/|記者.{0,6}／|本文不代表")


def _decode_gnews(url: str) -> str:
    """Google 新聞的連結是轉址，要先解回原始新聞網址才能抓內文。"""
    if "news.google.com" not in url:
        return url
    try:
        from googlenewsdecoder import gnewsdecoder
        res = gnewsdecoder(url, interval=1)
        if res.get("success") or res.get("status"):
            return res.get("decoded_url") or url
    except Exception:
        pass
    return url


def extract_text(html_text: str, url: str) -> str:
    soup = BeautifulSoup(html_text, "html.parser")
    for t in soup(["script", "style", "nav", "footer", "aside", "header", "form", "figure", "noscript"]):
        t.decompose()
    if "ptt.cc" in url:
        main = soup.select_one("#main-content")
        if not main:
            return ""
        for t in main.select(".article-metaline, .article-metaline-right, .push, span.f2"):
            t.decompose()
        return main.get_text("\n").split("--\n※")[0]
    root = (soup.select_one(".caas-body") or soup.select_one("[itemprop=articleBody]") or soup.select_one("#article-container")
            or soup.select_one("article") or soup.select_one("main") or soup)
    paras = [p.get_text(" ", strip=True) for p in root.find_all("p")]
    paras = [p for p in paras if len(p) >= 15 and not BOILER.search(p)]
    return "\n".join(paras)


def split_sentences(text: str, limit: int = 25) -> list[str]:
    out = []
    for s in re.split(r"(?<=[。！？!?；])|\n+", text):
        s = re.sub(r"\s+", " ", s).strip(" 　")
        if 10 <= len(s) <= 160 and not BOILER.search(s) and s not in out:
            out.append(s)
        if len(out) >= limit:
            break
    return out


async def article_text(c: httpx.AsyncClient, a: dict) -> str:
    url = a["url"]
    try:
        m = re.search(r"news\.cnyes\.com/news/id/(\d+)", url)
        if m:
            r = await c.get(f"https://api.cnyes.com/media/api/v1/news/{m.group(1)}")
            item = r.json().get("items") or r.json().get("data") or {}
            return extract_text(f"<article>{html.unescape(item.get('content', ''))}</article>", url)
        url = await asyncio.to_thread(_decode_gnews, url)
        if "news.google.com" in url:
            return ""
        r = await c.get(url)
        if r.status_code != 200:
            return ""
        return extract_text(r.text, url)
    except Exception:
        return ""


# ---------------------------------------------------------------- 給網頁用的全市場資料（每天產生一次）
async def all_valuations() -> dict:
    await valuation("2330")
    return _val_cache["map"]


# ---------------------------------------------------------------- 新聞：鉅亨網
_VIEW_KEYS = ("hitCount", "hit", "viewCount", "views", "pageView", "pv", "clickCount")


def _cnyes_items(data) -> list:
    if isinstance(data, dict):
        for k in ("items", "data", "news"):
            v = data.get(k)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):
                got = _cnyes_items(v)
                if got:
                    return got
    return []


async def cnyes_news(name: str, days: int) -> tuple[list[dict], str | None]:
    endpoints = [
        f"https://ess.api.cnyes.com/ess/api/v1/news/keyword?q={quote(name)}&limit=50&page=1",
        f"https://api.cnyes.com/media/api/v1/search?q={quote(name)}&limit=50&page=1",
    ]
    since = datetime.now(TW) - timedelta(days=days)
    async with client() as c:
        for url in endpoints:
            try:
                r = await c.get(url)
                r.raise_for_status()
                items = _cnyes_items(r.json())
            except Exception:
                continue
            out = []
            for it in items:
                nid, title = it.get("newsId"), _clean(it.get("title"))
                ts = it.get("publishAt")
                if not (nid and title and ts):
                    continue
                dt = datetime.fromtimestamp(int(ts), TW)
                if dt < since:
                    continue
                views = next((_to_int(it[k]) for k in _VIEW_KEYS if k in it), None)
                out.append({
                    "id": _id("c", str(nid)),
                    "title": title,
                    "url": f"https://news.cnyes.com/news/id/{nid}",
                    "source": "鉅亨網",
                    "channel": "財經媒體",
                    "date": dt.isoformat(),
                    "summary": _clean(it.get("summary"))[:160],
                    "views": views,
                    "push": None,
                })
            if out:
                return out, None
    return [], "鉅亨網：無法取得"


# ---------------------------------------------------------------- 論壇：PTT 股板
def _ptt_push(text: str) -> int:
    text = text.strip()
    if text == "爆":
        return 100
    if text.startswith("X"):
        return -10 if text == "XX" else -_to_int(text[1:] or "1") or -1
    return _to_int(text) or 0


async def ptt_stock(name: str, days: int, pages: int = 3) -> tuple[list[dict], str | None]:
    out, now = [], datetime.now(TW)
    since = now - timedelta(days=days)
    try:
        async with client() as c:
            c.cookies.set("over18", "1", domain=".ptt.cc")
            for p in range(1, pages + 1):
                r = await c.get(f"https://www.ptt.cc/bbs/Stock/search?page={p}&q={quote(name)}")
                if r.status_code != 200:
                    break
                soup = BeautifulSoup(r.text, "html.parser")
                rows = soup.select("div.r-ent")
                if not rows:
                    break
                stop = False
                for row in rows:
                    a = row.select_one("div.title a")
                    if not a:
                        continue
                    m, d = (row.select_one("div.date").text.strip() + "/").split("/")[:2]
                    dt = datetime(now.year, int(m), int(d), 12, tzinfo=TW)
                    if dt > now + timedelta(days=1):
                        dt = dt.replace(year=now.year - 1)
                    if dt < since:
                        stop = True
                        continue
                    href = "https://www.ptt.cc" + a["href"]
                    out.append({
                        "id": _id("p", href),
                        "title": a.text.strip(),
                        "url": href,
                        "source": "PTT 股板",
                        "channel": "論壇",
                        "date": dt.isoformat(),
                        "summary": "",
                        "views": None,
                        "push": _ptt_push(row.select_one("div.nrec").text),
                    })
                if stop:
                    break
    except Exception as e:
        return out, f"PTT：{type(e).__name__}"
    return out, None


# ---------------------------------------------------------------- 股價
async def _yahoo(code: str) -> tuple[list[dict], dict, str] | None:
    async with client() as c:
        for suffix in (".TW", ".TWO"):
            try:
                r = await c.get(
                    f"https://query1.finance.yahoo.com/v8/finance/chart/{code}{suffix}",
                    params={"range": "1y", "interval": "1d"},
                )
                res = r.json()["chart"]["result"][0]
                q = res["indicators"]["quote"][0]
                rows = []
                for i, ts in enumerate(res.get("timestamp") or []):
                    cl = q["close"][i]
                    if cl is None:
                        continue
                    rows.append({
                        "d": datetime.fromtimestamp(ts, TW).strftime("%Y-%m-%d"),
                        "o": round(q["open"][i] or cl, 2), "h": round(q["high"][i] or cl, 2),
                        "l": round(q["low"][i] or cl, 2), "c": round(cl, 2),
                        "v": int((q["volume"][i] or 0) / 1000),  # 張
                    })
                if rows:
                    return rows, res.get("meta", {}), "TWSE" if suffix == ".TW" else "TPEx"
            except Exception:
                continue
    return None


async def _twse(code: str, months: int = 6) -> list[dict]:
    rows, today = [], datetime.now(TW)
    async with client() as c:
        for k in range(months - 1, -1, -1):
            y, m = today.year, today.month - k
            while m <= 0:
                y, m = y - 1, m + 12
            try:
                r = await c.get(
                    "https://www.twse.com.tw/exchangeReport/STOCK_DAY",
                    params={"response": "json", "date": f"{y}{m:02d}01", "stockNo": code},
                )
                for f in r.json().get("data", []):
                    ry, rm, rd = f[0].split("/")
                    num = lambda s: float(s.replace(",", "")) if s.replace(",", "").replace(".", "").isdigit() else None
                    cl = num(f[6])
                    if cl is None:
                        continue
                    rows.append({
                        "d": f"{int(ry) + 1911}-{rm}-{rd}",
                        "o": num(f[3]) or cl, "h": num(f[4]) or cl, "l": num(f[5]) or cl, "c": cl,
                        "v": int(int(f[1].replace(",", "")) / 1000),
                    })
            except Exception:
                continue
            await asyncio.sleep(0.3)  # TWSE 對頻繁請求很敏感
    return rows


async def prices(code: str) -> tuple[list[dict], dict, str | None, str | None]:
    """回傳 (日K, 即時報價, 市場別, 錯誤)。"""
    y = await _yahoo(code)
    if y:
        rows, meta, market = y
        price = meta.get("regularMarketPrice") or rows[-1]["c"]
        prev = rows[-2]["c"] if len(rows) > 1 else meta.get("chartPreviousClose") or price
        quote_ = {
            "price": round(price, 2), "prevClose": round(prev, 2),
            "change": round(price - prev, 2),
            "changePct": round((price - prev) / prev * 100, 2) if prev else 0,
            "time": datetime.fromtimestamp(meta.get("regularMarketTime", time.time()), TW).isoformat(),
            "source": "Yahoo Finance",
        }
        return rows, quote_, market, None
    rows = await _twse(code)
    if rows:
        p, prev = rows[-1]["c"], rows[-2]["c"] if len(rows) > 1 else rows[-1]["c"]
        return rows, {
            "price": p, "prevClose": prev, "change": round(p - prev, 2),
            "changePct": round((p - prev) / prev * 100, 2) if prev else 0,
            "time": rows[-1]["d"], "source": "臺灣證券交易所",
        }, "TWSE", None
    return [], {}, None, "股價：Yahoo 與證交所皆無法取得"


# ---------------------------------------------------------------- 估值（本益比、殖利率、股價淨值比）
_val_cache: dict = {"t": 0, "map": {}}


async def valuation(code: str) -> dict:
    if not _val_cache["map"] or time.time() - _val_cache["t"] > 6 * 3600:
        m: dict[str, dict] = {}
        async with client() as c:
            try:
                r = await c.get("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL")
                for row in r.json():
                    m[row["Code"]] = {
                        "pe": row.get("PEratio"), "yield": row.get("DividendYield"),
                        "pb": row.get("PBratio"),
                    }
            except Exception:
                pass
            try:
                r = await c.get("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis")
                for row in r.json():
                    m[row["SecuritiesCompanyCode"]] = {
                        "pe": row.get("PriceEarningRatio"), "yield": row.get("YieldRatio"),
                        "pb": row.get("PriceBookRatio"),
                    }
            except Exception:
                pass
        if m:
            _val_cache.update(t=time.time(), map=m)
    v = _val_cache["map"].get(code, {})
    num = lambda s: float(s) if s not in (None, "", "-", "N/A") and re.fullmatch(r"-?\d+(\.\d+)?", str(s)) else None
    return {k: num(v.get(k)) for k in ("pe", "yield", "pb")}


# ---------------------------------------------------------------- 彙整
def dedupe(articles: list[dict]) -> list[dict]:
    """同標題只留一篇：優先保留有瀏覽量、可直接開啟原文（非 Google 轉址）的版本。"""
    seen, out = set(), []
    rank = lambda a: (a["views"] is None, "news.google.com" in (a["url"] or ""), a["date"])
    for a in sorted(articles, key=rank):
        key = re.sub(r"[\s\W_]+", "", a["title"])[:40]
        if key and key not in seen:
            seen.add(key)
            out.append(a)
    return sorted(out, key=lambda a: a["date"], reverse=True)


async def collect(stock: dict, days: int) -> dict:
    name, code = stock["name"], stock["code"]
    (g, ge), (y, ye), (cn, ce), (pt, pe), (rows, quote_, market, qe), val = await asyncio.gather(
        google_news(name, code, days), yahoo_news(code, days), cnyes_news(name, days), ptt_stock(name, days),
        prices(code), valuation(code),
    )
    errors = [e for e in (ge, ye, ce, pe, qe) if e]
    return {
        "code": code, "name": name, "market": market or stock.get("market"),
        "articles": dedupe(cn + y + g + pt), "prices": rows, "quote": quote_,
        "valuation": val, "errors": errors,
    }
