// 数据库 + 索引器 + API 测试：本地 ganache 链上用多个账户操作，检查入库的记录和汇总
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const ganache = require("ganache");
const { ethers } = require("ethers");
const artifact = require("../build/SimpleBank.json");
const { createStore } = require("../server/db");
const { createIndexer } = require("../server/indexer");
const { createServer } = require("../server/server");

const E = ethers.parseEther;

async function setup(indexerOpts = {}) {
  const server = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4 } });
  const provider = new ethers.BrowserProvider(server);
  provider.pollingInterval = 20; // ethers 默认 4 秒轮询一次回执，测试里调快，否则每笔交易要等好几秒
  const [a, b, c] = [await provider.getSigner(0), await provider.getSigner(1), await provider.getSigner(2)];
  const bank = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, a).deploy();
  await bank.waitForDeployment();
  const address = await bank.getAddress();
  const store = createStore({ dbPath: ":memory:", chainId: 1337, contractAddress: address });
  const indexer = createIndexer({ provider, store, log: { log() {}, warn() {}, error() {} }, ...indexerOpts });
  const as = (s) => bank.connect(s);
  const close = async () => { store.close(); await server.disconnect(); };
  return { server, provider, a, b, c, bank, as, store, indexer, address, close };
}

// 三个用户做一批操作：a 存 3、取 1，转 1 给 b；b 存 2，转 0.5 给 c；c 直接向合约转账 0.25（也算存款）
async function activity({ as, a, b, c, address }) {
  await (await as(a).deposit({ value: E("3") })).wait();
  await (await as(a).withdraw(E("1"))).wait();
  await (await as(a).transfer(b.address, E("1"))).wait();
  await (await as(b).deposit({ value: E("2") })).wait();
  await (await as(b).transfer(c.address, E("0.5"))).wait();
  await (await c.sendTransaction({ to: address, value: E("0.25") })).wait();
}

test("所有用户的存款/取款/转账都写入数据库", async () => {
  const ctx = await setup();
  await activity(ctx);
  const r = await ctx.indexer.syncOnce();
  assert.equal(r.inserted, 6);

  const all = ctx.store.listTransactions();
  assert.equal(all.total, 6);
  // 从新到旧
  assert.deepEqual(all.items.map((t) => t.type), ["deposit", "transfer", "deposit", "transfer", "withdraw", "deposit"]);
  const first = all.items[5];
  assert.equal(first.from, ctx.a.address.toLowerCase());
  assert.equal(first.to, null);
  assert.equal(first.amountWei, E("3").toString());
  assert.ok(first.blockTime > 1_600_000_000);
  assert.match(first.txHash, /^0x[0-9a-f]{64}$/);

  const tr = all.items.find((t) => t.type === "transfer" && t.from === ctx.b.address.toLowerCase());
  assert.equal(tr.to, ctx.c.address.toLowerCase());
  assert.equal(tr.amountWei, E("0.5").toString());
  await ctx.close();
});

test("每个用户的汇总余额和合约 balanceOf 完全一致", async () => {
  const ctx = await setup();
  await activity(ctx);
  await ctx.indexer.syncOnce();
  for (const s of [ctx.a, ctx.b, ctx.c]) {
    const u = ctx.store.getUser(s.address);
    assert.equal(u.balanceWei, (await ctx.bank.balanceOf(s.address)).toString(), s.address);
  }
  const ua = ctx.store.getUser(ctx.a.address);
  assert.equal(ua.txCount, 3);
  assert.equal(ua.totalDepositedWei, E("3").toString());
  assert.equal(ua.totalWithdrawnWei, E("1").toString());
  assert.equal(ua.totalSentWei, E("1").toString());
  const stats = ctx.store.stats();
  assert.equal(stats.totalDepositsWei, (await ctx.bank.totalDeposits()).toString());
  assert.deepEqual(stats.byType, { deposit: 3, withdraw: 1, transfer: 2 });
  assert.equal(stats.users, 3);
  await ctx.close();
});

