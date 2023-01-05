// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";

import "hardhat/console.sol";
import "../interfaces/IPool.sol";

library Errors {
    error InvalidPool();
    error UnknownSender();
    error ZeroAddress();
    error ZeroDebt();
}

contract Payables is ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    ILPool public immutable pool;
    IERC20Metadata public immutable asset;

    EnumerableMap.AddressToUintMap private records;

    constructor(ILPool _pool) {
        if (address(_pool) == address(0)) revert Errors.ZeroAddress();
        if (_pool.expired()) revert Errors.InvalidPool();

        pool = _pool;
        asset = IERC20Metadata(_pool.asset());
    }

    modifier onlyPool() {
        if (msg.sender != address(pool)) revert Errors.UnknownSender();
        _;
    }

    function build(uint _amount) external onlyPool nonReentrant {
        uint _totalDebt = 0;
        uint _length = pool.borrowersLength();

        // Prevent double call to _debt()
        uint[] memory _debts = new uint[](_length);

        // Get the total debt for all borrowers
        for (uint i = 0; i < _length; i++) {
            _debts[i] = pool.debt(pool.borrowers(i));

            _totalDebt += _debts[i];
        }

        if (_totalDebt <= 0) revert Errors.ZeroDebt();
        if (_amount > _totalDebt) _amount = _totalDebt;

        for (uint i = 0; i < _length; i++) {
            uint _debtToBePaid = _amount * _debts[i] / _totalDebt;

            records.set(pool.borrowers(i), _debtToBePaid);
        }

        // We need to approve the pool to spend the amount when we call pay()
        uint _allowance = asset.allowance(address(this), address(pool));

        asset.approve(address(pool), _allowance + _amount);
    }

    function pay() external onlyPool nonReentrant {
        for (uint i = 0; i < records.length(); i++) {
            (address _borrower, uint _debt) = records.at(i);

            // We should check for gasleft here, so we can repay the rest in the next tx if needed
            if (gasleft() <= 200_000) break;
            if (_debt > 0) pool.repayFor(address(this), _borrower, _debt);
        }
    }

    function clean() external onlyPool nonReentrant {
        address[] memory _toRemove = new address[](records.length());
        uint _toRemoveLength = 0;

        for (uint i = 0; i < records.length(); i++) {
            (address _borrower, uint _debt) = records.at(i);

            if (_debt <= 0) {
                _toRemove[_toRemoveLength] = _borrower;
                _toRemoveLength++;
            }
        }

        for (uint i = 0; i < _toRemoveLength; i++) {
            records.remove(_toRemove[i]);
        }
    }
}
