-- GigBounty Studio D1 Schema (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS gig_users (
  tg_id TEXT PRIMARY KEY,
  username TEXT DEFAULT '',
  display_name TEXT NOT NULL,
  ton_wallet TEXT DEFAULT '',
  balance_usdt REAL DEFAULT 0,
  frozen_usdt REAL DEFAULT 0,
  employer_score REAL DEFAULT 5.0,
  employer_count INTEGER DEFAULT 0,
  worker_score REAL DEFAULT 5.0,
  worker_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gig_tasks (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,           -- 'BOUNTY' | 'NORMAL'
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  reward_usdt REAL NOT NULL,
  fee_rate REAL DEFAULT 0.10,
  escrowed INTEGER DEFAULT 0,   -- 0 or 1
  escrow_tx TEXT DEFAULT '',
  deadline TEXT DEFAULT '',
  location TEXT DEFAULT '',
  description TEXT NOT NULL,
  status TEXT DEFAULT 'OPEN',   -- 'OPEN' | 'IN_PROGRESS' | 'SUBMITTED' | 'COMPLETED' | 'DISPUTED'
  employer_id TEXT NOT NULL,
  worker_id TEXT DEFAULT '',
  delivery_note TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gig_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'task' (employer->worker) | 'employer' (worker->employer)
  reviewer_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  target_id TEXT NOT NULL,
  stars INTEGER NOT NULL,
  tags TEXT DEFAULT '',
  comment TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gig_withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT NOT NULL,
  username TEXT DEFAULT '',
  amount_usdt REAL NOT NULL,
  ton_wallet TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING', -- 'PENDING' | 'PAID' | 'REJECTED'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

