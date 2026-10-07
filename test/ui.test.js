// 端到端界面测试：用 jsdom 加载 web/index.html，接一条本地 ganache 测试链，
// 模拟钱包点击 连接 / 存款 / 取款 / 转账，验证页面逻辑。
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { JSDOM } = require("jsdom");
const artifact = require("../build/SimpleBank.json");
const { createStore } = require("../server/db");
const { createIndexer } = require("../server/indexer");
const { createServer } = require("../server/server");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (fn()) return; } catch (_) {} await sleep(100); }
  throw new Error("等待超时: " + what);
}

(async () => {
  const server = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 3 } });
  const bp = new ethers.BrowserProvider(server);
  const deployer = await bp.getSigner(0);
  const other = await bp.getSigner(1);
  const bank = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy();
  await bank.waitForDeployment();
  const addr = await bank.getAddress();

  // 后端：数据库 + 索引器 + API（页面的“全站交易记录”卡片读它）
  const store = createStore({ dbPath: ":memory:", chainId: 1337, contractAddress: addr });
  const indexer = createIndexer({ provider: bp, store, log: { log() {}, warn() {}, error() {} } });
  const apiServer = createServer({ store, indexer, minSyncGapMs: 0 });
  await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}/api`;

  const web = path.join(__dirname, "..", "web");
  let html = fs.readFileSync(path.join(web, "index.html"), "utf8");
  const ethersJs = fs.readFileSync(path.join(__dirname, "..", "node_modules", "ethers", "dist", "ethers.umd.min.js"), "utf8");
  const cfg = `window.BANK_CONFIG=${JSON.stringify({
    contractAddress: addr, deployBlock: 0, chainId: 1337, chainName: "Local",
    rpcUrl: "http://127.0.0.1:1", explorer: "https://example.test", symbol: "ETH", apiUrl,
  })};`;
  html = html
    .replace(/<script src="https:\/\/cdn[^"]*"><\/script>/, () => `<script>${ethersJs}</script>`)
    .replace('<script src="config.js"></script>', () => `<script>${cfg}</script>`)
    .replace('<script src="abi.js"></script>', () => `<script>${fs.readFileSync(path.join(web, "abi.js"), "utf8")}</script>`);

  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(w) {
      w.ethereum = server;               // EIP-1193 注入钱包
      w.confirm = () => true;
      w.fetch = (u, o) => fetch(u, o);   // jsdom 没有 fetch，用 Node 自带的
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      w.eval("void 0");
    },
  });
  const d = dom.window.document;
  const $ = (id) => d.getElementById(id);
  const status = () => $("status").textContent;
  const results = [];
  const check = (name, ok, extra = "") => { results.push(ok); console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  -> " + extra)); };

  // 自动连接
  await waitFor(() => $("acct").textContent.startsWith("0x"), "自动连接");
  check("自动连接并显示账户", true);
  await waitFor(() => $("netPill").textContent === "Local", "网络标识");
  check("网络识别正确", true);
  check("按钮已启用", !$("depBtn").disabled);
  await waitFor(() => !$("allCard").hidden, "全站记录卡片出现");
  check("后端可用时显示全站记录卡片（暂无记录）", $("allHistory").textContent.includes("No activity yet"), $("allHistory").textContent);

  // 存款 2 ETH
  $("depAmt").value = "2";
  $("depBtn").click();
  await waitFor(() => status().includes("Deposit confirmed"), "Deposit confirmed");
  await waitFor(() => $("bankBal").textContent === "2", "银行余额=2");
  check("存款后银行余额 = 2", $("bankBal").textContent === "2", $("bankBal").textContent);
  check("总存款 = 2", $("totalDep").textContent.startsWith("2"), $("totalDep").textContent);

  // 取款 0.5
  d.querySelector('[data-tab="withdraw"]').click();
  $("wdAmt").value = "0.5";
  $("wdBtn").click();
  await waitFor(() => status().includes("Withdrawal confirmed"), "Withdrawal confirmed");
  await waitFor(() => $("bankBal").textContent === "1.5", "银行余额=1.5");
  check("取款后银行余额 = 1.5", true);

  // 转账 1 给 other
  d.querySelector('[data-tab="transfer"]').click();
  $("toAddr").value = await other.getAddress();
  $("trAmt").value = "1";
  $("trBtn").click();
  await waitFor(() => status().includes("Transfer confirmed"), "Transfer confirmed");
  await waitFor(() => $("bankBal").textContent === "0.5", "银行余额=0.5");
  check("转账后银行余额 = 0.5", true);
  check("对方链上余额 = 1", (await bank.balanceOf(await other.getAddress())) === ethers.parseEther("1"));

  // 错误处理
  $("trAmt").value = "9";
  $("trBtn").click();
  await sleep(200);
  check("超额转账被拦截并提示", status().includes("Not enough bank balance"), status());
  $("toAddr").value = "0x123";
  $("trBtn").click();
  await sleep(200);
  check("非法地址被拦截", status().includes("Invalid recipient address"), status());
  $("toAddr").value = await deployer.getAddress();
  $("trAmt").value = "0.1";
  $("trBtn").click();
  await sleep(200);
  check("转给自己被拦截", status().includes("transfer to yourself"), status());
  d.querySelector('[data-tab="deposit"]').click();
  $("depAmt").value = "abc";
  $("depBtn").click();
  await sleep(200);
  check("非法金额被拦截", status().includes("Invalid amount"), status());

  // 历史记录
  await waitFor(() => d.querySelectorAll("#history li:not(.empty)").length >= 3, "历史记录");
  check("历史记录显示 3 笔", d.querySelectorAll("#history li:not(.empty)").length === 3,
        String(d.querySelectorAll("#history li").length));

  // 全站记录：每笔交易确认后页面会通知后端同步，数据库里应有同样 3 笔
  await waitFor(() => d.querySelectorAll("#allHistory li:not(.empty)").length >= 3, "全站记录显示 3 笔");
  check("全站记录显示 3 笔（来自数据库）", d.querySelectorAll("#allHistory li:not(.empty)").length === 3);
  check("数据库里有 3 笔记录", store.listTransactions().total === 3, String(store.listTransactions().total));
  check("全站记录计数显示", $("allCount").textContent.includes("3"), $("allCount").textContent);
  const types = store.listTransactions().items.map((t) => t.type).reverse().join(",");
  check("数据库记录顺序：存款、取款、转账", types === "deposit,withdraw,transfer", types);
  const other_addr = (await other.getAddress()).toLowerCase();
  check("收款方在数据库里有汇总", store.getUser(other_addr)?.balanceWei === ethers.parseEther("1").toString());
  $("allMine").click();
  await waitFor(() => $("allMine").getAttribute("aria-pressed") === "true", "只看我的开关");
  await waitFor(() => d.querySelectorAll("#allHistory li:not(.empty)").length === 3, "只看我的 3 笔");
  check("只看我的：显示 3 笔，转出标红", d.querySelectorAll("#allHistory .neg").length >= 1);

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  apiServer.closeAllConnections?.();
  await new Promise((r) => apiServer.close(r));
  store.close();
  await server.disconnect();
  dom.window.close();   // 最后才关页面，避免还在路上的请求回调时页面已销毁
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试异常:", e); process.exit(1); });
