export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-TG-User-Id, X-TG-Username, X-TG-Name"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const feeRate = parseFloat(env.PLATFORM_FEE_RATE || "0.10");
    const minWithdraw = parseFloat(env.MIN_WITHDRAW_USDT || "10");
    const platformWallet = env.PLATFORM_TON_WALLET || "UQAi7GWc5DAPgpJxX7eOA_NijNeUHxpiirzAFi1OerKDRt85";

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });

    async function notifyAdmin(text) {
      if (!env.TELEGRAM_BOT_TOKEN || !env.ADMIN_CHAT_ID) return;
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.ADMIN_CHAT_ID,
            text,
            parse_mode: "HTML"
          })
        });
      } catch (e) {}
    }

    async function ensureUser(tgId, username, displayName) {
      if (!tgId) return null;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO gig_users (tg_id, username, display_name) VALUES (?, ?, ?)`
      ).bind(tgId, username || "", displayName || username || tgId).run();
      return await env.DB.prepare(`SELECT * FROM gig_users WHERE tg_id = ?`).bind(tgId).first();
    }

    try {
      // 1. Health & Config
      if (path === "/api/gig/config" && request.method === "GET") {
        return json({
          ok: true,
          feeRate,
          minWithdraw,
          platformWallet,
          supportBot: env.SUPPORT_BOT_USERNAME || "Userstudiobot"
        });
      }

      // 2. Bootstrap (Users, Tasks, Reviews)
      if (path === "/api/gig/bootstrap" && request.method === "GET") {
        const tgId = request.headers.get("X-TG-User-Id") || url.searchParams.get("tg_id");
        const username = request.headers.get("X-TG-Username") || "";
        const displayName = decodeURIComponent(request.headers.get("X-TG-Name") || username || "TG User");
        if (tgId) await ensureUser(tgId, username, displayName);

        const users = (await env.DB.prepare(`SELECT * FROM gig_users`).all()).results || [];
        const tasks = (await env.DB.prepare(`SELECT * FROM gig_tasks ORDER BY created_at DESC LIMIT 100`).all()).results || [];
        const reviews = (await env.DB.prepare(`SELECT * FROM gig_reviews ORDER BY id DESC LIMIT 100`).all()).results || [];
        return json({ ok: true, config: { feeRate, minWithdraw, platformWallet }, users, tasks, reviews });
      }

      // 3. Publish Task / Bounty
      if (path === "/api/gig/tasks" && request.method === "POST") {
        const body = await request.json();
        const { employer_id, employer_name, mode, category, title, reward_usdt, deadline, location, description, escrow_tx } = body;
        if (!employer_id || !title || !reward_usdt || reward_usdt <= 0) {
          return json({ ok: false, error: "Invalid task parameters" }, 400);
        }
        await ensureUser(employer_id, "", employer_name || employer_id);
        const id = "T-" + Math.floor(10000 + Math.random() * 90000);
        const escrowed = mode === "BOUNTY" && escrow_tx ? 1 : 0;

        await env.DB.prepare(
          `INSERT INTO gig_tasks (id, mode, category, title, reward_usdt, fee_rate, escrowed, escrow_tx, deadline, location, description, employer_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, mode || "BOUNTY", category || "软件开发", title, reward_usdt, feeRate, escrowed, escrow_tx || "", deadline || "72h", location || "Remote", description || "", employer_id).run();

        if (escrowed) {
          await env.DB.prepare(`UPDATE gig_users SET frozen_usdt = frozen_usdt + ? WHERE tg_id = ?`).bind(reward_usdt, employer_id).run();
          await notifyAdmin(`🏆 <b>新悬赏任务托管</b>\n任务：${title}\n赏金：<b>${reward_usdt} USDT</b>（抽佣 ${Math.round(feeRate * 100)}%）\n雇主：${employer_name} (${employer_id})\nTON TX: <code>${escrow_tx}</code>`);
        }
        return json({ ok: true, id });
      }

      // 4. Accept Task
      if (path.match(/^\/api\/gig\/tasks\/[^/]+\/accept$/) && request.method === "POST") {
        const taskId = path.split("/")[4];
        const { worker_id, worker_name } = await request.json();
        await ensureUser(worker_id, "", worker_name || worker_id);
        const task = await env.DB.prepare(`SELECT * FROM gig_tasks WHERE id = ?`).bind(taskId).first();
        if (!task || task.status !== "OPEN") return json({ ok: false, error: "Task unavailable" }, 400);
        if (task.employer_id === worker_id) return json({ ok: false, error: "Cannot accept own task" }, 400);

        await env.DB.prepare(`UPDATE gig_tasks SET worker_id = ?, status = 'IN_PROGRESS' WHERE id = ?`).bind(worker_id, taskId).run();
        return json({ ok: true });
      }

      // 5. Submit Work
      if (path.match(/^\/api\/gig\/tasks\/[^/]+\/submit$/) && request.method === "POST") {
        const taskId = path.split("/")[4];
        const { worker_id, delivery_note } = await request.json();
        const task = await env.DB.prepare(`SELECT * FROM gig_tasks WHERE id = ?`).bind(taskId).first();
        if (!task || task.worker_id !== worker_id) return json({ ok: false, error: "Unauthorized" }, 403);

        await env.DB.prepare(`UPDATE gig_tasks SET delivery_note = ?, status = 'SUBMITTED' WHERE id = ?`).bind(delivery_note || "", taskId).run();
        return json({ ok: true });
      }

      // 6. Approve & Pay (Auto-deduct 10% Platform Commission)
      if (path.match(/^\/api\/gig\/tasks\/[^/]+\/approve$/) && request.method === "POST") {
        const taskId = path.split("/")[4];
        const { employer_id } = await request.json();
        const task = await env.DB.prepare(`SELECT * FROM gig_tasks WHERE id = ?`).bind(taskId).first();
        if (!task || task.employer_id !== employer_id || task.status !== "SUBMITTED") {
          return json({ ok: false, error: "Cannot approve task" }, 400);
        }
        const rate = task.fee_rate ?? feeRate;
        const platformFee = Number((task.reward_usdt * rate).toFixed(2));
        const workerNet = Number((task.reward_usdt - platformFee).toFixed(2));

        await env.DB.batch([
          env.DB.prepare(`UPDATE gig_tasks SET status = 'COMPLETED' WHERE id = ?`).bind(taskId),
          env.DB.prepare(`UPDATE gig_users SET frozen_usdt = MAX(0, frozen_usdt - ?) WHERE tg_id = ?`).bind(task.reward_usdt, employer_id),
          env.DB.prepare(`UPDATE gig_users SET balance_usdt = balance_usdt + ? WHERE tg_id = ?`).bind(workerNet, task.worker_id)
        ]);

        await notifyAdmin(`✅ <b>任务验收放款完成</b>\n单号：${taskId}\n总赏金：${task.reward_usdt} USDT\n接单人实得：<b>${workerNet} USDT</b>\n平台抽佣(${Math.round(rate * 100)}%)：<b>${platformFee} USDT</b>`);
        return json({ ok: true, workerNet, platformFee });
      }

      // 7. Bidirectional Review
      if (path.match(/^\/api\/gig\/tasks\/[^/]+\/review$/) && request.method === "POST") {
        const taskId = path.split("/")[4];
        const { kind, reviewer_id, reviewer_name, stars, tags, comment } = await request.json();
        const task = await env.DB.prepare(`SELECT * FROM gig_tasks WHERE id = ?`).bind(taskId).first();
        if (!task || task.status !== "COMPLETED") return json({ ok: false, error: "Task not completed" }, 400);

        const targetId = kind === "task" ? task.worker_id : task.employer_id;
        await env.DB.prepare(
          `INSERT INTO gig_reviews (task_id, kind, reviewer_id, reviewer_name, target_id, stars, tags, comment)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(taskId, kind, reviewer_id, reviewer_name, targetId, stars, tags || "", comment || "").run();

        const target = await env.DB.prepare(`SELECT * FROM gig_users WHERE tg_id = ?`).bind(targetId).first();
        if (target) {
          if (kind === "task") {
            const newCount = target.worker_count + 1;
            const newScore = (target.worker_score * target.worker_count + stars) / newCount;
            await env.DB.prepare(`UPDATE gig_users SET worker_score = ?, worker_count = ? WHERE tg_id = ?`).bind(newScore, newCount, targetId).run();
          } else {
            const newCount = target.employer_count + 1;
            const newScore = (target.employer_score * target.employer_count + stars) / newCount;
            await env.DB.prepare(`UPDATE gig_users SET employer_score = ?, employer_count = ? WHERE tg_id = ?`).bind(newScore, newCount, targetId).run();
          }
        }
        return json({ ok: true });
      }

      // 8. Worker Withdrawal Request (Min 10 USDT -> Telegram Admin Notification)
      if (path === "/api/gig/withdraw" && request.method === "POST") {
        const { tg_id, username, amount_usdt, ton_wallet } = await request.json();
        const amt = parseFloat(amount_usdt || "0");
        if (!tg_id || !ton_wallet || amt < minWithdraw) {
          return json({ ok: false, error: `最低提现金额为 ${minWithdraw} USDT，且需填写有效 TON 钱包地址` }, 400);
        }
        const user = await env.DB.prepare(`SELECT * FROM gig_users WHERE tg_id = ?`).bind(tg_id).first();
        if (!user || user.balance_usdt < amt) {
          return json({ ok: false, error: "可提现余额不足" }, 400);
        }

        await env.DB.batch([
          env.DB.prepare(`UPDATE gig_users SET balance_usdt = balance_usdt - ?, ton_wallet = ? WHERE tg_id = ?`).bind(amt, ton_wallet, tg_id),
          env.DB.prepare(`INSERT INTO gig_withdrawals (tg_id, username, amount_usdt, ton_wallet) VALUES (?, ?, ?, ?)`).bind(tg_id, username || "", amt, ton_wallet)
        ]);

        await notifyAdmin(`💸 <b>新提现申请（待人工审核放款）</b>\n用户：${user.display_name} (@${username || tg_id})\n提现金额：<b>${amt} USDT</b>\n收款 TON 钱包：\n<code>${ton_wallet}</code>`);
        return json({ ok: true, message: "提现申请已提交，将通过 @Userstudiobot 审核并打款至您的 TON 钱包" });
      }

      // 9. Dispute Arbitration Ticket
      if (path === "/api/gig/dispute" && request.method === "POST") {
        const { task_id, requester_id, requester_name, reason } = await request.json();
        await env.DB.prepare(`UPDATE gig_tasks SET status = 'DISPUTED' WHERE id = ?`).bind(task_id).run();
        await notifyAdmin(`⚖️ <b>零工任务纠纷仲裁申请</b>\n单号：${task_id}\n申请人：${requester_name} (${requester_id})\n原因：${reason || "交付存在争议"}`);
        return json({ ok: true });
      }

      return json({ ok: false, error: "Not Found" }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err.message || err) }, 500);
    }
  }
};

