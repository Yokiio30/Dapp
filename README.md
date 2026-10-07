# 链上小银行 Dapp（存款 / 取款 / 转账）

手机可用的 ETH 小银行：
- **存款**：把钱包里的 ETH 存进合约
- **取款**：从合约取回到自己的钱包（支持“全部”）
- **转账**：转给另一个地址的银行账户（合约内记账，对方自己取出）
- 显示钱包余额、银行余额、总存款和最近记录；网络不对时一键切换
- **全站交易记录**：后端把所有用户的存款 / 取款 / 转账同步进 SQL 数据库，页面可查看全部记录、只看自己的，并提供查询 API（见下文“交易记录数据库”）

结构：

```
contracts/SimpleBank.sol   智能合约
web/                        前端页面
  index.html  config.js  abi.js
db/schema.sql               数据库表结构（SQLite）
server/                     后端：数据库层、链上事件索引器、API，同时托管 web/
  db.js  indexer.js  server.js
scripts/compile.js          编译，并生成 web/abi.js
scripts/deploy.js           命令行部署，自动写入 web/config.js
test/                       合约测试 + 数据库/API 测试 + 页面端到端测试
render.yaml                 Render 配置
```

> ⚠️ 合约没有经过专业审计。请先在测试网（默认 Sepolia）使用，不要存入有价值的真实资产。
> 部署用的私钥请用专门的新钱包，只放测试币，绝不要发给任何人或提交到 GitHub。

## 第 1 步：准备测试币
1. 手机或电脑装好 MetaMask，切换到 Sepolia 测试网。
2. 到任意 Sepolia faucet 领取一点测试 ETH（搜索 “Sepolia faucet”）。

## 第 2 步：部署合约（二选一）

### 方式 A：Remix（不用装任何东西，手机也能做）
1. 打开 https://remix.ethereum.org ，新建 `SimpleBank.sol`，粘贴 `contracts/SimpleBank.sol` 的内容。
2. 左侧 Solidity Compiler，版本选 0.8.20 或更高，点 Compile。
3. 左侧 Deploy & Run，Environment 选 “Injected Provider - MetaMask”，点 Deploy，在钱包里确认。
4. 复制部署出来的合约地址。

### 方式 B：命令行
```bash
npm install
npm test                       # 编译并跑全部测试
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
PRIVATE_KEY=0x你的测试钱包私钥 \
npm run deploy                 # 部署成功后自动写入 web/config.js
```

## 第 3 步：填写合约地址
方式 A 需要手动编辑 `web/config.js`，把 `contractAddress` 改成你的合约地址。
（`deployBlock` 不填也可以，页面会读取最近约 4 万个区块的记录。）

想用其他网络（如 Base Sepolia、Polygon Amoy），同时修改 `chainId`、`chainName`、`rpcUrl`、`explorer`、`symbol`。

## 第 4 步：部署到 Render
现在项目带后端（索引器 + 数据库 + API），在 Render 上是一个 **Web Service**，同时托管页面：
1. 把整个项目推到 GitHub（`.gitignore` 已排除 node_modules 和数据库文件）。
2. Render 控制台：New → Blueprint，选这个仓库，会自动读取 `render.yaml`。
   或者 New → Web Service：Runtime 选 Node，Build Command 填 `npm install --omit=dev`，Start Command 填 `npm start`，环境变量加 `NODE_VERSION=22`。
3. 部署完成后得到 `https://xxx.onrender.com`，页面和 `/api` 都在这个域名下。

> 之前的“纯静态站点”部署方式仍然可用：页面会自动检测不到后端并隐藏“全站交易记录”，其他功能不受影响。

## 第 5 步：手机使用
- 在手机上打开 MetaMask（或 Trust / Coinbase Wallet），用它**内置的浏览器**访问你的 Render 网址。
- 在普通手机浏览器里打开时，页面会出现“在 MetaMask 中打开”按钮，点一下即可跳转。
- 点“连接钱包”，网络不对会提示一键切换。

## 交易记录数据库

### 工作方式
```
合约事件 Deposited / Withdrawn / Transferred
        │  索引器每 15 秒读取一次（交易确认后页面也会通知它立即同步）
        ▼
SQLite 数据库 data/bank.db  ──►  /api/*（只读）  ──►  页面“全站交易记录”
```
- **所有用户**的记录都会保存，包括直接向合约转账产生的存款。
- 记录**只来自链上事件**，由后端自己读链写入；API 是只读的，没有任何接口可以提交交易数据，所以记录无法被伪造。
- **增量同步**：重启 / 休眠后从上次的区块继续；每次都会重扫最近 12 个区块，链发生小范围重组时错误记录会被自动纠正。
- 数据库只是链上数据的“可查询副本”，丢了可以重新同步出来。

