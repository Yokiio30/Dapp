// 索引器：把合约的 Deposited / Withdrawn / Transferred 事件同步进数据库。
// - 增量：从 sync_state 记录的区块继续，重启、休眠后自动补齐
// - 抗重组：每次都从“上次进度 - reorgDepth”重新扫，旧记录先删后写
// - 抗限流：公共 RPC 对 getLogs 的区块范围有限制，失败时自动把区间对半拆小
const { ethers } = require("ethers");
const artifact = require("../build/SimpleBank.json");

const iface = new ethers.Interface(artifact.abi);

const EVENT_TYPES = {
  Deposited: (a) => ({ type: "deposit", from: a.user, to: null }),
  Withdrawn: (a) => ({ type: "withdraw", from: a.user, to: null }),
  Transferred: (a) => ({ type: "transfer", from: a.from, to: a.to }),
};

function createIndexer({
  provider,
  store,
  startBlock = 0,        // 合约部署区块；0 表示未知
  backfillBlocks = 50000, // 未知部署区块时，首次最多回溯多少个区块
  confirmations = 0,
  chunkSize = 5000,
  reorgDepth = 12,
  log = console,
}) {
  let running = null;

  async function fetchLogs(from, to) {
    try {
      return await provider.getLogs({ address: store.contractAddress, fromBlock: from, toBlock: to });
    } catch (e) {
      if (to <= from) throw e;
      const mid = Math.floor((from + to) / 2);
      return (await fetchLogs(from, mid)).concat(await fetchLogs(mid + 1, to));
    }
  }

  async function toRows(logs) {
    const times = new Map();
    for (const n of new Set(logs.map((l) => l.blockNumber))) {
      times.set(n, (await provider.getBlock(n)).timestamp);
    }
    const rows = [];
    for (const l of logs) {
      let parsed;
      try { parsed = iface.parseLog({ topics: l.topics, data: l.data }); } catch (_) { continue; }
      const map = parsed && EVENT_TYPES[parsed.name];
      if (!map) continue;
      rows.push({
        ...map(parsed.args),
        amountWei: parsed.args.amount,
        txHash: l.transactionHash,
        logIndex: l.index,
        blockNumber: l.blockNumber,
        blockTime: times.get(l.blockNumber),
      });
    }
    return rows;
  }

  async function run() {
    const head = await provider.getBlockNumber();
    const safeHead = head - confirmations;
    if (safeHead < 0) return { from: 0, to: -1, inserted: 0, added: 0 };

    const last = store.getLastBlock();
    let from;
    if (last != null) {
      from = Math.max(startBlock, last - reorgDepth + 1, 0);
    } else if (startBlock > 0) {
      from = startBlock;
    } else {
      from = Math.max(0, safeHead - backfillBlocks);
      if (from > 0) {
        log.warn?.(`[indexer] 未配置合约部署区块（START_BLOCK / config.js 的 deployBlock），本次只回溯最近 ${backfillBlocks} 个区块，更早的记录不会入库。`);
      }
    }

    const before = store.count();
    let inserted = 0;
    for (let cf = from; cf <= safeHead; cf += chunkSize) {
      const ct = Math.min(cf + chunkSize - 1, safeHead);
      const rows = await toRows(await fetchLogs(cf, ct));
      store.replaceRange(cf, ct, rows);
      inserted += rows.length;
    }
    // inserted：这次扫描到的事件数（含重扫的旧记录）；added：数据库里净增加的记录数
    return { from, to: safeHead, inserted, added: store.count() - before };
  }

  // 同时多次调用会合并成同一次同步
  function syncOnce() {
    if (!running) running = run().finally(() => { running = null; });
    return running;
  }

  let timer = null;
  function start(intervalMs = 15000) {
    const tick = async () => {
      try {
        const r = await syncOnce();
        if (r.added) log.log?.(`[indexer] 区块 ${r.from}-${r.to}：新增 ${r.added} 条记录`);
      } catch (e) {
        log.error?.("[indexer] 同步失败，稍后重试：", e.shortMessage || e.message);
      }
      if (timer !== false) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, 0);
  }
  function stop() { if (timer) clearTimeout(timer); timer = false; }

  return { syncOnce, start, stop };
}

module.exports = { createIndexer };
