const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-TG-Init-Data",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

async function tgApi(token, method, payload) {
  if (!token) return { ok: false, description: "NO_BOT_TOKEN" };
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function notify(env, chatId, text, reply_markup) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  const body = { chat_id: chatId, text };
  if (reply_markup) body.reply_markup = reply_markup;
  await tgApi(env.TELEGRAM_BOT_TOKEN, "sendMessage", body);
}

async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secretBytes = await crypto.subtle.sign("HMAC", secretKey, enc.encode(botToken));
  const hmacKey = await crypto.subtle.importKey(
    "raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(dataCheckString));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== hash) return null;

  try {
    const u = JSON.parse(params.get("user") || "null");
    if (!u?.id) return null;
    return {
      id: String(u.id),
      name: [u.first_name, u.last_name].filter(Boolean).join(" ") || "TG User",
      username: u.username || "",
    };
  } catch {
    return null;
  }
}

async function broadcastTask(env, task) {
  if (!env.CHANNEL_ID) return;
  const net = Math.max(1, Math.floor(task.bounty_stars * (1 - (task.fee_rate ?? 0.2))));
  const text = `🔥 新悬赏已托管上架\n\n📌 ${task.title}\n🏷 分类：${task.category}\n⭐ 悬赏总额：${task.bounty_stars} Stars（验收实得 ${net} ⭐）\n🛡️ 资金已由平台托管`;
  const markup = env.MINIAPP_LINK
    ? { inline_keyboard: [[{ text: "🚀 打开大厅立即接单", url: env.MINIAPP_LINK }]] }
    : undefined;
  await notify(env, env.CHANNEL_ID, text, markup);
}

