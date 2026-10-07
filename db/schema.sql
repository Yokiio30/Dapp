-- 链上小银行：交易记录数据库（SQLite）
-- 数据全部来自链上事件（Deposited / Withdrawn / Transferred），由索引器写入，
-- 前端和 API 只读，所以记录无法被用户伪造；数据库丢了也可以从链上重建。
--
-- 金额一律以 wei 的十进制字符串保存（TEXT）：1 ETH = 10^18，会超出 SQLite 的 64 位整数，
-- 用浮点又会丢精度。需要求和时请用 users 表（索引器用 BigInt 算好），不要对 amount_wei 直接 SUM。
-- 地址一律小写。

-- 1. 交易流水：每个链上事件一行，所有用户的记录都在这里
CREATE TABLE IF NOT EXISTS transactions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id         INTEGER NOT NULL,
  contract_address TEXT    NOT NULL,
  tx_hash          TEXT    NOT NULL,
  log_index        INTEGER NOT NULL,             -- 事件在区块内的序号（一笔交易可含多个事件）
  block_number     INTEGER NOT NULL,
  block_time       INTEGER NOT NULL,             -- 区块时间，Unix 秒
  type             TEXT    NOT NULL CHECK (type IN ('deposit', 'withdraw', 'transfer')),
  from_address     TEXT    NOT NULL,             -- 存款/取款：操作的用户；转账：转出方
  to_address       TEXT,                         -- 仅转账有值：收款方
  amount_wei       TEXT    NOT NULL CHECK (amount_wei <> '' AND amount_wei NOT GLOB '*[^0-9]*'),
  UNIQUE (chain_id, contract_address, tx_hash, log_index),
  CHECK ((type = 'transfer') = (to_address IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions (chain_id, contract_address, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS idx_tx_from  ON transactions (from_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_tx_to    ON transactions (to_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_tx_type  ON transactions (type);

-- 2. 用户汇总：每个出现过的地址一行，每次同步后由索引器按流水重新计算受影响的地址
CREATE TABLE IF NOT EXISTS users (
  chain_id             INTEGER NOT NULL,
  contract_address     TEXT    NOT NULL,
  address              TEXT    NOT NULL,
  tx_count             INTEGER NOT NULL,
  first_tx_time        INTEGER NOT NULL,
  last_tx_time         INTEGER NOT NULL,
  total_deposited_wei  TEXT    NOT NULL,
  total_withdrawn_wei  TEXT    NOT NULL,
  total_sent_wei       TEXT    NOT NULL,         -- 转出总额
  total_received_wei   TEXT    NOT NULL,         -- 转入总额
  balance_wei          TEXT    NOT NULL,         -- 存款 + 转入 - 取款 - 转出，应与合约 balanceOf 一致
  PRIMARY KEY (chain_id, contract_address, address)
);

-- 3. 同步进度：每个（链, 合约）已处理到的区块，重启后从这里继续
CREATE TABLE IF NOT EXISTS sync_state (
  chain_id         INTEGER NOT NULL,
  contract_address TEXT    NOT NULL,
  last_block       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract_address)
);
