"""全市場資料：產業分類、全部股票的股價檔、追蹤股票摘要（給市場總覽首頁用）。"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from pathlib import Path

import sources

INDUSTRY = {
    "01": "水泥", "02": "食品", "03": "塑膠", "04": "紡織纖維", "05": "電機機械", "06": "電器電纜", "08": "玻璃陶瓷",
    "09": "造紙", "10": "鋼鐵", "11": "橡膠", "12": "汽車", "14": "建材營造", "15": "航運", "16": "觀光餐旅",
    "17": "金融保險", "18": "貿易百貨", "19": "綜合", "20": "其他", "21": "化學", "22": "生技醫療", "23": "油電燃氣",
    "24": "半導體", "25": "電腦週邊", "26": "光電", "27": "通信網路", "28": "電子零組件", "29": "電子通路",
    "30": "資訊服務", "31": "其他電子", "32": "文化創意", "33": "農業科技", "34": "電子商務", "35": "綠能環保",
    "36": "數位雲端", "37": "運動休閒", "38": "居家生活", "80": "管理股票",
}


async def industries() -> dict[str, str]:
    """股票代號 → 產業名稱（上市＋上櫃）。"""
    out: dict[str, str] = {}
    async with sources.client() as c:
        for url in ("https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
                    "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"):
            try:
                rows = (await c.get(url)).json()
            except Exception:
                continue
            for row in rows:
                code = next((str(row[k]).strip() for k in ("公司代號", "SecuritiesCompanyCode", "CompanyCode") if row.get(k)), None)
                ind = next((str(row[k]).strip() for k in ("產業別", "SecuritiesIndustryCode", "IndustryCode") if row.get(k)), None)
                if code and ind:
                    out[code] = INDUSTRY.get(ind.zfill(2), ind if not ind.isdigit() else "其他")
    return out


async def price_files(codes: list[str], out_dir: Path, concurrency: int = 6) -> int:
    """替全部股票各存一份近一年日 K（精簡格式），讓網頁查非追蹤股票時股價能秒開。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(concurrency)
    ok = 0

    async def one(code):
        nonlocal ok
        async with sem:
            y = await sources._yahoo(code)
            await asyncio.sleep(0.2)
        if not y:
            return
        rows, meta, market = y
        (out_dir / f"{code}.json").write_text(json.dumps({
            "m": market, "p": meta.get("regularMarketPrice") or rows[-1]["c"],
            "t": meta.get("regularMarketTime"),
            "d": [r["d"] for r in rows], "o": [r["o"] for r in rows], "h": [r["h"] for r in rows],
            "l": [r["l"] for r in rows], "c": [r["c"] for r in rows], "v": [r["v"] for r in rows],
        }, separators=(",", ":")), encoding="utf-8")
        ok += 1

    await asyncio.gather(*(one(c) for c in codes))
    return ok


def summarize(d: dict, now: datetime, days: int = 30) -> dict:
    """單一追蹤股票的摘要：近 30 天每日情緒數、近 7 天與前 7 天、報酬率。"""
    dates = [(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days - 1, -1, -1)]
    idx = {k: i for i, k in enumerate(dates)}
    daily = [[0, 0, 0] for _ in dates]
    pos = {"pos": 0, "neu": 1, "neg": 2}
    for a in d["articles"]:
        k = datetime.fromisoformat(a["date"]).astimezone(sources.TW).strftime("%Y-%m-%d")
        if k in idx:
            daily[idx[k]][pos[a["sentiment"]]] += 1
    s = lambda rows: [sum(r[i] for r in rows) for i in range(3)]
    c = [p["c"] for p in d.get("prices", [])]
    ret = lambda n: round((c[-1] / c[-1 - n] - 1) * 100, 2) if len(c) > n else None
    return {"daily": daily, "c7": s(daily[-7:]), "p7": s(daily[-14:-7]), "c30": s(daily),
            "ret5": ret(5), "ret20": ret(20)}
