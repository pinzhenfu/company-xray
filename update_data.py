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
import time
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


CAP = 80          # Google 一次最多約 100 篇；過濾前超過 80 篇就視為被截斷，改逐日查
HISTORY_DAYS = 98   # 多抓一週，確保 90 天區間最前面那週也完整


async def backfill(stock: dict, now: datetime, donedays: set[str], sink: list) -> int:
    """補齊近 90 天每一天的 Google 新聞，回傳這次完成的天數。"""
    today = now.date()
    days = [(today - timedelta(days=i)) for i in range(HISTORY_DAYS)]
    recent = {today.isoformat(), (today - timedelta(days=1)).isoformat()}
    need = [d for d in days if d.isoformat() not in donedays or d.isoformat() in recent]
    # 依週分組（週一開頭），整週都需要且已結束的先試「一週一次」
    weeks: dict = {}
    for d in need:
        weeks.setdefault(d - timedelta(days=d.weekday()), []).append(d)
    finished = 0
    name, code = stock["name"], stock["code"]

    async def one_day(d) -> bool:
        res = await sources.google_news_range(name, code, d.isoformat(), (d + timedelta(days=1)).isoformat())
        await asyncio.sleep(0.4)
        if res is None:
            return False
        sink.extend(res[0])
        return True

    for monday in sorted(weeks, reverse=True):   # 由近到遠
        ds = weeks[monday]
        whole_past_week = len(ds) == 7 and monday + timedelta(days=7) <= today - timedelta(days=1)
        if whole_past_week:
            res = await sources.google_news_range(name, code, monday.isoformat(), (monday + timedelta(days=7)).isoformat())
            await asyncio.sleep(0.4)
            if res is None:
                continue
            items, raw = res
            sink.extend(items)
            if raw < CAP:          # 沒被截斷：整週完成
                for d in ds:
                    donedays.add(d.isoformat())
                finished += 7
                continue
        for d in ds:                # 被截斷或本週：逐日查
            if await one_day(d) and d.isoformat() not in recent:
                donedays.add(d.isoformat())
                finished += 1
    return finished


def weeks_from_days(donedays: set[str]) -> list[str]:
    """把已完成的日子換算成「整週都完成」的週一清單（給網頁標示資料完整度用）。"""
    from datetime import date
    mondays = {}
    for s in donedays:
        d = date.fromisoformat(s)
        mondays.setdefault((d - timedelta(days=d.weekday())).isoformat(), set()).add(s)
    return sorted(m for m, v in mondays.items() if len(v) == 7)


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
    days = 4 if old else 90

    new = await sources.collect(stock, days)
    # 回填（逐日補齊近 90 天）：先一週查一次；那週結果接近 Google 上限（約 100 篇）就改成那 7 天每天各查一次，
    # 這樣新聞多的股票舊日子不會被截斷。已補完的日子記在 donedays，之後不再重抓；今天與昨天每次都重查。
    donedays = set((old or {}).get("donedays", []))
    bf_days = await backfill(stock, now, donedays, new["articles"])

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
        "donedays": sorted(d for d in donedays if d >= (now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")),
        "backfill": weeks_from_days(donedays | {now.date().isoformat(), (now.date() - timedelta(days=1)).isoformat()}),
        "fetchedAt": now.isoformat(timespec="seconds"), "mode": "daily",
    }
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  ✓ {stock['code']} {stock['name']}：新文章 {len(fresh)}（逐日補抓 {bf_days} 天）、累積 {len(articles)}、內文 {bodies} 篇、股價 {len(data['prices'])} 天"
          + (f"（{'；'.join(new['errors'])}）" if new["errors"] else ""))
    return data


# ---------------------------------------------------------------- 輕量更新（非熱門股）
LIGHT_FILE = OUT / "light.json"
BUDGET_MIN = float(os.getenv("TIME_BUDGET_MIN", "150"))   # 整次更新最多跑幾分鐘（GitHub 上限 180 分鐘，留緩衝）


