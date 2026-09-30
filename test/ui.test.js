// 端到端界面测试：用 jsdom 加载 web/index.html，接一条本地 ganache 测试链，
// 模拟钱包点击 连接 / 存款 / 取款 / 转账，验证页面逻辑。
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { JSDOM } = require("jsdom");
const artifact = require("../build/SimpleBank.json");

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

  const web = path.join(__dirname, "..", "web");
  let html = fs.readFileSync(path.join(web, "index.html"), "utf8");
  const ethersJs = fs.readFileSync(path.join(__dirname, "..", "node_modules", "ethers", "dist", "ethers.umd.min.js"), "utf8");
  const cfg = `window.BANK_CONFIG=${JSON.stringify({
    contractAddress: addr, deployBlock: 0, chainId: 1337, chainName: "Local",
    rpcUrl: "http://127.0.0.1:1", explorer: "https://example.test", symbol: "ETH",
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

  // 存款 2 ETH
  $("depAmt").value = "2";
  $("depBtn").click();
  await waitFor(() => status().includes("存款成功"), "存款成功");
  await waitFor(() => $("bankBal").textContent === "2", "银行余额=2");
  check("存款后银行余额 = 2", $("bankBal").textContent === "2", $("bankBal").textContent);
  check("总存款 = 2", $("totalDep").textContent.startsWith("2"), $("totalDep").textContent);

  // 取款 0.5
  d.querySelector('[data-tab="withdraw"]').click();
  $("wdAmt").value = "0.5";
  $("wdBtn").click();
  await waitFor(() => status().includes("取款成功"), "取款成功");
  await waitFor(() => $("bankBal").textContent === "1.5", "银行余额=1.5");
  check("取款后银行余额 = 1.5", true);

  // 转账 1 给 other
  d.querySelector('[data-tab="transfer"]').click();
  $("toAddr").value = await other.getAddress();
  $("trAmt").value = "1";
  $("trBtn").click();
  await waitFor(() => status().includes("转账成功"), "转账成功");
  await waitFor(() => $("bankBal").textContent === "0.5", "银行余额=0.5");
  check("转账后银行余额 = 0.5", true);
  check("对方链上余额 = 1", (await bank.balanceOf(await other.getAddress())) === ethers.parseEther("1"));

  // 错误处理
  $("trAmt").value = "9";
  $("trBtn").click();
  await sleep(200);
  check("超额转账被拦截并提示", status().includes("银行余额不足"), status());
  $("toAddr").value = "0x123";
  $("trBtn").click();
  await sleep(200);
  check("非法地址被拦截", status().includes("地址格式不正确"), status());
  $("toAddr").value = await deployer.getAddress();
  $("trAmt").value = "0.1";
  $("trBtn").click();
  await sleep(200);
  check("转给自己被拦截", status().includes("不能转给自己"), status());
  d.querySelector('[data-tab="deposit"]').click();
  $("depAmt").value = "abc";
  $("depBtn").click();
  await sleep(200);
  check("非法金额被拦截", status().includes("金额格式不正确"), status());

  // 历史记录
  await waitFor(() => d.querySelectorAll("#history li:not(.empty)").length >= 3, "历史记录");
  check("历史记录显示 3 笔", d.querySelectorAll("#history li:not(.empty)").length === 3,
        String(d.querySelectorAll("#history li").length));

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  dom.window.close();
  await server.disconnect();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试异常:", e); process.exit(1); });