async function refundTaskFunds(env, task) {
  if (task.pay_source === "BALANCE" || !task.charge_id) {
    await env.DB.prepare("UPDATE star_users SET balance = balance + ? WHERE tg_id = ?")
      .bind(task.bounty_stars, task.employer_id).run();
    return { ok: true };
  }
  const r = await tgApi(env.TELEGRAM_BOT_TOKEN, "refundStarPayment", {
    user_id: Number(task.employer_id),
    telegram_payment_charge_id: task.charge_id,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.description || "REFUND_FAILED" };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    const feeRate = parseFloat(env.PLATFORM_FEE_RATE || "0.2");

    try {
      // 1. Telegram Webhook：Stars 支付回调 + 管理员核销/仲裁按钮回调
      if (path === "/webhook" && request.method === "POST") {
        const update = await request.json();

        if (update.pre_checkout_query) {
          await tgApi(env.TELEGRAM_BOT_TOKEN, "answerPreCheckoutQuery", {
            pre_checkout_query_id: update.pre_checkout_query.id,
            ok: true,
          });
          return json({ ok: true });
        }

        const sp = update.message?.successful_payment;
        if (sp && sp.invoice_payload?.startsWith("task:")) {
          const taskId = sp.invoice_payload.slice(5);
          const chargeId = sp.telegram_payment_charge_id || "";
          await env.DB.prepare(
            "UPDATE star_tasks SET status = 'OPEN', charge_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'PENDING_PAY'"
          ).bind(chargeId, taskId).run();

          const task = await env.DB.prepare("SELECT * FROM star_tasks WHERE id = ?").bind(taskId).first();
          if (task) {
            await notify(env, env.ADMIN_CHAT_ID, `⭐ 新悬赏已托管入库\n📌 ${task.title}\n💰 ${task.bounty_stars} Stars\n👤 雇主：${task.employer_name} (${task.employer_id})`);
            await broadcastTask(env, task);
          }
          return json({ ok: true });
        }

        const cq = update.callback_query;
        if (cq && String(cq.from?.id) === String(env.ADMIN_CHAT_ID)) {
          const [action, id] = String(cq.data || "").split(":");
          const msgChatId = cq.message?.chat?.id;
          const msgId = cq.message?.message_id;
          const origText = cq.message?.text || "";

          if (action === "wd_ok" || action === "wd_rej") {
            const wd = await env.DB.prepare("SELECT * FROM star_withdrawals WHERE id = ?").bind(id).first();
            if (wd && wd.status === "PENDING") {
              if (action === "wd_ok") {
                await env.DB.prepare("UPDATE star_withdrawals SET status = 'PAID' WHERE id = ?").bind(id).run();
                await notify(env, wd.tg_id, `✅ 你的提现申请（${wd.amount_stars} ⭐）已完成打款，请查收 TON 钱包！`);
                await tgApi(env.TELEGRAM_BOT_TOKEN, "editMessageText", { chat_id: msgChatId, message_id: msgId, text: origText + "\n\n✅ [已标记打款]" });
              } else {
                await env.DB.batch([
                  env.DB.prepare("UPDATE star_withdrawals SET status = 'REJECTED' WHERE id = ?").bind(id),
                  env.DB.prepare("UPDATE star_users SET balance = balance + ? WHERE tg_id = ?").bind(wd.amount_stars, wd.tg_id),
                ]);
                await notify(env, wd.tg_id, `❌ 你的提现申请（${wd.amount_stars} ⭐）已被驳回，余额已退回平台钱包。`);
                await tgApi(env.TELEGRAM_BOT_TOKEN, "editMessageText", { chat_id: msgChatId, message_id: msgId, text: origText + "\n\n❌ [已驳回并退回余额]" });
              }
            }
          }

          if (action === "arb_pay" || action === "arb_ref") {
            const task = await env.DB.prepare("SELECT * FROM star_tasks WHERE id = ?").bind(id).first();
            if (task && task.status === "DISPUTED") {
              if (action === "arb_pay") {
                const netStars = Math.max(1, Math.floor(task.bounty_stars * (1 - (task.fee_rate ?? feeRate))));
                await env.DB.batch([
                  env.DB.prepare("UPDATE star_tasks SET status = 'COMPLETED', updated_at = datetime('now') WHERE id = ?").bind(id),
                  env.DB.prepare("UPDATE star_users SET balance = balance + ? WHERE tg_id = ?").bind(netStars, task.worker_id),
                ]);
                await notify(env, task.worker_id, `⚖️ 仲裁完成：悬赏「${task.title}」已裁决放款 ${netStars} ⭐ 到你的钱包。`);
                await notify(env, task.employer_id, `⚖️ 仲裁完成：悬赏「${task.title}」已裁决放款给接单人。`);
                await tgApi(env.TELEGRAM_BOT_TOKEN, "editMessageText", { chat_id: msgChatId, message_id: msgId, text: origText + "\n\n✅ [已裁决放款给接单人]" });
              } else {
                const rf = await refundTaskFunds(env, task);
                if (rf.ok) {
                  await env.DB.prepare("UPDATE star_tasks SET status = 'REFUNDED', updated_at = datetime('now') WHERE id = ?").bind(id).run();
                  await notify(env, task.employer_id, `⚖️ 仲裁完成：悬赏「${task.title}」已裁决退款给雇主。`);
                  await notify(env, task.worker_id, `⚖️ 仲裁完成：悬赏「${task.title}」已裁决退款给雇主。`);
                  await tgApi(env.TELEGRAM_BOT_TOKEN, "editMessageText", { chat_id: msgChatId, message_id: msgId, text: origText + "\n\n↩️ [已裁决退款给雇主]" });
                }
              }
            }
          }
          await tgApi(env.TELEGRAM_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "已处理" });
        }
        return json({ ok: true });
      }

      // 以下所有 /api/* 接口强制校验 Telegram initData 签名
      const tgUser = await verifyInitData(request.headers.get("X-TG-Init-Data"), env.TELEGRAM_BOT_TOKEN);
      if (!tgUser) return json({ ok: false, error: "请在 Telegram 内打开小程序（签名校验失败）" }, 401);

      // 2. 初始化数据
      if (path === "/api/bootstrap" && request.method === "GET") {
        await env.DB.prepare(
          "INSERT INTO star_users (tg_id, name, username) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET name=excluded.name, username=excluded.username"
        ).bind(tgUser.id, tgUser.name, tgUser.username).run();

        const user = await env.DB.prepare("SELECT * FROM star_users WHERE tg_id = ?").bind(tgUser.id).first();
        const tasks = (
          await env.DB.prepare("SELECT * FROM star_tasks WHERE status != 'PENDING_PAY' ORDER BY created_at DESC LIMIT 100").all()
        ).results;
        const withdrawals = (
          await env.DB.prepare("SELECT * FROM star_withdrawals WHERE tg_id = ? ORDER BY created_at DESC LIMIT 20").bind(tgUser.id).all()
        ).results;

        return json({ ok: true, user, tasks, withdrawals, feeRate });
      }

      // 3. 发单（支持 Stars 支付托管 或 平台余额直接复投）
      if (path === "/api/tasks/create-invoice" && request.method === "POST") {
        const b = await request.json();
        const bounty = Math.floor(Number(b.bounty_stars || 0));
        if (!b.title?.trim() || bounty < 1) return json({ ok: false, error: "请输入标题且赏金至少 1 Star" }, 400);

        const taskId = "T" + Date.now().toString(36).toUpperCase();

        if (b.pay_with_balance) {
          const u = await env.DB.prepare("SELECT balance FROM star_users WHERE tg_id = ?").bind(tgUser.id).first();
          if (!u || u.balance < bounty) return json({ ok: false, error: "平台余额不足" }, 400);

          await env.DB.batch([
            env.DB.prepare("UPDATE star_users SET balance = balance - ? WHERE tg_id = ?").bind(bounty, tgUser.id),
            env.DB.prepare(
              `INSERT INTO star_tasks (id, employer_id, employer_name, employer_username, title, description, category, bounty_stars, fee_rate, status, pay_source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 'BALANCE')`
            ).bind(taskId, tgUser.id, tgUser.name, tgUser.username, b.title.trim(), (b.description || "").trim(), b.category || "开发/技术", bounty, feeRate),
          ]);
          const task = await env.DB.prepare("SELECT * FROM star_tasks WHERE id = ?").bind(taskId).first();
          await notify(env, env.ADMIN_CHAT_ID, `💰 新悬赏（余额复投）\n📌 ${task.title}\n⭐ ${bounty} Stars\n👤 ${tgUser.name}`);
          await broadcastTask(env, task);
          return json({ ok: true, paidByBalance: true, taskId });
        }

        await env.DB.prepare(
          `INSERT INTO star_tasks (id, employer_id, employer_name, employer_username, title, description, category, bounty_stars, fee_rate, status, pay_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAY', 'STARS')`
        ).bind(taskId, tgUser.id, tgUser.name, tgUser.username, b.title.trim(), (b.description || "").trim(), b.category || "开发/技术", bounty, feeRate).run();

        const inv = await tgApi(env.TELEGRAM_BOT_TOKEN, "createInvoiceLink", {
          title: `悬赏托管：${b.title.trim().slice(0, 28)}`,
          description: `平台中间保管 ${bounty} Stars，验收后自动发放给接单人（未接单可原路退回）`,
          payload: `task:${taskId}`,
          currency: "XTR",
          prices: [{ label: "悬赏托管金额", amount: bounty }],
        });
        if (!inv.ok) return json({ ok: false, error: inv.description || "创建支付链接失败" }, 500);
        return json({ ok: true, taskId, invoiceUrl: inv.result });
      }

      // 4. 接单
      if (path === "/api/tasks/claim" && request.method === "POST") {
        const { task_id } = await request.json();
        const task = await env.DB.prepare("SELECT * FROM star_tasks WHERE id = ?").bind(task_id).first();
        if (!task || task.status !== "OPEN") return json({ ok: false, error: "任务不可接单" }, 400);
        if (String(task.employer_id) === tgUser.id) return json({ ok: false, error: "不能接自己发布的悬赏" }, 400);

        await env.DB.prepare(
          "UPDATE star_tasks SET status='IN_PROGRESS', worker_id=?, worker_name=?, worker_username=?, claimed_at=datetime('now'), updated_at=datetime('now') WHERE id=?"
        ).bind(tgUser.id, tgUser.name, tgUser.username, task_id).run();

        await notify(env, task.employer_id, `🤝 你的悬赏「${task.title}」已被 ${tgUser.name} 接单，请留意交付进度。`);
        return json({ ok: true });
      }

      // 5. 接单超 48 小时未交付 -> 雇主一键释放任务
      if (path === "/api/tasks/release" && request.method === "POST") {
        const { task_id } = await request.json();
        const task = await env.DB.prepare("SELECT * FROM star_tasks WHERE id = ?").bind(task_id).first();
        if (!task || task.status !== "IN_PROGRESS" || String(task.employer_id) !== tgUser.id)
          return json({ ok: false, error: "无权释放或状态不符" }, 400);

        const claimedMs = task.claimed_at ? Date.parse(task.claimed_at + "Z") : 0;
        if (Date.now() - claimedMs < 48 * 3600 * 1000)
          return json({ ok: false, error: "接单未满 48 小时，暂不可强制释放" }, 400);

        await env.DB.prepare(
          "UPDATE star_tasks SET status='OPEN', worker_id=NULL, worker_name=NULL, worker_username=NULL, claimed_at=NULL, updated_at=datetime('now') WHERE id=?"
        ).bind(task_id).run();
        await notify(env, task.worker_id, `⏱ 悬赏「${task.title}」因超过 48 小时未交付，已被雇主重新释放回大厅。`);
        return json({ ok: true });
      }

      // 6. 接单人提交交付
      if (path === "/api/tasks/deliver" && request.method === "POST") {
        const { task_id, note } = await request.json();
        const task = await env.DB.prepare("SELECT * FROM star_tasks WHERE id = ?").bind(task_id).first();
        if (!task || task.status !== "IN_PROGRESS" || String(task.worker_id) !== tgUser.id)
          return json({ ok: false, error: "无权交付或状态不符" }, 400);

        await env.DB.prepare(
          "UPDATE star_tasks SET status='DELIVERED', deliver_note=?, updated_at=datetime('now') WHERE id=?"
        ).bind((note || "已完成交付").trim(), task_id).run();

        await notify(env, task.employer_id, `📦 悬赏「${task.title}」已提交交付：\n${note || "请进入小程序验收"}\n请前往小程序确认验收并放款。`);
        return json({ ok: true });
      }

      // 7. 雇主验收放款
      if (path === "/api/tasks/approve" && request.method === "POST") {
        const { task_id } = await request.json();
        const task = await env.DB.prepare("SELECT * FROM star_tasks WHERE id = ?").bind(task_id).first();
        if (!task || task.status !== "DELIVERED" || String(task.employer_id) !== tgUser.id)
          return json({ ok: false, error: "无权验收或状态不符" }, 400);

        const netStars = Math.max(1, Math.floor(task.bounty_stars * (1 - (task.fee_rate ?? feeRate))));
        const feeStars = task.bounty_stars - netStars;

        await env.DB.batch([
          env.DB.prepare("UPDATE star_tasks SET status='COMPLETED', updated_at=datetime('now') WHERE id=?").bind(task_id),
          env.DB.prepare("UPDATE star_users SET balance = balance + ? WHERE tg_id = ?").bind(netStars, task.worker_id),
        ]);

        await notify(env, task.worker_id, `🎉 悬赏「${task.title}」已验收通过！\n💰 实得 ${netStars} ⭐（已扣平台服务费 ${feeStars} ⭐），已入账钱包。`);
        await notify(env, env.ADMIN_CHAT_ID, `✅ 订单结算完成\n任务：${task.title}\n总额：${task.bounty_stars} ⭐ | 抽成：${feeStars} ⭐ | 实发：${netStars} ⭐`);
        return json({ ok: true, netStars, feeStars });
      }

      // 8. 申请平台仲裁
      if (path === "/api/tasks/dispute" && request.method === "POST") {
        const { task_id, reason } = await request.json();
        const task = await env.DB.prepare("SELECT * FROM star_tasks WHERE id = ?").bind(task_id).first();
        if (!task || !["IN_PROGRESS", "DELIVERED"].includes(task.status))
          return json({ ok: false, error: "当前状态不可申请仲裁" }, 400);
        if (String(task.employer_id) !== tgUser.id && String(task.worker_id) !== tgUser.id)
          return json({ ok: false, error: "无权操作" }, 403);

        await env.DB.prepare("UPDATE star_tasks SET status='DISPUTED', updated_at=datetime('now') WHERE id=?").bind(task_id).run();
        await notify(
          env,
          env.ADMIN_CHAT_ID,
          `⚖️ 收到平台仲裁申请\n单号：${task.id}\n📌 任务：${task.title}\n⭐ 金额：${task.bounty_stars} Stars\n👤 申请人：${tgUser.name} (${tgUser.id})\n📝 理由：${reason || "未填写"}\n📦 交付说明：${task.deliver_note || "无"}`,
          {
            inline_keyboard: [[
              { text: "✅ 放款给接单人", callback_data: `arb_pay:${task.id}` },
              { text: "↩️ 退款给雇主", callback_data: `arb_ref:${task.id}` },
            ]],
          }
        );
        return json({ ok: true });
      }

      // 9. 雇主取消未接单任务 -> 退款
      if (path === "/api/tasks/refund" && request.method === "POST") {
        const { task_id } = await request.json();
        const task = await env.DB.prepare("SELECT * FROM star_tasks WHERE id = ?").bind(task_id).first();
        if (!task || task.status !== "OPEN" || String(task.employer_id) !== tgUser.id)
          return json({ ok: false, error: "仅支持无人接单时退款" }, 400);

        const rf = await refundTaskFunds(env, task);
        if (!rf.ok) return json({ ok: false, error: "退款失败: " + rf.error }, 500);

        await env.DB.prepare("UPDATE star_tasks SET status='REFUNDED', updated_at=datetime('now') WHERE id=?").bind(task_id).run();
        return json({ ok: true });
      }

      // 10. 申请提现（仅 TON 链 + 管理员 TG 按钮核销）
      if (path === "/api/withdraw" && request.method === "POST") {
        const { amount_stars, address } = await request.json();
        const amt = Math.floor(Number(amount_stars || 0));
        const addr = String(address || "").trim();
        const isTon = /^((UQ|EQ|kQ|0Q)[A-Za-z0-9_-]{46}|0:[0-9a-fA-F]{64})$/.test(addr);
        if (amt < 100) return json({ ok: false, error: "最低提现 100 Stars" }, 400);
        if (!isTon) return json({ ok: false, error: "仅支持 TON 链地址（请填写 UQ/EQ 开头的 TON 钱包地址）" }, 400);

        const user = await env.DB.prepare("SELECT * FROM star_users WHERE tg_id = ?").bind(tgUser.id).first();
        if (!user || user.balance < amt) return json({ ok: false, error: "余额不足" }, 400);

        const wid = "W" + Date.now().toString(36).toUpperCase();
        await env.DB.batch([
          env.DB.prepare("UPDATE star_users SET balance = balance - ? WHERE tg_id = ?").bind(amt, tgUser.id),
          env.DB.prepare("INSERT INTO star_withdrawals (id, tg_id, user_name, amount_stars, payout_address) VALUES (?, ?, ?, ?, ?)")
            .bind(wid, tgUser.id, tgUser.name, amt, addr),
        ]);

        await notify(
          env,
          env.ADMIN_CHAT_ID,
          `💸 收到 Stars 提现申请\n单号：${wid}\n👤 用户：${tgUser.name} (${tgUser.id})\n⭐ 金额：${amt} Stars\n🏦 TON 链地址：${addr}`,
          {
            inline_keyboard: [[
              { text: "✅ 标记已打款", callback_data: `wd_ok:${wid}` },
              { text: "❌ 驳回退回余额", callback_data: `wd_rej:${wid}` },
            ]],
          }
        );
        return json({ ok: true, id: wid });
      }

      return json({ ok: false, error: "NOT_FOUND" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  },
};
