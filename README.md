# 公司健檢照妖鏡｜Company X-Ray（GitHub 每日自動更新版）

任何電腦打開網址就能用，不用安裝任何東西。GitHub 每天自動抓台股新聞與 PTT 討論，用論文作者釋出的中文 FinBERT（[`yiyanghkust/finbert-tone-chinese`](https://huggingface.co/yiyanghkust/finbert-tone-chinese)）判斷情緒，並更新股價、技術指標與估值。

> 延伸自 Huang, Wang & Yang (2023), *FinBERT: A Large Language Model for Extracting Information from Financial Text*, Contemporary Accounting Research。

---

## 上線步驟（全部用網頁操作，不需要 git，約 15 分鐘＋等待 15 分鐘）

### 步驟 1：建立專案（Repository）
1. 登入 <https://github.com>，右上角 **＋ → New repository**
2. Repository name 輸入 `company-xray`（可自訂，會出現在網址裡）
3. 選 **Public**（免費帳號的 GitHub Pages 需要公開）
4. 其他都不用勾，按 **Create repository**

### 步驟 2：上傳檔案
1. 在剛建好的頁面點 **uploading an existing file** 這行藍字
2. 打開電腦上解壓縮的 `company-xray` 資料夾，**全選裡面所有檔案和資料夾**（`site`、`workflow`、`.py` 檔、`watchlist.txt` 等），拖曳到網頁上的框框裡
   - 要拖「資料夾裡面的東西」，不是拖 `company-xray` 資料夾本身
3. 等檔案列表都出現後，拉到最下面按 **Commit changes**
4. 確認專案首頁看得到 `site` 資料夾、`update_data.py`、`watchlist.txt`

### 步驟 3：開啟 GitHub Pages
1. 專案上方點 **Settings** → 左側選單點 **Pages**
2. **Source** 下拉選單選 **GitHub Actions**（不是 Deploy from a branch）
3. 這頁不用按儲存，選好就生效

### 步驟 4：建立自動更新設定檔（這步最重要）
1. 回到專案首頁（點上方 **Code**），按 **Add file → Create new file**
2. 檔名欄位輸入（一字不差，斜線會自動變成資料夾）：
   ```
   .github/workflows/update.yml
   ```
3. 用記事本打開電腦上 `workflow/update.yml`，**全選複製**，貼到 GitHub 的大編輯框
4. 按右上角 **Commit changes…** → 再按一次 **Commit changes**

建立完成就會自動開始第一次更新。

### 步驟 5：等待第一次更新完成（約 10～20 分鐘）
1. 點上方 **Actions** 分頁，會看到「每日更新資料並部署網站」正在跑（黃色圓圈）
2. 變成綠色勾勾 ✓ 就完成了
3. 點進去，`deploy` 方塊下方會出現網址，格式是：
   ```
   https://你的GitHub帳號.github.io/company-xray/
   ```
這個網址就可以分享給任何人，手機也能開。

---

## 日常使用與維護

| 想做什麼 | 怎麼做 |
|---|---|
| 新增／移除可查詢的股票 | 在 GitHub 點 `watchlist.txt` → 右上角鉛筆 ✏️ → 每行一檔（例如 `2344 華邦電`）→ **Commit changes**。存檔後會自動重新抓資料，約 15 分鐘後網站就會出現 |
| 立刻更新資料（例如上台前） | **Actions** → 左側點「每日更新資料並部署網站」→ 右邊 **Run workflow** → 綠色 **Run workflow** |
| 自動更新時間 | 每天台灣時間約 08:17 與 18:17（GitHub 排程尖峰時可能延遲 10～30 分鐘） |
| 確認更新是否成功 | 網站右上角顯示最後更新時間；超過 36 小時沒更新會出現橘色警告。也可看 Actions 分頁有沒有紅色 ✗ |

**注意**：GitHub 規定專案 60 天沒有任何活動時會暫停排程。自動更新本身會產生紀錄，通常不會被暫停；若被暫停，Actions 頁面會有按鈕可重新啟用。

---

## 網站功能（參考 OpView 輿情網站）

- **公司標頭**：股價、漲跌（紅漲綠跌）、本益比、殖利率、股價淨值比
- **KPI**：總聲量（含較前期變化）、好感度（正／負比）、正面／負面佔比、淨情緒指數、綜合評分
- **聲量與情緒趨勢**（每日文章數依情緒堆疊）＋對齊的收盤價走勢
- **情緒佔比**、**來源類型**（新聞／論壇）、**熱門來源網站**排行
- **熱門關鍵字文字雲**＋正面／負面熱詞（點字可篩選文章）
- **正面／負面熱門文章 Top 5**：有瀏覽量時依瀏覽量排序，否則依最新（頁面會註明），附原文連結、模型信心、觸發的金融詞
- **投資分析與建議**：六面向評分、評等、操作建議、風險提醒、停損參考
- **近半年股價＋均線＋成交量**、12 項技術指標
- **情緒與股價相關性**（每日淨情緒 vs 下一個交易日報酬）
- **全部文章表格**：可篩選，並標出「FinBERT 與字典法判斷不同」的文章（對應論文發現）
- **多股比較**（最多 4 檔）：總表、指數化股價、每日聲量、雷達圖、淨情緒走勢、比較結論與配置建議
- 期間切換：近 7／30／90 天；匯出分析摘要

## 對應論文的痛點

| 論文發現 | 一般投資人的痛點 | 本網站的做法 |
|---|---|---|
| 字典法常把有情緒的金融句子誤判成「中性」 | 只看關鍵字容易誤判 | 用 FinBERT 判斷，並標出與字典法不同的文章 |
| FinBERT 在金融專用詞彙上表現特別好 | 財經術語多，不易讀懂 | 每篇附判斷依據：模型信心＋金融詞 |
| 文字資訊含量被傳統方法低估 | 新聞太多，沒時間逐篇讀 | 聲量、情緒、趨勢、文字雲一次看完；計算情緒與隔日報酬的相關係數 |

## 架構

```
GitHub Actions（每天 2 次）
  update_data.py ── sources.py：Google 新聞 RSS、鉅亨網、PTT 股板、Yahoo/證交所股價、證交所/櫃買估值
                 └─ sentiment.py：FinBERT 三分類（失敗時改用字典法）＋ jieba 關鍵字
  → 寫入 site/data/index.json、site/data/s/{代號}.json（與舊資料合併，保留 120 天）
  → 部署 site/ 到 GitHub Pages

使用者瀏覽器
  site/index.html + app.js 讀取 JSON，所有統計、圖表、技術指標、評分都在瀏覽器計算
```

- 第一次抓近 90 天，之後每次抓近 14 天並與舊資料合併，所以歷史資料會越累積越完整
- 某個來源抓不到時保留舊資料，網站不會被清空

## 限制與免責

- 只能查詢 `watchlist.txt` 裡的股票，資料每天更新兩次（非即時）
- 情緒判斷以標題（與鉅亨網摘要）為主；FinBERT 以簡體中文訓練，送入前會先轉簡體
- Google 新聞與 PTT 不提供瀏覽量，所以熱門文章大多依「最新」排序
- 爬蟲依賴各網站現有格式，網站改版或擋 GitHub 的伺服器時可能抓不到（頁面會顯示哪個來源失敗）
- 投資評分為規則式設計、權重為課程示範，**不構成投資建議**

## 檔案

| 檔案 | 用途 |
|---|---|
| `site/` | 網站本體（index.html、style.css、app.js、chart.umd.min.js）；`site/data/` 由自動更新產生 |
| `update_data.py` | 每日更新主程式 |
| `sources.py` | 新聞、PTT、股價、估值爬取 |
| `sentiment.py` | FinBERT、字典法、關鍵字 |
| `watchlist.txt` | 追蹤清單 |
| `stocks.json` | 內建股票代號對照表（備用） |
| `requirements.txt` | Python 套件 |
| `workflow/update.yml` | 自動更新設定（步驟 4 要貼到 `.github/workflows/update.yml`） |
