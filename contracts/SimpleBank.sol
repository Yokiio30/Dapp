// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SimpleBank
/// @notice 存款 / 取款 / 站内转账。教学与测试网演示用途，未经审计，请勿存入大额真实资产。
contract SimpleBank {
    mapping(address => uint256) private _balances;
    uint256 public totalDeposits;

    uint256 private _locked = 1;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Transferred(address indexed from, address indexed to, uint256 amount);

    error ZeroAmount();
    error InsufficientBalance(uint256 available, uint256 requested);
    error InvalidRecipient();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @notice 存入 ETH（发送的 msg.value 记入你的余额）
    function deposit() public payable {
        if (msg.value == 0) revert ZeroAmount();
        _balances[msg.sender] += msg.value;
        totalDeposits += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice 直接向合约转账也视为存款
    receive() external payable {
        deposit();
    }

    /// @notice 取出指定数量到你的钱包
    function withdraw(uint256 amount) external nonReentrant {
        _withdraw(amount);
    }

    /// @notice 取出全部余额
    function withdrawAll() external nonReentrant {
        _withdraw(_balances[msg.sender]);
    }

    /// @notice 转账给另一个地址（在合约内部记账，不产生 ETH 外转，省 gas）
    function transfer(address to, uint256 amount) external {
        if (to == address(0) || to == address(this) || to == msg.sender) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = _balances[msg.sender];
        if (bal < amount) revert InsufficientBalance(bal, amount);

        _balances[msg.sender] = bal - amount;
        _balances[to] += amount;
        emit Transferred(msg.sender, to, amount);
    }

    function balanceOf(address user) external view returns (uint256) {
        return _balances[user];
    }

    function _withdraw(uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = _balances[msg.sender];
        if (bal < amount) revert InsufficientBalance(bal, amount);

        // 先改状态，再外部调用（checks-effects-interactions）
        _balances[msg.sender] = bal - amount;
        totalDeposits -= amount;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }
}
