// 后端入口：索引器 + 只读 API + 托管 web/ 静态页面（一个进程搞定）
//   node server/server.js
// 配置默认读取 web/config.js（合约地址、链、RPC、部署区块），也可用环境变量覆盖：
//   PORT  DB_PATH  RPC_URL  CHAIN_ID  CONTRACT_ADDRESS  START_BLOCK
//   POLL_INTERVAL_MS  CONFIRMATIONS  CORS_ORIGIN
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const { ethers } = require("ethers");
const { createStore } = require("./db");
const { createIndexer } = require("./indexer");

const WEB_DIR = path.join(__dirname, "..", "web");
const TYPES = new Set(["deposit", "withdraw", "transfer"]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

function loadWebConfig() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(WEB_DIR, "config.js"), "utf8"), sandbox);
  return sandbox.window.BANK_CONFIG || {};
}

function createServer({ store, indexer, corsOrigin = "*", webDir = WEB_DIR, minSyncGapMs = 1500 }) {
  let lastForcedSync = 0;

  const send = (res, status, body, headers = {}) => {
    const isObj = typeof body === "object" && !Buffer.isBuffer(body);
    res.writeHead(status, {
      "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
      ...headers,
    });
    res.end(isObj ? JSON.stringify(body) : body);
  };
  const bad = (res, msg) => send(res, 400, { error: msg });

  async function api(req, res, url) {
    const p = url.pathname.replace(/\/+$/, "");
    const sp = url.searchParams;

    if (req.method === "OPTIONS") {
      return send(res, 204, "", { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    }

    if (p === "/api/health" && req.method === "GET") {
      return send(res, 200, { ok: true, chainId: store.chainId, contract: store.contractAddress, lastBlock: store.getLastBlock() });
    }

    if (p === "/api/stats" && req.method === "GET") return send(res, 200, store.stats());

    if (p === "/api/transactions" && req.method === "GET") {
      const address = sp.get("address");
      const type = sp.get("type");
      if (address && !ethers.isAddress(address)) return bad(res, "address 不是有效的以太坊地址");
      if (type && !TYPES.has(type)) return bad(res, "type 只能是 deposit / withdraw / transfer");
      return send(res, 200, store.listTransactions({ address, type, limit: sp.get("limit"), offset: sp.get("offset") }));
    }

    if (p === "/api/users" && req.method === "GET") {
      return send(res, 200, store.listUsers({ limit: sp.get("limit"), offset: sp.get("offset") }));
    }

    const m = p.match(/^\/api\/users\/([^/]+)$/);
    if (m && req.method === "GET") {
      if (!ethers.isAddress(m[1])) return bad(res, "不是有效的以太坊地址");
      const user = store.getUser(m[1]);
      return user ? send(res, 200, user) : send(res, 404, { error: "没有这个地址的记录" });
    }

    // 触发一次立即同步：不接收任何交易数据，只是让服务器马上去链上读最新事件，所以无法被用来伪造记录
    if (p === "/api/sync" && req.method === "POST") {
      const now = Date.now();
      if (now - lastForcedSync >= minSyncGapMs) {
        lastForcedSync = now;
        try { await indexer.syncOnce(); } catch (e) { return send(res, 502, { error: "同步失败：" + (e.shortMessage || e.message) }); }
      }
      return send(res, 200, { ok: true, lastBlock: store.getLastBlock() });
    }

    return send(res, 404, { error: "接口不存在" });
  }

  function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed");
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch (_) { return send(res, 400, "Bad Request"); }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(webDir, rel));
    if (file !== webDir && !file.startsWith(webDir + path.sep)) return send(res, 403, "Forbidden");
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, "Not Found");
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: "服务器内部错误" });
      else res.end();
    }
  });
}

async function main() {
  const env = process.env;
  const cfg = loadWebConfig();
  const contractAddress = env.CONTRACT_ADDRESS || cfg.contractAddress;
  if (!ethers.isAddress(contractAddress)) {
    console.error("未配置有效的合约地址：请先部署合约并写入 web/config.js，或设置环境变量 CONTRACT_ADDRESS");
    process.exit(1);
  }
  const chainId = Number(env.CHAIN_ID || cfg.chainId);
  const rpcUrl = env.RPC_URL || cfg.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });

  const store = createStore({ dbPath: env.DB_PATH || path.join(__dirname, "..", "data", "bank.db"), chainId, contractAddress });
  const indexer = createIndexer({
    provider, store,
    startBlock: Number(env.START_BLOCK || cfg.deployBlock) || 0,
    confirmations: Number(env.CONFIRMATIONS || 0),
  });

  const server = createServer({ store, indexer, corsOrigin: env.CORS_ORIGIN ?? "*" });
  const port = Number(env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`服务已启动：http://localhost:${port}  合约 ${contractAddress}  链 ${chainId}`);
    console.log(`数据库：${env.DB_PATH || "data/bank.db"}`);
    indexer.start(Number(env.POLL_INTERVAL_MS) || 15000);
  });

  const shutdown = () => { indexer.stop(); server.close(() => { store.close(); process.exit(0); }); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) main();

module.exports = { createServer, loadWebConfig };
