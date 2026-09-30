# 链上小银行 Dapp（存款 / 取款 / 转账）

手机可用的 ETH 小银行：
- **存款**：把钱包里的 ETH 存进合约
- **取款**：从合约取回到自己的钱包（支持“全部”）
- **转账**：转给另一个地址的银行账户（合约内记账，对方自己取出）
- 显示钱包余额、银行余额、总存款和最近记录；网络不对时一键切换

结构：

```
contracts/SimpleBank.sol   智能合约
web/                        前端（纯静态，部署到 Render 的就是这个目录）
  index.html  config.js  abi.js
scripts/compile.js          编译，并生成 web/abi.js
scripts/deploy.js           命令行部署，自动写入 web/config.js
test/                       合约测试 + 页面端到端测试
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
1. 把整个项目推到 GitHub（`.gitignore` 已排除 node_modules）。
2. Render 控制台：New → Blueprint，选这个仓库，会自动读取 `render.yaml`。
   或者 New → Static Site，Publish Directory 填 `web`，Build Command 留空。
3. 部署完成后得到 `https://xxx.onrender.com`。

## 第 5 步：手机使用
- 在手机上打开 MetaMask（或 Trust / Coinbase Wallet），用它**内置的浏览器**访问你的 Render 网址。
- 在普通手机浏览器里打开时，页面会出现“在 MetaMask 中打开”按钮，点一下即可跳转。
- 点“连接钱包”，网络不对会提示一键切换。

## 本地测试
```bash
npm test          # 合约单元测试（10 项）
npm run test:ui   # 页面端到端测试（13 项，用本地测试链模拟钱包）
```

## 合约说明
- `deposit()` / 直接向合约转账：存款
- `withdraw(amount)` / `withdrawAll()`：取款（先改账、后转出，带重入保护）
- `transfer(to, amount)`：站内转账，不能转给自己、零地址、合约本身
- 合约没有管理员、不能被升级，也没有任何人能动用户资金
