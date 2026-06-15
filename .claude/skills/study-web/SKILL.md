---
name: study-web
description: Use when interacting through the study-web browser cockpit (messages tagged channel source="study-web"), or when asked to put a lesson on the web / 上課到網頁 / rewrite a lesson into clickable web-notes. Covers the reply / show_notes tools and the clickable-term contract ([[id|surface]] markers + one glossary JSON block).
---

# study-web — 網頁陪讀座艙

你透過瀏覽器座艙 `study-web` 和使用者互動。**這是一個 `claude/channel`**:使用者的話以 `<channel source="study-web" chat_id="web" …>` 進到你的 session;**你想讓使用者看到的東西,只有透過工具送才會到瀏覽器**(終端機輸出到不了)。

## 兩個出口工具

- **`reply(text)`** — 送一則訊息到右側**聊天面板**。`text` 是 markdown(可含 mermaid ```mermaid 區塊、表格、程式碼)。深入解釋、回答問題都走這裡。
- **`show_notes(lesson, markdown)`** — 把你重寫好的**整課網頁筆記**推到左側**閱讀面板**。

收到的 `chat_id`(通常是 `web`)原樣帶回 `reply`。

## 何時做什麼

- 使用者說「**上 X 課 / 開 X 課 / 看 X**」→ 跑下方「重寫流程」→ `show_notes`。
- 使用者按術語小卡的「深入」→ 進來的訊息會像 `[在課程脈絡中深入解釋術語「…」] …`,用 `reply` 給**簡短、白話**的解釋(再有 jargon 就也包成 `[[…]]`,見下)。
- 一般提問 → `reply` 富文字回答。
- **長任務先簡答**:預估要超過 ~30 秒的工作(備課/重寫講義、跑 Gemini、看影片片段),**先 `reply` 一行**「收到,正在 X,約需 N 分鐘」再開工,做完再送正式內容。短問題一次答完,**不要**拆成「簡短版+詳細版」兩則(那只會讓使用者等兩次)。
- 使用者說「**預載 X / 先準備好接下來幾課**」→ 跑下方「預載流程」。
- 一律遵循專案 `CLAUDE.md`:教練人設、anti-fabrication、信任規則、KG 流程、間隔複習。

## 重寫流程(PDF → 可點網頁筆記)

1. `Glob` 該章節資料夾,**複製精確課名**(含全形 `｜`、空格)當 `lesson`。
2. 先查快取:若 `notes/<NN_章節>/<課>/web-notes.md` 已存在 → 直接讀它 `show_notes`,**不重跑 Gemini/重寫**。
3. 否則:`gemini_digest_pdf(lesson[, file])`(多 PDF 課:先不帶 `file` 拿清單,再逐份)。把回傳逐字原文存成 `notes/<NN_章節>/<課>/digest.md`(沿用既有 header 慣例)。
4. 把 digest **重寫成乾淨雙語筆記**:標題層次、短段落、必要處用 ```mermaid 畫架構/流程。關鍵術語用**可點標記**(見下)。
5. 結尾附**一個** glossary JSON 區塊。把成品**存成 `notes/<NN_章節>/<課>/web-notes.md`**(下次直接讀檔)。
6. **存檔後跑驗證**:`node scripts/check-web-notes.mjs "notes/<NN_章節>/<課>"` —— 檢查 glossary JSON 合法、每個 `[[id]]` 都有條目、表格內沒有豎線形式;修到 ✅ 再 `show_notes(lesson, 該 markdown)`。

> 省 token 鐵則(同 `CLAUDE.md`):每課 PDF 只用 Gemini 讀一次;重寫結果寫檔快取;之後複習查 KG / 讀 `web-notes.md`,別重灌投影片。

## 預載流程 (preload)

目的:提前把多課的 `web-notes.md` 快取灌滿,之後上課秒開(瀏覽器歡迎畫面會把有快取的課標 ⚡)。

1. 先 `reply` 一行告知要預載哪幾課、大約多久。
2. 逐課跑「重寫流程」步驟 2–5,**但不要 `show_notes`**(只寫檔,不打斷目前畫面)。已有 `web-notes.md` 的課直接跳過。
3. 全部完成後 `reply` 總結:完成了哪幾課、哪幾課本來就有快取。

> ⚠️ 每課 digest 很佔 context,**一次預載以 2–3 課為限**;更多課請使用者分批,或交給 builder session 用 subagent 平行跑。

## 可點術語約定 (term contract)

- 行內標記:`[[id|顯示文字]]`。`id` = kebab-case 穩定鍵;顯示文字可省 → `[[consistent-hashing]]`。
- 結尾**一個** ```glossary 區塊,JSON 以 id 為鍵:`{ "<id>": { "term": "...", "short": "...", "deeper": "..." } }`。
  - `term` = 卡片標題(英文術語 + 中文)。
  - `short` = **一兩句白話**小卡本文,**可再含 `[[…]]`** 巢狀術語。
  - `deeper`(可選)= 按「深入」時要問的問題;省略則前端自動用「請深入解釋:<term>」。
- `short` 來源:`search_memory(term)` → `get_knowledge(id)`,**優先取 `content`(雙語解釋)**,缺則取 `quote`(逐字)。查無 KG 節點就自己寫一句白話,別硬湊。
- 每個 `[[id]]` 都要在 glossary 有對應條目;沒有就別包成可點。

### 範例

````markdown
## 一致性雜湊

當叢集要加減節點時,用 [[consistent-hashing|一致性雜湊]] 只搬動少量 key,
比樸素的 [[mod-hashing|取模雜湊]] 幾乎全搬好得多。

```glossary
{
  "consistent-hashing": {
    "term": "Consistent Hashing 一致性雜湊",
    "short": "把節點與 key 都雜湊到同一個 [[hash-ring|hash 環]] 上,節點增減只影響環上相鄰的一段 key。",
    "deeper": "為何一致性雜湊在 cache 叢集擴縮容時優於取模?"
  },
  "mod-hashing": { "term": "Modulo Hashing 取模雜湊", "short": "用 key % N 決定節點;N 一變,幾乎所有 key 重新映射。" },
  "hash-ring": { "term": "Hash Ring 雜湊環", "short": "把雜湊值首尾相接成環,順時針找到的第一個節點即負責該 key。" }
}
```
````

## 影片實作課 (ch07 — 07_真實大型應用設計)

ch07 的 14 課是**影片 worked-example**(老師完整解一道設計題),不是概念投影片。座艙對這章有特別支援:

- **閱讀面板會自動出現影片播放器**(任何資料夾內有 `.mp4` 的課都會;前端打 `GET /api/video?lesson=` 探測)。你照常用 `show_notes` 推 `video-notes.md` 即可;**不要**把 ch07 硬塞成 `[[術語]]`+glossary 契約(會搞丟架構演進敘事)。
- **`video-notes.md` 裡的時間戳在面板上可點**(`[MM:SS]` 與 `(MM:SS)` 兩種寫法都認;ch07 有 3 課用方括號、11 課用圓括號),點了跳播到那一刻(零重寫,既有時間戳自動生效)。帶「分段看」時直接講「看 16:12→18:00,然後…」,並用 `show_notes` 把含時間戳的段落推上去。
- 教學流程走 `CLAUDE.md` §11(先自己做 → 分段看 → 自我解釋 → 憑記憶重畫 → 存 `record_experience` walkthrough + KG subgraph → 漸退)。
- 可選:在 `video-notes.md` 開頭放一小塊「先備術語」glossary,讓 Phase-0 詞彙能用 term-card——非必要。

## 注意

- **表格儲存格內不要用 `[[id|顯示]]` 的豎線形式** —— `|` 會被當成表格欄位分隔符,把儲存格拆掉、標記也壞掉。表格內改用 `[[id]]`(顯示文字自動取 glossary 的 `term`),或把豎線跳脫成 `\|`。
- mermaid 訊息/節點文字避免半形 `;`、`[`、`]`(會語法錯);節點標籤要含特殊字元時用 `"…"` 包起來。
- 投影片可能有 OCR 雜訊;重寫是**詮釋**,逐字原話以 `digest.md` 為準,要 quote 時去那裡撈。