test("按地址查询：转出方和收款方都能看到这笔转账", async () => {
  const ctx = await setup();
  await activity(ctx);
  await ctx.indexer.syncOnce();
  const forB = ctx.store.listTransactions({ address: ctx.b.address });
  assert.equal(forB.total, 3); // 收到 a 的转账、自己存款、转给 c
  const onlyTransfers = ctx.store.listTransactions({ address: ctx.b.address, type: "transfer" });
  assert.equal(onlyTransfers.total, 2);
  assert.equal(ctx.store.listTransactions({ limit: 2, offset: 0 }).items.length, 2);
  assert.equal(ctx.store.listTransactions({ limit: 2, offset: 5 }).items.length, 1);
  await ctx.close();
});

test("重复同步不会产生重复记录，新交易会增量写入", async () => {
  const ctx = await setup();
  await activity(ctx);
  await ctx.indexer.syncOnce();
  await ctx.indexer.syncOnce();
  await ctx.indexer.syncOnce();
  assert.equal(ctx.store.listTransactions().total, 6);

  await (await ctx.as(ctx.c).withdrawAll()).wait();
  await ctx.indexer.syncOnce();
  assert.equal(ctx.store.listTransactions().total, 7);
  assert.equal(ctx.store.getUser(ctx.c.address).balanceWei, "0");
  await ctx.close();
});

test("同时触发多次同步会合并成一次", async () => {
  const ctx = await setup();
  await activity(ctx);
  const [x, y] = await Promise.all([ctx.indexer.syncOnce(), ctx.indexer.syncOnce()]);
  assert.equal(x, y);
  assert.equal(ctx.store.listTransactions().total, 6);
  await ctx.close();
});

test("区块范围分片和 getLogs 失败时自动拆分，结果一致", async () => {
  const ctx = await setup({ chunkSize: 2 });
  await activity(ctx);
  // 让较大的区间查询失败，只允许 1 个区块的查询，强制走拆分逻辑
  const orig = ctx.provider.getLogs.bind(ctx.provider);
  ctx.provider.getLogs = async (f) => {
    if (f.toBlock - f.fromBlock > 0) throw new Error("range too large");
    return orig(f);
  };
  await ctx.indexer.syncOnce();
  assert.equal(ctx.store.listTransactions().total, 6);
  await ctx.close();
});

test("链重组：被回滚区块里的旧记录会被清掉", async () => {
  const ctx = await setup();
  await activity(ctx);
  await ctx.indexer.syncOnce();
  // 手工塞一条“已不在链上”的假记录（模拟被重组掉的区块），下一次同步应把它清除
  const head = await ctx.provider.getBlockNumber();
  ctx.store.replaceRange(head, head, [
    { type: "deposit", from: ctx.c.address, to: null, amountWei: E("99"), txHash: "0x" + "ab".repeat(32), logIndex: 0, blockNumber: head, blockTime: 1700000000 },
  ]);
  assert.ok(ctx.store.listTransactions().items.some((t) => t.amountWei === E("99").toString()), "假记录应已写入");
  await ctx.indexer.syncOnce();
  const items = ctx.store.listTransactions().items;
  assert.ok(!items.some((t) => t.amountWei === E("99").toString()), "假记录应被清除");
  assert.equal(ctx.store.getUser(ctx.c.address).balanceWei, (await ctx.bank.balanceOf(ctx.c.address)).toString());
  await ctx.close();
});

test("数据库约束：金额必须是纯数字，转账必须有收款方", async () => {
  const ctx = await setup();
  const ins = (type, to, amt) =>
    ctx.store.db
      .prepare("INSERT INTO transactions (chain_id, contract_address, tx_hash, log_index, block_number, block_time, type, from_address, to_address, amount_wei) VALUES (1,'x','h',?,1,1,?,'f',?,?)")
      .run(Math.random(), type, to, amt);
  assert.throws(() => ins("deposit", null, "1.5"));
  assert.throws(() => ins("deposit", null, "-1"));
  assert.throws(() => ins("deposit", null, ""));
  assert.throws(() => ins("transfer", null, "1"));
  assert.throws(() => ins("deposit", "0xto", "1"));
  assert.throws(() => ins("refund", null, "1"));
  await ctx.close();
});