async def update_light(stock: dict, now: datetime) -> tuple[int, int] | None:
    path = OUT / "s" / f"{stock['code']}.json"
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    got = await sources.google_news_light(stock["name"], stock["code"], 4 if old else 90)
    if got is None:
        return None
    known = {title_key(a["title"]) for a in old["articles"]} if old else set()
    fresh, seen = [], set()
    for a in got:
        k = title_key(a["title"])
        if k and k not in known and k not in seen:
            seen.add(k)
            fresh.append(a)
    model = (await asyncio.to_thread(sentiment.analyze_articles, fresh, stock["name"], stock["code"])) if fresh else (old or {}).get("model", "")
    for a in fresh:
        a["model"] = "finbert" if model.startswith("FinBERT") else "dict"
        a["lite"] = True
    cutoff = (now - timedelta(days=KEEP_DAYS)).isoformat()
    arts = sorted([a for a in fresh + (old["articles"] if old else []) if a["date"] >= cutoff], key=lambda a: a["date"], reverse=True)
    path.write_text(json.dumps({
        "code": stock["code"], "name": stock["name"], "market": stock.get("market"), "tier": "light",
        "articles": arts, "prices": [], "quote": {}, "valuation": {}, "errors": [], "model": model or "—",
        "days": KEEP_DAYS, "fetchedAt": now.isoformat(timespec="seconds"), "mode": "daily",
        "backfill": [], "lightDays": 90,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return len(fresh), len(arts)


async def light_pass(stocks: list[dict], now: datetime, t0: float) -> int:
    state = json.loads(LIGHT_FILE.read_text(encoding="utf-8")) if LIGHT_FILE.exists() else {"stocks": {}}
    st = state.get("stocks", {})
    # 優先順序：從沒抓過的 → 最久沒更新的；同樣情況下成交值大的先
    todo = sorted(stocks, key=lambda s: (s["code"] in st, st.get(s["code"], ["", 0])[0], -s.get("value", 0)))
    todo = [s for s in todo if not (s["code"] in st and st[s["code"]][0] >= (now - timedelta(hours=20)).isoformat())]
    deadline = t0 + BUDGET_MIN * 60
    sem, done = asyncio.Semaphore(3), 0
    print(f"輕量更新：待處理 {len(todo)} 檔，剩餘時間 {(deadline - time.time()) / 60:.0f} 分鐘")

    async def one(s):
        nonlocal done
        async with sem:
            if time.time() > deadline:
                return
            try:
                r = await update_light(s, now)
            except Exception as e:
                print(f"  ✗ {s['code']}：{type(e).__name__}")
                r = None
            await asyncio.sleep(0.5)
        if r is not None:
            st[s["code"]] = [now.isoformat(timespec="seconds"), r[1]]
            done += 1
            if done % 100 == 0:
                print(f"  …已完成 {done} 檔")
                LIGHT_FILE.write_text(json.dumps({"updatedAt": now.isoformat(timespec="seconds"), "stocks": st}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    await asyncio.gather(*(one(s) for s in todo))
    keep = {k: v for k, v in st.items() if (OUT / "s" / f"{k}.json").exists()}   # 只依檔案是否存在，不依當次清單
    LIGHT_FILE.write_text(json.dumps({"updatedAt": now.isoformat(timespec="seconds"),
                                      "stocks": keep},
                                     ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return done


T0 = time.time()


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

    # 舊檔案一律保留：證交所／櫃買中心 API 偶爾沒回應，不能因此刪掉資料（已下市的檔案留著也無害）

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
    print(f"熱門股完成：追蹤 {len(index)} 檔；全市場清單 {len(all_list)} 檔、估值 {len(vals)} 檔、股價檔 {n_price} 檔")

    # 其他所有股票＋ETF：輕量更新（只抓 Google 新聞標題、FinBERT 分析），在剩餘時間內做，做不完的下次接著做
    n_light = await light_pass([s for s in all_list if s["code"] not in tracked], now, T0)
    print(f"全部完成：輕量更新 {n_light} 檔，總耗時 {(time.time() - T0) / 60:.0f} 分鐘")


if __name__ == "__main__":
    asyncio.run(main())