### 表结构（`db/schema.sql`）
| 表 | 内容 |
| --- | --- |
| `transactions` | 交易流水：类型（deposit / withdraw / transfer）、转出方 / 操作者、收款方、金额、交易哈希、区块号、区块时间。`(链, 合约, 交易哈希, 事件序号)` 唯一，不会重复入库 |
| `users` | 每个地址的汇总：交易笔数、首次 / 最近交易时间、累计存款 / 取款 / 转出 / 转入、当前银行余额（和合约 `balanceOf` 一致） |
| `sync_state` | 每个（链, 合约）已同步到的区块 |

金额以 wei 的十进制字符串保存（1 ETH = 10^18，超出 SQLite 整数范围）。需要汇总时用 `users` 表，不要对 `amount_wei` 直接 `SUM`。

### 直接用 SQL 查询
```bash
sqlite3 data/bank.db
```
```sql
-- 最近 10 笔，所有用户
SELECT datetime(block_time,'unixepoch') AS time, type, from_address, to_address, amount_wei
FROM transactions ORDER BY block_number DESC, log_index DESC LIMIT 10;

-- 某个地址相关的全部记录（小写地址）
SELECT * FROM transactions WHERE from_address = '0x…' OR to_address = '0x…';

-- 每种类型各多少笔
SELECT type, COUNT(*) FROM transactions GROUP BY type;

-- 交易最活跃的用户
SELECT address, tx_count, balance_wei FROM users ORDER BY tx_count DESC LIMIT 10;
```

### API
| 接口 | 说明 |
| --- | --- |
| `GET /api/transactions?address=&type=&limit=&offset=` | 交易列表（新→旧）。`address` 不填 = 所有用户；填了 = 该地址作为操作者 / 转出方 / 收款方的记录。`type` 可选 `deposit` `withdraw` `transfer`。`limit` 最大 100 |
| `GET /api/users?limit=&offset=` | 用户汇总，按银行余额从大到小 |
| `GET /api/users/:address` | 单个用户汇总 |
| `GET /api/stats` | 总笔数、各类型笔数、用户数、银行总存款 |
| `GET /api/health` | 当前合约、链、已同步到的区块 |
| `POST /api/sync` | 让后端立刻去链上同步一次（不接收任何交易数据） |

### 本地运行
```bash
npm install
npm start          # http://localhost:3000 ，数据库默认写到 data/bank.db
```
需要 Node ≥ 22.13（数据库用 Node 内置的 `node:sqlite`，不用装任何原生依赖）。
默认读取 `web/config.js` 里的合约地址、链和 RPC，也可以用环境变量覆盖：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | 3000 |
| `DB_PATH` | 数据库文件 | `data/bank.db` |
| `START_BLOCK` | 从哪个区块开始同步（填合约部署区块） | `config.js` 的 `deployBlock` |
| `RPC_URL` / `CHAIN_ID` / `CONTRACT_ADDRESS` | 覆盖链和合约配置 | `config.js` |
| `POLL_INTERVAL_MS` | 轮询间隔 | 15000 |
| `CONFIRMATIONS` | 落后链头多少个区块再入库 | 0 |
| `CORS_ORIGIN` | API 的跨域来源（页面和后端不同域时用） | `*` |

### 注意
- ⚠️ **务必填写 `deployBlock`**（`web/config.js`，或环境变量 `START_BLOCK`）：用 `npm run deploy` 部署会自动写入；如果是用 Remix 部署的，到区块浏览器打开合约，把“合约创建交易”所在的区块号填进去。没填时，后端首次只会回溯最近 5 万个区块（Sepolia 约一周），更早的记录不会入库。
- Render 免费套餐没有持久磁盘：服务重启后数据库文件会清空，但会自动从链上重新同步出来（前提是 `deployBlock` 填对了）。想长期保留数据库文件，升级套餐并按 `render.yaml` 里的注释挂载磁盘。免费套餐空闲会休眠，休眠期间不同步，唤醒后自动补齐。
- 链上数据本来就是公开的，API 只是把它整理成方便查询的形式；它不包含任何链上没有的信息。
- 页面和后端不在同一个域名时，把 `web/config.js` 的 `apiUrl` 改成后端地址，例如 `https://xxx.onrender.com/api`。

## 本地测试
```bash
npm test          # 合约单元测试（10 项）+ 数据库 / 索引器 / API 测试（10 项）
npm run test:ui   # 页面端到端测试（20 项，用本地测试链模拟钱包，含全站交易记录）
```

## 合约说明
- `deposit()` / 直接向合约转账：存款
- `withdraw(amount)` / `withdrawAll()`：取款（先改账、后转出，带重入保护）
- `transfer(to, amount)`：站内转账，不能转给自己、零地址、合约本身
- 合约没有管理员、不能被升级，也没有任何人能动用户资金
