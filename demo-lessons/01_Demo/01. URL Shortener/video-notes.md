# URL Shortener — Whiteboard Walkthrough

> These notes follow a hypothetical whiteboard session. Timestamps are clickable seek buttons in the cockpit's video panel.

---

## 需求釐清 Requirements (00:30)

[00:30] We open by listing functional requirements: shorten a long URL, redirect visitors to the original, and optionally support expiry. Non-functional: 99.9% availability, redirect P99 under 20 ms, and a read/write ratio around 100:1.

> Key insight: clarifying whether click analytics is in scope decides the 301 vs 302 question later.

---

## 容量估算 Capacity Estimation (02:15)

[02:15] Back-of-envelope math:

- 100 M new URLs / day ≈ 1 200 write RPS
- 10 B redirects / day ≈ 120 000 read RPS
- 6-character base62 code → 62^6 ≈ 56 billion unique codes (decades of headroom)
- Storage: ~500 bytes per record × 100 M records = ~50 GB (fits on a single SSD, no exotic storage needed)

---

## 短碼產生 ID Generation (05:00)

[05:00] Two candidates on the whiteboard:

**Option A — Hash-and-truncate**: SHA-256 of the long URL → base62 → first 7 chars.
Simple and stateless. Downside: collision on truncation requires a retry loop; as the table fills, retries get more frequent.

**Option B — Counter + KGS** [06:45]: A Key Generation Service (KGS) pre-generates IDs and hands out batches (e.g. 1 000 at a time) to each API server. Each API server burns through its local batch without hitting the KGS on every request.

[07:30] We draw the KGS on the board: two KGS instances (active + standby) each holding a batch from a Key DB. If one KGS crashes, the standby takes over — no SPOF.

---

## 重定向類型 Redirect Type (09:00)

[09:00] The 301 vs 302 slide. Show of hands: who thought 301 was always faster? 

[09:45] The trap: 301 is faster for the *user* (browser caches it), but invisible to the *server* — you lose click data. If analytics matter, you must use 302 and accept the extra round-trip.

Decision for this demo system: **302**, because the product roadmap includes click analytics.

---

## 資料模型 Data Model (11:00)

[11:00] Single table `url_map`: `id BIGINT PK`, `short_code VARCHAR(8) UNIQUE`, `long_url TEXT`, `created_at`, `expires_at`. Index on `short_code` for the hot redirect lookup.

Optional `user_id` column for authenticated users (enables "my links" dashboard without a separate table).

---

## 系統架構 High-Level Architecture (13:00)

[13:00] Drawing the boxes:

```
User → Load Balancer → API Servers (stateless, N replicas)
                            ↓             ↓
                        Redis Cache    KGS (ID batch)
                            ↓
                        Read Replica → Primary DB
```

[14:30] Redirect happy path: API server receives GET, looks up short_code in Redis (cache hit ~99%), returns 302. On cache miss, hits the read replica, populates Redis, returns 302.

[15:15] Write path: POST /shorten → API server fetches next ID from local KGS batch → inserts into Primary DB → writes to Redis (write-through) → returns the short URL.

---

## 架構演進 Architecture Evolution (17:00)

How the system grows from a weekend project to internet scale:

| Stage | Setup | Handles |
|---|---|---|
| Naive | Single server + single DB | ~100 RPS |
| Plus cache | API servers + Redis | ~50 000 RPS |
| Plus sharding | Redis cluster + DB sharding by short_code hash | 100 000+ RPS |

[17:45] Sharding key choice: shard by `short_code` hash (not user_id) because redirect lookups only know the short code — you'd have to broadcast to all shards if you sharded by user.

---

## 面試收尾 Closing Points (19:00)

[19:00] Three things interviewers want to hear:

1. **ID generation trade-off** — you considered both hash and counter, and justified counter+KGS for collision-free scaling.
2. **301 vs 302** — you named the analytics trade-off explicitly, not just "302 is fine."
3. **Cache before DB scaling** — with a 100:1 read ratio, caching is 10× cheaper than adding DB replicas.

[19:45] End: "What would change if we needed sub-millisecond P99?" — the answer involves moving to an in-process cache and potentially pre-loading the hottest 10 000 codes into each API server's memory.
