const test = require("node:test");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");
const artifact = require("../build/SimpleBank.json");

const E = ethers.parseEther;

async function setup() {
  const server = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4 } });
  const provider = new ethers.BrowserProvider(server);
  const [a, b, c] = [await provider.getSigner(0), await provider.getSigner(1), await provider.getSigner(2)];
  const f = new ethers.ContractFactory(artifact.abi, artifact.bytecode, a);
  const bank = await f.deploy();
  await bank.waitForDeployment();
  return { server, provider, a, b, c, bank };
}

const revertsWith = async (p, name) => {
  await assert.rejects(p, (e) => {
    const s = `${e.message} ${e.revert?.name ?? ""} ${e.errorName ?? ""}`;
    return s.includes(name);
  });
};

test("存款增加余额和总额，并触发事件", async () => {
  const { bank, a, server } = await setup();
  const tx = await bank.deposit({ value: E("1") });
  const rc = await tx.wait();
  assert.equal(await bank.balanceOf(a.address), E("1"));
  assert.equal(await bank.totalDeposits(), E("1"));
  assert.equal(rc.logs.length, 1);
  await server.disconnect();
});

test("直接向合约转账视为存款", async () => {
  const { bank, a, server } = await setup();
  await (await a.sendTransaction({ to: await bank.getAddress(), value: E("0.5") })).wait();
  assert.equal(await bank.balanceOf(a.address), E("0.5"));
  await server.disconnect();
});

test("存 0 会失败", async () => {
  const { bank, server } = await setup();
  await revertsWith(bank.deposit.staticCall({ value: 0 }), "ZeroAmount");
  await server.disconnect();
});

test("取款：余额减少，钱包收到 ETH", async () => {
  const { bank, a, provider, server } = await setup();
  await (await bank.deposit({ value: E("2") })).wait();
  const before = await provider.getBalance(a.address);
  const rc = await (await bank.withdraw(E("1"))).wait();
  const gas = rc.gasUsed * rc.gasPrice;
  const after = await provider.getBalance(a.address);
  assert.equal(after - before + gas, E("1"));
  assert.equal(await bank.balanceOf(a.address), E("1"));
  assert.equal(await bank.totalDeposits(), E("1"));
  await server.disconnect();
});

test("取款超过余额会失败", async () => {
  const { bank, server } = await setup();
  await (await bank.deposit({ value: E("1") })).wait();
  await revertsWith(bank.withdraw.staticCall(E("2")), "InsufficientBalance");
  await server.disconnect();
});

test("全部取出", async () => {
  const { bank, a, server } = await setup();
  await (await bank.deposit({ value: E("1.5") })).wait();
  await (await bank.withdrawAll()).wait();
  assert.equal(await bank.balanceOf(a.address), 0n);
  assert.equal(await bank.totalDeposits(), 0n);
  await server.disconnect();
});

test("转账：双方余额变化，总额不变", async () => {
  const { bank, a, b, server } = await setup();
  await (await bank.deposit({ value: E("3") })).wait();
  await (await bank.transfer(b.address, E("1"))).wait();
  assert.equal(await bank.balanceOf(a.address), E("2"));
  assert.equal(await bank.balanceOf(b.address), E("1"));
  assert.equal(await bank.totalDeposits(), E("3"));
  await server.disconnect();
});

test("转账：余额不足、给自己、零地址、0 金额都会失败", async () => {
  const { bank, a, b, server } = await setup();
  await (await bank.deposit({ value: E("1") })).wait();
  await revertsWith(bank.transfer.staticCall(b.address, E("2")), "InsufficientBalance");
  await revertsWith(bank.transfer.staticCall(a.address, E("1")), "InvalidRecipient");
  await revertsWith(bank.transfer.staticCall(ethers.ZeroAddress, E("1")), "InvalidRecipient");
  await revertsWith(bank.transfer.staticCall(b.address, 0), "ZeroAmount");
  await server.disconnect();
});

test("收款人可以取出收到的转账", async () => {
  const { bank, b, server } = await setup();
  await (await bank.deposit({ value: E("1") })).wait();
  await (await bank.transfer(b.address, E("1"))).wait();
  await (await bank.connect(b).withdraw(E("1"))).wait();
  assert.equal(await bank.balanceOf(b.address), 0n);
  await server.disconnect();
});

test("别人不能取走你的钱（无余额取款失败）", async () => {
  const { bank, c, server } = await setup();
  await (await bank.deposit({ value: E("1") })).wait();
  await revertsWith(bank.connect(c).withdraw.staticCall(E("1")), "InsufficientBalance");
  await server.disconnect();
});
