// 部署合约后修改这里（或运行 npm run deploy 自动写入）
window.BANK_CONFIG = {
  contractAddress: "0x21ABbF803c72099eD93aF5BB4D7A741080fd72da",
  deployBlock: 11814678,           // 合约部署所在区块，用于加载历史记录
  chainId: 11155111,        // 11155111 = Sepolia 测试网
  chainName: "Sepolia",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://sepolia.etherscan.io",
  symbol: "ETH",
  apiUrl: "/api",           // 后端 API（交易记录数据库）。前后端同域时保持 /api；没有后端可留空 ""，页面会隐藏“全站记录”
};
