export const schema = [
  "CREATE TABLE IF NOT EXISTS mini_bank_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mini_bank_ops(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,actor TEXT NOT NULL,message_id TEXT NOT NULL,type TEXT NOT NULL,business_date TEXT NOT NULL,created_at TEXT NOT NULL,salary_cycle TEXT,deleted_at TEXT,write_token TEXT,UNIQUE(owner,message_id))",
  "CREATE TABLE IF NOT EXISTS mini_bank_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,op_id INTEGER NOT NULL REFERENCES mini_bank_ops(id),wallet TEXT NOT NULL CHECK(wallet IN ('saving','harian')),direction TEXT NOT NULL CHECK(direction IN ('in','out')),amount INTEGER NOT NULL CHECK(amount>=0 AND amount<=1000000000000),category TEXT NOT NULL,description TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_mb_owner_date ON mini_bank_ops(owner,business_date)",
  "CREATE INDEX IF NOT EXISTS idx_mb_entries_op ON mini_bank_entries(op_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_mb_salary_cycle ON mini_bank_ops(owner,salary_cycle) WHERE type='gaji' AND deleted_at IS NULL",
  "CREATE TABLE IF NOT EXISTS cloud_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS cloud_archive(table_name TEXT NOT NULL,row_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS cloud_sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL,revision TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS cloud_attempts(key TEXT PRIMARY KEY,failures INTEGER NOT NULL,until INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO cloud_attempts VALUES('pin',0,0)",
  "CREATE TRIGGER IF NOT EXISTS mb_no_overdraft BEFORE INSERT ON mini_bank_entries\nWHEN NEW.direction='out' AND EXISTS(SELECT 1 FROM cloud_state WHERE key='ready')\nBEGIN\n SELECT CASE WHEN NEW.amount>COALESCE((SELECT SUM(CASE e.direction WHEN 'in' THEN e.amount ELSE -e.amount END) FROM mini_bank_entries e JOIN mini_bank_ops o ON o.id=e.op_id WHERE o.owner=(SELECT owner FROM mini_bank_ops WHERE id=NEW.op_id) AND o.deleted_at IS NULL AND e.wallet=NEW.wallet),0) THEN RAISE(ABORT,'INSUFFICIENT_BALANCE') END;\nEND;"
];
