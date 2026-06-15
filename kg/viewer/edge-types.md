# KG 語義邊定義

## 四種 KG 架構

```
KG-1：Haiku 易錯集（獨立 DB）
KG-2：進階模式工作流推理鏈（獨立 DB，內含 5 個子圖）
  ├── subgraph: contract     合約審查
  ├── subgraph: litigation   訴訟策略
  ├── subgraph: document     書狀生成
  ├── subgraph: research     法律研究
  └── subgraph: evidence     卷證分析 pipeline
KG-3：律師特化工作流（獨立 DB，per-lawyer，與 KG-2 同 schema 雙層結構）
KG-4：資料查詢優化（獨立 DB，取代 RAG）
```

- 各自獨立 DB，共享 embedding model + MCP API
- KG-2 五個子圖用 `metadata.subgraph` 區分，子圖之間可有邊互連
- 跨 KG 連接用 `metadata.external_ref` 指向其他 KG 的 node_id

---

10 種邊在四種 KG 中各有不同含義。

---

## KG-1：Haiku 易錯集

| 邊類型 | 含義 | 例子 |
|--------|------|------|
| `must_precede` | 搞懂 A 才不會搞錯 B | 平均工資定義 → 資遣費計算 |
| `requires_reading` | 修正此錯誤前要先讀 B | 修正§1031錯誤 requires_reading §1030-1 條文 |
| `refines` | 錯誤 A 是錯誤 B 的細化版本 | 「除以6」refines「前三個月」（同一個錯的不同面向） |
| `contradicts` | 正確知識 ⊗ 模型錯誤記憶 | 「前六個月」⊗「前三個月」 |
| `reason_for` | 錯誤觀察 → prompt 修正動機 | 資遣費錯誤 → 加獨立段落 |
| `causes` | 錯誤知識導致錯誤回答 | 記憶偏差 → 資遣費算錯 |
| `implies` | A 錯 → B 必錯 | 平均工資錯 → 資遣費/退休金都錯 |
| `aligns_to` | 同類型錯誤（同領域） | 勞動法張冠李戴 aligns_to 稅法張冠李戴 |
| `tends_to` | 模型的錯誤傾向 | Haiku 在勞動法 tends_to 條號張冠李戴 |
| `observed_in` | 錯誤在哪個場景出現 | 但書反了 observed_in gen-006 |

---

## KG-2：法律推理鏈

| 邊類型 | 含義 | 例子 |
|--------|------|------|
| `must_precede` | 法律推理的必要順序 | 先確認管轄權 → 才審實體 |
| `requires_reading` | 理解 A 需先讀 B 的條文 | 特留分扣減 requires_reading 繼承順序 |
| `refines` | 特別法細化普通法 / 判例細化法條 | §339-4 加重詐欺 refines §339 普通詐欺 |
| `contradicts` | 法律見解衝突 / 學說爭議 | 甲說 vs 乙說 |
| `reason_for` | 法理依據 → 法律規定的立法理由 | 保護弱勢 reason_for 消保法§19 七天鑑賞期 |
| `causes` | 事實要件 → 法律效果 | 故意+不法侵害 → §184 損害賠償 |
| `implies` | A 法條適用 → B 也適用 | §184 侵權 → §195 可請求精神賠償 |
| `aligns_to` | 與最高法院統一見解一致 | 下級法院判決 aligns_to 最高法院決議 |
| `tends_to` | 實務上的傾向性判斷 | 此類案件 tends_to 判賠 30-50 萬 |
| `observed_in` | 此推理邏輯出現在哪個判決 | 侵權三段論 observed_in 最高法院 112 台上 1234 號 |

---

## KG-3：律師特化工作流

KG-2 和 KG-3 是同一套 schema 的兩層：

```
KG-2（標準層）：教科書式的正確推理流程
  ↕ refines / strengthens
KG-3（個人化層）：每個律師的實際操作方式
  ↓ 彙整共同模式（匿名化）
KG-2（標準層更新）：吸收實務經驗變得更實用
```

KG-3 可回饋 KG-2 的：
- 80% 律師都先做 X 再做 Y → KG-2 加 must_precede 邊
- 資深律師都會多查一個法條 → KG-2 加 requires_reading 邊
- 某個步驟大家都跳過 → KG-2 移除或降權
- 實務上常見但教科書沒教的順序 → KG-2 補上

KG-3 不該回饋的：寫作風格偏好、特定客戶策略（機密）、報價收費、個人人脈

| 邊類型 | 含義 | 例子 |
|--------|------|------|
| `must_precede` | 工作流程的強制順序 | 蒐證 → 書狀 → 提告 |
| `requires_reading` | 執行此步驟前要先讀的資料 | 寫答辯狀 requires_reading 原告起訴狀 |
| `refines` | 特化通用流程 | 王律師的離婚流程 refines 通用離婚流程 |
| `contradicts` | 律師偏好與通用建議衝突 | 王律師不認同先調解（contradicts 通用建議） |
| `reason_for` | 為什麼選這個策略 | 對方財力雄厚 reason_for 選擇快速訴訟 |
| `causes` | 此步驟產生的結果 | 發存證信函 causes 時效中斷 |
| `implies` | 選了 A 策略 → B 也要做 | 選刑事附帶民事 implies 要先提告訴 |
| `aligns_to` | 律師認同的法律見解 | 王律師 aligns_to 甲說 |
| `tends_to` | 律師的偏好傾向 | 王律師 tends_to 先調解再訴訟 |
| `observed_in` | 從哪個案件學到的 | 此偏好 observed_in 某次委任案件 |

---

## KG-4：資料查詢優化（取代 RAG）

| 邊類型 | 含義 | 例子 |
|--------|------|------|
| `must_precede` | 審級關係（下級 → 上級） | 地院判決 → 高院判決 → 最高法院 |
| `requires_reading` | 理解此判決需先讀的法條/前案 | 本判決 requires_reading 釋字第 748 號 |
| `refines` | 後判決細化前判決見解 | 112年判決 refines 100年判決的構成要件 |
| `contradicts` | 判決見解變更 | 新判決 contradicts 舊判決（變更見解） |
| `reason_for` | 法條是判決的裁判依據 | 民法§184 reason_for 本判決主文 |
| `causes` | 判決 A 的見解導致判決 B 跟進 | 最高法院 X 號 causes 下級法院跟進 |
| `implies` | 引用權威性（被引用多 = 重要） | 被引用 50+ 次 implies 權威判例 |
| `aligns_to` | 判決適用的法條 | 判決 A aligns_to 民法§184 |
| `tends_to` | 此法院在此議題的傾向 | 臺北地院 tends_to 判賠較高 |
| `observed_in` | 知識來源標記 | 此見解 observed_in 司法院公報 |