test("用户列表按银行余额从大到小排序（超过 64 位整数也正确）", async () => {
  const ctx = await setup();
  await (await ctx.as(ctx.a).deposit({ value: E("9.5") })).wait();   // > 2^63 wei，且位数比下面的多
  await (await ctx.as(ctx.b).deposit({ value: E("10") })).wait();     // 位数更多
  await (await ctx.as(ctx.c).deposit({ value: E("0.001") })).wait();
  await ctx.indexer.syncOnce();
  const order = ctx.store.listUsers().items.map((u) => u.address);
  assert.deepEqual(order, [ctx.b.address, ctx.a.address, ctx.c.address].map((x) => x.toLowerCase()));
  await ctx.close();
});

// ---------- HTTP API ----------
function get(base, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("HTTP API：列表、筛选、用户、统计、同步、错误处理、静态页面", async () => {
  const ctx = await setup();
  await activity(ctx);
  const srv = createServer({ store: ctx.store, indexer: ctx.indexer, minSyncGapMs: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {

  // 还没同步：POST /api/sync 触发后才有数据
  assert.equal((await get(base, "/api/transactions")).json.total, 0);
  const sync = await get(base, "/api/sync", "POST");
  assert.equal(sync.status, 200);
  assert.ok(sync.json.lastBlock > 0);

  const health = await get(base, "/api/health");
  assert.equal(health.json.contract, ctx.address.toLowerCase());

  const list = await get(base, "/api/transactions?limit=3");
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 6);
  assert.equal(list.json.items.length, 3);
  assert.equal(list.headers["access-control-allow-origin"], "*");

  const mine = await get(base, `/api/transactions?address=${ctx.b.address}&type=transfer`);
  assert.equal(mine.json.total, 2);
  // 大小写混合（校验和格式）的地址也可以查
  assert.equal((await get(base, `/api/transactions?address=${ethers.getAddress(ctx.b.address)}`)).json.total, 3);

  const user = await get(base, `/api/users/${ctx.a.address}`);
  assert.equal(user.json.balanceWei, (await ctx.bank.balanceOf(ctx.a.address)).toString());
  assert.equal((await get(base, `/api/users/${ctx.a.address.slice(0, 20)}`)).status, 400);
  assert.equal((await get(base, `/api/users/${ethers.Wallet.createRandom().address}`)).status, 404);
  assert.equal((await get(base, "/api/users")).json.total, 3);
  assert.equal((await get(base, "/api/stats")).json.transactions, 6);

  // 非法参数
  assert.equal((await get(base, "/api/transactions?address=0x123")).status, 400);
  assert.equal((await get(base, "/api/transactions?type=hack")).status, 400);
  assert.equal((await get(base, "/api/nope")).status, 404);
  // SQL 注入式参数只会被当成非法参数拒绝
  assert.equal((await get(base, "/api/transactions?type=" + encodeURIComponent("deposit' OR '1'='1"))).status, 400);
  // limit 上限
  assert.equal((await get(base, "/api/transactions?limit=100000")).json.limit, 100);
  // 只读：不能用 POST 写入交易
  assert.equal((await get(base, "/api/transactions", "POST")).status, 404);

  // 静态页面托管 + 目录穿越防护
  const page = await get(base, "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /链上小银行/);
  const t1 = await get(base, "/..%2f..%2fpackage.json");
  assert.equal(t1.status, 403);
  // 浏览器/URL 解析会把 /%2e%2e/ 规整成 /，落到 web/ 目录内，找不到文件即可；关键是不能读到项目根目录的 package.json
  const t2 = await get(base, "/%2e%2e/package.json");
  assert.notEqual(t2.status, 200);
  assert.ok(!t2.body.includes("simple-bank-dapp"));
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await ctx.close();
  }
});
