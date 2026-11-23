"""每日更新：依 watchlist.txt 抓新聞、PTT、股價與估值，跑 FinBERT，寫入 site/data/。

由 GitHub Actions 每天自動執行，也可以在自己電腦手動跑：python update_data.py
- 第一次抓近 90 天；之後每次抓近 14 天，並與舊資料合併（保留 120 天），所以歷史會越累積越完整。
- 某個來源抓不到時保留舊資料，不會把網站清空。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path

import market
import sentiment
import sources

ROOT = Path(__file__).parent
OUT = ROOT / "site" / "data"
KEEP_DAYS = 120


def read_watchlist() -> list[tuple[str, str | None]]:
    out = []
    for line in (ROOT / "watchlist.txt").read_text(encoding="utf-8").splitlines():
        line = line.split("#")[0].strip()
        if not line:
            continue
        parts = line.split(maxsplit=1)
        out.append((parts[0].upper(), parts[1].strip() if len(parts) > 1 else None))
    return out


def title_key(t: str) -> str:
    return re.sub(r"[\s\W_]+", "", t)[:40]


def recanon(arts: list[dict]) -> list[dict]:
    """舊資料也套用知名媒體白名單（舊版資料沒有分類）。"""
    out = []
    for a in arts:
        if a["channel"] == "論壇":
            out.append(a)
            continue
        m = sources.canon(a["source"], a.get("url", ""))
        if m:
            a["source"], a["channel"] = m
            out.append(a)
    return out


async def body_pass(articles: list[dict], now: datetime, per_label: int = 8) -> int:
    """替最近 30 天、正負面各最新 8 篇抓內文並逐句分析（已分析過的跳過）。"""
    since = (now - timedelta(days=30)).isoformat()
    todo = []
    for lab in ("pos", "neg"):
        group = [a for a in articles if a["sentiment"] == lab and a["date"] >= since]
        todo += [a for a in group[:per_label] if not a.get("bodyTried")]
    if not todo:
        return 0
    sem = asyncio.Semaphore(5)
    async with sources.client() as c:
        async def one(a):
            async with sem:
                return await sources.article_text(c, a)
        texts = await asyncio.gather(*(one(a) for a in todo))
    got = 0
    for a, t in zip(todo, texts):
        sents = sources.split_sentences(t)
        await asyncio.to_thread(sentiment.analyze_body, a, sents)
        got += bool(sents)
    return got


async def update_one(code: str, name: str | None, now: datetime) -> dict | None:
    stock = await sources.resolve(code)
    if not stock:
        print(f"  ✗ {code}：找不到這個代號")
        return None
    if name and stock["name"] == stock["code"]:
        stock["name"] = name
    path = OUT / "s" / f"{stock['code']}.json"
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    days = 14 if old else 90

    new = await sources.collect(stock, days)
    # 合併文章：舊的保留（含已算好的情緒），只對新文章跑模型
    known_ids = {a["id"] for a in old["articles"]} if old else set()
    known_titles = {title_key(a["title"]) for a in old["articles"]} if old else set()
    fresh = [a for a in new["articles"] if a["id"] not in known_ids and title_key(a["title"]) not in known_titles]
    model = sentiment.analyze_articles(fresh, stock["name"], stock["code"]) if fresh else (old or {}).get("model", "")
    for a in fresh:
        a["model"] = "finbert" if model.startswith("FinBERT") else "dict"
    cutoff = (now - timedelta(days=KEEP_DAYS)).isoformat()
    articles = [a for a in fresh + recanon(old["articles"] if old else []) if a["date"] >= cutoff]
    articles.sort(key=lambda a: a["date"], reverse=True)
    bodies = await body_pass(articles, now)

    data = {
        "code": stock["code"], "name": stock["name"], "market": new["market"],
        "articles": articles,
        "prices": new["prices"] or (old or {}).get("prices", []),
        "quote": new["quote"] or (old or {}).get("quote", {}),
        "valuation": new["valuation"] if any(v is not None for v in new["valuation"].values()) else (old or {}).get("valuation", {}),
        "errors": new["errors"], "model": model or "—", "days": KEEP_DAYS,
        "fetchedAt": now.isoformat(timespec="seconds"), "mode": "daily",
    }
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  ✓ {stock['code']} {stock['name']}：新文章 {len(fresh)}、累積 {len(articles)}、內文 {bodies} 篇、股價 {len(data['prices'])} 天"
          + (f"（{'；'.join(new['errors'])}）" if new["errors"] else ""))
    return data


async def main():
    OUT.joinpath("s").mkdir(parents=True, exist_ok=True)
    now = datetime.now(sources.TW)
    auto_top, auto_etf = int(os.getenv("AUTO_TOP", "100")), int(os.getenv("AUTO_ETF", "10"))

    # 追蹤清單 = watchlist.txt ＋ 當日成交值前 N 大個股 ＋ 前 M 大 ETF
    all_list = await sources.stock_list()
    by_code = {s["code"]: s for s in all_list}
    manual = read_watchlist()
    ranked = sorted(all_list, key=lambda s: s.get("value", 0), reverse=True)
    top_stocks = [s["code"] for s in ranked if s["type"] == "股票" and s.get("value")][:auto_top]
    top_etfs = [s["code"] for s in ranked if s["type"] == "ETF" and s.get("value")][:auto_etf]
    tracked: dict[str, dict] = {}
    for code, name in manual:
        tracked[code] = {"name": name, "auto": False}
    for code in top_stocks + top_etfs:
        tracked.setdefault(code, {"name": None, "auto": True})
    print(f"追蹤 {len(tracked)} 檔（手動 {len(manual)}、熱門個股 {len(top_stocks)}、熱門 ETF {len(top_etfs)}），等待 FinBERT 載入…")

    ok = await asyncio.to_thread(sentiment.finbert.wait, float(os.getenv("MODEL_WAIT", "900")))
    print("情緒模型：", "FinBERT" if ok else f"字典法（{sentiment.finbert.error}）")
    inds = await market.industries()
    print(f"產業分類：{len(inds)} 檔")

    def entry(d, info):
        s = by_code.get(d["code"], {})
        return {"code": d["code"], "name": d["name"], "market": d["market"],
                "type": "ETF" if sources.ETF_RE.match(d["code"]) else "股票",
                "industry": "ETF" if sources.ETF_RE.match(d["code"]) else inds.get(d["code"], "其他"),
                "auto": info["auto"], "articles": len(d["articles"]),
                "price": d["quote"].get("price"), "changePct": d["quote"].get("changePct"),
                "value": s.get("value", 0), **market.summarize(d, now)}

    index = []
    for code, info in tracked.items():
        try:
            d = await update_one(code, info["name"], now)
        except Exception as e:  # 單一股票失敗不影響其他
            print(f"  ✗ {code}：{type(e).__name__} {e}")
            d = None
        p = OUT / "s" / f"{code}.json"
        if not d and p.exists():  # 這次失敗但以前有資料
            d = json.loads(p.read_text(encoding="utf-8"))
        if d:
            index.append(entry(d, info))
        await asyncio.sleep(1.0)  # 對資料來源客氣一點

    # 不再追蹤的舊檔案刪掉，避免網站顯示過期資料
    for p in (OUT / "s").glob("*.json"):
        if p.stem not in tracked:
            p.unlink()

    days = [(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(29, -1, -1)]
    (OUT / "index.json").write_text(json.dumps({
        "updatedAt": now.isoformat(timespec="seconds"),
        "model": "FinBERT（yiyanghkust/finbert-tone-chinese）" if ok else "金融字典法（FinBERT 未載入）",
        "days": days, "stocks": index,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # 全市場股票清單（含 ETF、產業）、估值、每檔股價：讓網頁可以搜尋全部台股，非追蹤股的股價也能秒開
    (OUT / "all_stocks.json").write_text(json.dumps(
        [{"c": s["code"], "n": s["name"], "m": "O" if s.get("market") == "TPEx" else "L",
          "t": "E" if s["type"] == "ETF" else "S", "i": "ETF" if s["type"] == "ETF" else inds.get(s["code"], "")}
         for s in all_list], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    vals = await sources.all_valuations()
    (OUT / "valuation.json").write_text(json.dumps(vals, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_price = await market.price_files([s["code"] for s in all_list], OUT / "p") if os.getenv("PRICE_FILES", "1") == "1" else 0
    print(f"完成：追蹤 {len(index)} 檔；全市場清單 {len(all_list)} 檔、估值 {len(vals)} 檔、股價檔 {n_price} 檔")


if __name__ == "__main__":
    asyncio.run(main())
