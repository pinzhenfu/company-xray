"""情緒分析：中文 FinBERT（論文作者釋出的 yiyanghkust/finbert-tone-chinese）＋字典法備援＋關鍵字擷取。

- 模型載入失敗、記憶體不足或設定 USE_FINBERT=0 時，自動改用字典法，網站照常運作。
- 字典法同時用來產生「判斷依據」提示詞（哪些金融詞讓這篇偏正／偏負），讓 BERT 結果更好解釋。
"""
from __future__ import annotations

import logging
import os
import re
import threading

import jieba
from opencc import OpenCC

log = logging.getLogger("sentiment")
MODEL_NAME = os.getenv("SENTIMENT_MODEL", "yiyanghkust/finbert-tone-chinese")
USE_FINBERT = os.getenv("USE_FINBERT", "1") != "0"
_t2s = OpenCC("t2s")  # 模型以簡體中文訓練，送進模型前先轉簡體

# ---------------------------------------------------------------- 金融字典（繁體）
POS = [
    "成長", "增長", "創新高", "新高", "看好", "上修", "調升", "優於預期", "超乎預期", "強勁", "大漲", "漲停",
    "攻頂", "轉盈", "獲利", "賺", "受惠", "利多", "買超", "加碼", "樂觀", "回溫", "復甦", "擴產", "接單",
    "訂單滿", "滿載", "亮眼", "飆", "噴", "突破", "旺", "暢旺", "穩健", "韌性", "改善", "提升", "股利",
    "配息", "目標價上調", "上漲", "反彈", "雙位數成長", "創高", "看多", "多頭", "營收增", "年增", "季增",
]
NEG = [
    "衰退", "下滑", "下修", "調降", "低於預期", "不如預期", "疲弱", "大跌", "跌停", "重挫", "崩", "虧損",
    "轉虧", "利空", "賣超", "減碼", "悲觀", "放緩", "砍單", "延後", "庫存", "去化", "壓力", "風險",
    "不確定", "審慎", "保守", "警訊", "裁員", "訴訟", "罰", "停工", "跌破", "下跌", "走弱", "疑慮",
    "看空", "空頭", "年減", "季減", "失守", "跳水", "賣壓", "降評", "目標價下調", "地緣政治", "關稅",
]
NEGATORS = ["不", "未", "沒有", "無", "非", "免"]

for w in POS + NEG + ["台積電", "聯發科", "鴻海", "法說會", "營收", "毛利率", "外資", "投信", "自營商",
                      "AI", "伺服器", "先進製程", "CoWoS", "殖利率", "除息", "本益比", "目標價"]:
    jieba.add_word(w)

STOP = set("""
的 了 和 與 及 或 在 是 有 也 都 就 而 但 並 被 為 於 以 將 對 從 到 由 等 這 那 其 之 中 上 下 後 前 今 年 月 日
今年 去年 明年 今日 昨日 本週 上週 公司 表示 指出 認為 可能 持續 目前 相關 進行 我們 他們 什麼 一個 已經 還是
如何 為何 新聞 報導 記者 快訊 最新 影音 獨家 盤中 盤後 今天 昨天 個股 股票 台股 股價 消息 問題 標的 請益 心得
新聞 標題 討論 情報 閒聊 分享 請問 一下 多少 億元 萬元 美元 元 億 萬 張 股 % 點 家 檔 次 名 位 成 倍
""".split())


def dict_score(text: str) -> tuple[dict, dict]:
    pos_hits, neg_hits = [], []
    for words, bucket, other in ((POS, pos_hits, neg_hits), (NEG, neg_hits, pos_hits)):
        for w in words:
            for m in re.finditer(re.escape(w), text):
                before = text[max(0, m.start() - 2): m.start()]
                (other if any(n in before for n in NEGATORS) else bucket).append(w)
    p, n = len(pos_hits), len(neg_hits)
    if p == n == 0:
        probs = {"pos": 0.15, "neu": 0.7, "neg": 0.15}
    else:
        tot = p + n
        lean = (p - n) / tot
        probs = {"pos": round(max(0.05, 0.45 + 0.45 * lean), 3), "neg": round(max(0.05, 0.45 - 0.45 * lean), 3)}
        probs["neu"] = round(max(0.0, 1 - probs["pos"] - probs["neg"]), 3)
    return probs, {"pos": sorted(set(pos_hits)), "neg": sorted(set(neg_hits))}


def keywords(text: str, exclude: set[str], k: int = 8) -> list[str]:
    out = []
    for w in jieba.lcut(text):
        w = w.strip()
        if (len(w) < 2 or w in STOP or w in exclude or re.fullmatch(r"[\d\W_a-zA-Z]{1,2}|[\d.,%]+", w)
                or re.search(r"[\[\]【】（）()「」:：|｜/]", w)):
            continue
        if w not in out:
            out.append(w)
        if len(out) >= k:
            break
    return out


