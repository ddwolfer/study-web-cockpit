#!/usr/bin/env node

/**
 * web-reply-guard (Stop hook)
 *
 * 防呆:當使用者透過 study-web 座艙傳訊息進來,Claude 必須用 `mcp__study-web__reply`
 * 工具回應(終端機輸出使用者看不到)。本 hook 在 Claude 想結束回合時檢查:
 *   「最近一則 study-web 進來的訊息」是否比「最近一次 reply 工具呼叫」還新?
 * 若是 → 代表還沒回 web → 擋下 stop,提醒去 reply。
 *
 * 安全設計:
 *   - stop_hook_active=true(已是 hook 觸發的續跑)時直接放行,避免無限迴圈。
 *   - 找不到任何 study-web 進來訊息(純終端機 session)時不干涉。
 *   - 只看 type==='user' 的進來訊息 + type==='assistant' 的 reply 工具呼叫,
 *     避免被系統提示裡的範例 channel 標籤誤觸。
 */

import { readFileSync } from 'fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let data;
try { data = JSON.parse(input); } catch { process.exit(0); }

// 已經是 stop-hook 觸發的續跑 → 放行,避免無限迴圈
if (data.stop_hook_active) process.exit(0);

const transcriptPath = data.transcript_path;
if (!transcriptPath) process.exit(0);

let lines;
try {
  lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
} catch { process.exit(0); }

let lastWebInbound = -1; // 最近一則 study-web 進來的訊息（user turn）
let lastReply = -1;      // 最近一次用 reply 工具回應（assistant turn）

for (let i = 0; i < lines.length; i++) {
  let obj;
  try { obj = JSON.parse(lines[i]); } catch { continue; }

  const type = obj.type || obj.role || (obj.message && obj.message.role);
  const blob = JSON.stringify(obj.message ?? obj);

  if (type === 'user') {
    // 進來的 study-web channel 訊息（排除系統提示裡的 "<channel>" 說明）
    if (blob.includes('<channel source=') && blob.includes('study-web')) {
      lastWebInbound = i;
    }
  } else if (type === 'assistant') {
    if (blob.includes('mcp__study-web__reply')) {
      lastReply = i;
    }
  }
}

// 沒有任何 study-web 進來訊息 → 純終端機 session,不干涉
if (lastWebInbound === -1) process.exit(0);

// 最新的 web 訊息比最後一次 reply 還新 → 還沒回 web → 擋下
if (lastWebInbound > lastReply) {
  const out = {
    decision: 'block',
    reason:
      '[web-reply 防呆] 偵測到最新的 study-web 訊息「還沒用 reply 工具回覆」——' +
      '你的終端機輸出使用者在瀏覽器看不到。請呼叫 mcp__study-web__reply 回應使用者' +
      '（即使只更新了講義 show_notes,也要在聊天 reply 一句),再結束回合。'
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

process.exit(0);
