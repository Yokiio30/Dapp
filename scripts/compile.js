// 用 solc-js 编译合约，输出 build/SimpleBank.json（abi + bytecode）
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const file = path.join(__dirname, "..", "contracts", "SimpleBank.sol");
const input = {
  language: "Solidity",
  sources: { "SimpleBank.sol": { content: fs.readFileSync(file, "utf8") } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
(out.errors || []).forEach((e) => console.log(e.formattedMessage));
if (errors.length) process.exit(1);

const c = out.contracts["SimpleBank.sol"].SimpleBank;
const dir = path.join(__dirname, "..", "build");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, "SimpleBank.json"),
  JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
);
// 前端直接使用同一份 ABI，避免合约和页面不一致
const webDir = path.join(__dirname, "..", "web");
fs.mkdirSync(webDir, { recursive: true });
fs.writeFileSync(
  path.join(webDir, "abi.js"),
  "// 由 scripts/compile.js 自动生成，请勿手改\nwindow.BANK_ABI = " + JSON.stringify(c.abi) + ";\n"
);
console.log("Compiled OK -> build/SimpleBank.json, web/abi.js");
