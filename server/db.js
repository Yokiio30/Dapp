// 数据库访问层：基于 Node 内置的 node:sqlite（需要 Node >= 22.13，无需安装任何原生依赖）
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = path.join(__dirname, "..", "db", "schema.sql");
const MAX_LIMIT = 100;

function createStore({ dbPath, chainId, contractAddress }) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));

  const chain = Number(chainId);
  const contract = contractAddress.toLowerCase();
  const scope = [chain, contract];

  const q = {
    getState: db.prepare("SELECT last_block FROM sync_state WHERE chain_id = ? AND contract_address = ?"),
    setState: db.prepare(
      `INSERT INTO sync_state (chain_id, contract_address, last_block, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (chain_id, contract_address) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at`
    ),
    addrsInRange: db.prepare(
      `SELECT from_address AS a FROM transactions WHERE chain_id = ? AND contract_address = ? AND block_number BETWEEN ? AND ?
       UNION
       SELECT to_address FROM transactions WHERE chain_id = ? AND contract_address = ? AND block_number BETWEEN ? AND ? AND to_address IS NOT NULL`
    ),
    keysInRange: db.prepare(
      "SELECT tx_hash, log_index, block_number FROM transactions WHERE chain_id = ? AND contract_address = ? AND block_number BETWEEN ? AND ?"
    ),
    countAll: db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE chain_id = ? AND contract_address = ?"),
    deleteRange: db.prepare(
      "DELETE FROM transactions WHERE chain_id = ? AND contract_address = ? AND block_number BETWEEN ? AND ?"
    ),
    insertTx: db.prepare(
      `INSERT OR IGNORE INTO transactions
       (chain_id, contract_address, tx_hash, log_index, block_number, block_time, type, from_address, to_address, amount_wei)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    userRows: db.prepare(
      `SELECT type, from_address, to_address, amount_wei, block_time FROM transactions
       WHERE chain_id = ? AND contract_address = ? AND (from_address = ? OR to_address = ?)`
    ),
    upsertUser: db.prepare(
      `INSERT INTO users (chain_id, contract_address, address, tx_count, first_tx_time, last_tx_time,
         total_deposited_wei, total_withdrawn_wei, total_sent_wei, total_received_wei, balance_wei)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chain_id, contract_address, address) DO UPDATE SET
         tx_count = excluded.tx_count, first_tx_time = excluded.first_tx_time, last_tx_time = excluded.last_tx_time,
         total_deposited_wei = excluded.total_deposited_wei, total_withdrawn_wei = excluded.total_withdrawn_wei,
         total_sent_wei = excluded.total_sent_wei, total_received_wei = excluded.total_received_wei,
         balance_wei = excluded.balance_wei`
    ),
    deleteUser: db.prepare("DELETE FROM users WHERE chain_id = ? AND contract_address = ? AND address = ?"),
  };

  // 某个地址的汇总：从流水重新计算（金额用 BigInt，避免精度问题）
  function recomputeUser(address) {
    const rows = q.userRows.all(...scope, address, address);
    if (!rows.length) { q.deleteUser.run(...scope, address); return; }
    let dep = 0n, wd = 0n, sent = 0n, recv = 0n, first = Infinity, last = 0;
    for (const r of rows) {
      const amt = BigInt(r.amount_wei);
      if (r.type === "deposit") dep += amt;
      else if (r.type === "withdraw") wd += amt;
      else if (r.from_address === address) sent += amt;
      else recv += amt;
      first = Math.min(first, r.block_time);
      last = Math.max(last, r.block_time);
    }
    q.upsertUser.run(
      ...scope, address, rows.length, first, last,
      dep.toString(), wd.toString(), sent.toString(), recv.toString(), (dep + recv - wd - sent).toString()
    );
  }

  const toApi = (r) => ({
    id: r.id, type: r.type, txHash: r.tx_hash, logIndex: r.log_index,
    blockNumber: r.block_number, blockTime: r.block_time,
    from: r.from_address, to: r.to_address, amountWei: r.amount_wei,
  });
  const userToApi = (r) => ({
    address: r.address, txCount: r.tx_count, firstTxTime: r.first_tx_time, lastTxTime: r.last_tx_time,
    totalDepositedWei: r.total_deposited_wei, totalWithdrawnWei: r.total_withdrawn_wei,
    totalSentWei: r.total_sent_wei, totalReceivedWei: r.total_received_wei, balanceWei: r.balance_wei,
  });

  function clampPage(limit, offset) {
    const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), MAX_LIMIT);
    const o = Math.max(parseInt(offset, 10) || 0, 0);
    return [l, o];
  }

  return {
    db,
    chainId: chain,
    contractAddress: contract,

    count() { return q.countAll.get(...scope).n; },

    getLastBlock() {
      const r = q.getState.get(...scope);
      return r ? r.last_block : null;
    },

    // 在一个事务里：删掉 [fromBlock, toBlock] 的旧记录 → 写入新记录 → 重算受影响用户 → 推进进度。
    // 先删后写，所以区块链发生小范围重组时，被回滚的记录会被自动清掉；重复运行也不会产生重复数据。
    // 区间内的记录和链上完全一致时什么都不改（只推进进度），避免每轮轮询都重写同样的数据。
    replaceRange(fromBlock, toBlock, rows) {
      const sig = (h, i, b) => `${h}:${i}:${b}`;
      const have = new Set(q.keysInRange.all(...scope, fromBlock, toBlock).map((r) => sig(r.tx_hash, r.log_index, r.block_number)));
      const want = new Set(rows.map((r) => sig(r.txHash, r.logIndex, r.blockNumber)));
      if (have.size === want.size && [...want].every((k) => have.has(k))) {
        q.setState.run(...scope, toBlock, Math.floor(Date.now() / 1000));
        return false;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const affected = new Set(q.addrsInRange.all(...scope, fromBlock, toBlock, ...scope, fromBlock, toBlock).map((r) => r.a));
        q.deleteRange.run(...scope, fromBlock, toBlock);
        for (const r of rows) {
          q.insertTx.run(
            ...scope, r.txHash, r.logIndex, r.blockNumber, r.blockTime, r.type,
            r.from.toLowerCase(), r.to ? r.to.toLowerCase() : null, r.amountWei.toString()
          );
          affected.add(r.from.toLowerCase());
          if (r.to) affected.add(r.to.toLowerCase());
        }
        for (const a of affected) recomputeUser(a);
        q.setState.run(...scope, toBlock, Math.floor(Date.now() / 1000));
        db.exec("COMMIT");
        return true;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    // 交易列表（所有用户，或某个地址相关的：作为操作者/转出方/收款方），按时间从新到旧
    listTransactions({ address, type, limit, offset } = {}) {
      const [l, o] = clampPage(limit, offset);
      const where = ["chain_id = ?", "contract_address = ?"];
      const args = [...scope];
      if (address) { where.push("(from_address = ? OR to_address = ?)"); args.push(address.toLowerCase(), address.toLowerCase()); }
      if (type) { where.push("type = ?"); args.push(type); }
      const w = where.join(" AND ");
      const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${w}`).get(...args).n;
      const items = db
        .prepare(`SELECT * FROM transactions WHERE ${w} ORDER BY block_number DESC, log_index DESC LIMIT ? OFFSET ?`)
        .all(...args, l, o)
        .map(toApi);
      return { total, limit: l, offset: o, items };
    },

    getUser(address) {
      const r = db
        .prepare("SELECT * FROM users WHERE chain_id = ? AND contract_address = ? AND address = ?")
        .get(...scope, address.toLowerCase());
      return r ? userToApi(r) : null;
    },

    // 用户列表，按银行余额从大到小（wei 是不带前导 0 的十进制字符串：先比长度再比字典序 = 比数值）
    listUsers({ limit, offset } = {}) {
      const [l, o] = clampPage(limit, offset);
      const total = db.prepare("SELECT COUNT(*) AS n FROM users WHERE chain_id = ? AND contract_address = ?").get(...scope).n;
      const items = db
        .prepare(
          `SELECT * FROM users WHERE chain_id = ? AND contract_address = ?
           ORDER BY LENGTH(balance_wei) DESC, balance_wei DESC, address LIMIT ? OFFSET ?`
        )
        .all(...scope, l, o)
        .map(userToApi);
      return { total, limit: l, offset: o, items };
    },

    stats() {
      const byType = { deposit: 0, withdraw: 0, transfer: 0 };
      for (const r of db
        .prepare("SELECT type, COUNT(*) AS n FROM transactions WHERE chain_id = ? AND contract_address = ? GROUP BY type")
        .all(...scope)) byType[r.type] = r.n;
      let totalDeposits = 0n;
      for (const r of db.prepare("SELECT balance_wei FROM users WHERE chain_id = ? AND contract_address = ?").all(...scope))
        totalDeposits += BigInt(r.balance_wei);
      const userCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE chain_id = ? AND contract_address = ?").get(...scope).n;
      return {
        transactions: byType.deposit + byType.withdraw + byType.transfer,
        byType, users: userCount, totalDepositsWei: totalDeposits.toString(),
      };
    },

    close() { db.close(); },
  };
}

module.exports = { createStore, MAX_LIMIT };