# ---------------------------------------------------------------- FinBERT
class FinBert:
    def __init__(self):
        self.status = "disabled" if not USE_FINBERT else "loading"
        self.error = None
        self._tok = self._model = None
        self._lock = threading.Lock()
        self._ready = threading.Event()
        if USE_FINBERT:
            threading.Thread(target=self._load, daemon=True).start()
        else:
            self._ready.set()

    def _load(self):
        try:
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            torch.set_num_threads(max(1, os.cpu_count() or 1))
            self._tok = AutoTokenizer.from_pretrained(MODEL_NAME)
            self._model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME).eval()
            self._torch = torch
            self.status = "ready"
            log.info("FinBERT loaded: %s", MODEL_NAME)
        except Exception as e:  # 無網路、記憶體不足、套件未安裝
            self.status, self.error = "failed", f"{type(e).__name__}: {e}"[:200]
            log.warning("FinBERT unavailable, using dictionary: %s", self.error)
        finally:
            self._ready.set()

    def wait(self, timeout: float) -> bool:
        self._ready.wait(timeout)
        return self.status == "ready"

    def predict(self, texts: list[str], batch: int = 32) -> list[dict]:
        torch = self._torch
        out = []
        with self._lock:
            for i in range(0, len(texts), batch):
                chunk = [_t2s.convert(t) for t in texts[i: i + batch]]
                enc = self._tok(chunk, padding=True, truncation=True, max_length=128, return_tensors="pt")
                with torch.no_grad():
                    probs = torch.softmax(self._model(**enc).logits, dim=-1).tolist()
                # 標籤：0 中性、1 正面、2 負面
                out += [{"neu": round(p[0], 3), "pos": round(p[1], 3), "neg": round(p[2], 3)} for p in probs]
        return out


finbert = FinBert()


def label_of(probs: dict) -> str:
    return max(probs, key=probs.get)


def analyze_articles(articles: list[dict], stock_name: str, code: str) -> str:
    """就地為每篇文章加上 sentiment / scores / hints / keywords；回傳使用的模型名稱。"""
    texts = [(a["title"] + "。" + a.get("summary", ""))[:300] for a in articles]
    use_bert = articles and finbert.wait(timeout=90)
    bert_scores = finbert.predict(texts) if use_bert else None
    exclude = {stock_name, code, stock_name[:2]}
    for i, a in enumerate(articles):
        d_probs, hints = dict_score(texts[i])
        probs = bert_scores[i] if bert_scores else d_probs
        a["scores"] = probs
        a["sentiment"] = label_of(probs)
        a["dictSentiment"] = label_of(d_probs)
        a["hints"] = hints
        a["keywords"] = keywords(texts[i], exclude)
    return f"FinBERT（{MODEL_NAME}）" if bert_scores is not None else "金融字典法（FinBERT 未載入時的備援）"


# ---------------------------------------------------------------- 逐句分析（判斷依據）
def analyze_body(a: dict, sentences: list[str]) -> None:
    """用內文逐句重新判斷，並挑出最能支持結論的句子當作判斷依據。

    文章分數 = 標題 40% ＋ 內文各句平均 60%；判斷依據 = 對最終結論機率最高的 3 句。
    """
    a["bodyTried"] = True
    if not sentences:
        return
    use_bert = finbert.status == "ready"
    probs = finbert.predict(sentences) if use_bert else [dict_score(s)[0] for s in sentences]
    title_p = a["scores"]
    mean = {k: sum(p[k] for p in probs) / len(probs) for k in ("pos", "neu", "neg")}
    combo = {k: round(0.4 * title_p[k] + 0.6 * mean[k], 3) for k in ("pos", "neu", "neg")}
    # 有明顯正負面句子時，不讓大量中性句把結論拉成中性
    strong = {k: max(p[k] for p in probs) for k in ("pos", "neg")}
    a["scores"] = combo
    a["sentiment"] = label_of(combo)
    if a["sentiment"] == "neu" and max(strong.values()) > 0.9 and abs(strong["pos"] - strong["neg"]) > 0.3:
        a["sentiment"] = "pos" if strong["pos"] > strong["neg"] else "neg"
    lab = a["sentiment"]
    ranked = sorted(zip(sentences, probs), key=lambda x: x[1][lab], reverse=True)
    ev = []
    for s, p in ranked[:3]:
        if lab != "neu" and p[lab] < 0.4:
            break
        ev.append({"text": s, "label": label_of(p), "p": round(p[lab], 3), "hits": dict_score(s)[1]})
    a["evidence"] = ev
    a["nSentences"] = len(sentences)
