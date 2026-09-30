// 部署到任意 EVM 网络：
//   RPC_URL=https://... PRIVATE_KEY=0x... node scripts/deploy.js
// 部署成功后自动把地址写入 web/config.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

async function main() {
  const { RPC_URL, PRIVATE_KEY } = process.env;
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("请设置环境变量 RPC_URL 和 PRIVATE_KEY（建议使用只放测试币的新钱包）");
    process.exit(1);
  }
  const artifact = require("../build/SimpleBank.json");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const net = await provider.getNetwork();
  console.log("部署账户:", wallet.address, "链 ID:", net.chainId.toString());

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const deployBlock = (await contract.deploymentTransaction().wait()).blockNumber;
  console.log("SimpleBank 已部署:", address);

  const cfgPath = path.join(__dirname, "..", "web", "config.js");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(/contractAddress:\s*"[^"]*"/, `contractAddress: "${address}"`);
  cfg = cfg.replace(/chainId:\s*\d+/, `chainId: ${net.chainId}`);
  cfg = cfg.replace(/deployBlock:\s*\d+/, `deployBlock: ${deployBlock}`);
  fs.writeFileSync(cfgPath, cfg);
  console.log("已更新 web/config.js（如网络不是 Sepolia，请同时检查其中的网络名称、RPC 和区块浏览器）");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
