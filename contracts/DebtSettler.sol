// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";

import {ILPool} from "../interfaces/IPool.sol";

import "../libraries/Errors.sol";

contract DebtSettler is ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using EnumerableSet for EnumerableSet.AddressSet;

    ILPool public immutable pool;
    IERC20Metadata public immutable asset;

    // Keep track of the credit for each borrower
    EnumerableMap.AddressToUintMap internal _records;
    // Keep track of borrowers
    EnumerableSet.AddressSet internal _borrowers;

    error InvalidPool();
    error UnknownSender();

    constructor(ILPool _pool) {
        if (address(_pool) == address(0)) revert Errors.ZeroAddress();
        if (_pool.expired()) revert InvalidPool();

        pool = _pool;
        asset = IERC20Metadata(_pool.asset());
    }

    modifier onlyPool() {
        if (msg.sender != address(pool)) revert UnknownSender();
        _;
    }

    function build(uint _amount) external onlyPool nonReentrant {
        uint _totalDebt = 0;
        uint _length = _borrowers.length();

        // Prevent double call to _debt()
        uint[] memory _debts = new uint[](_length);

        // Get the total debt for all borrowers
        for (uint i = 0; i < _length; i++) {
            _debts[i] = pool.debt(_borrowers.at(i));

            _totalDebt += _debts[i];
        }

        if (_totalDebt <= 0) return;
        if (_amount > _totalDebt) _amount = _totalDebt;

        for (uint i = 0; i < _length; i++) {
            address _borrower = _borrowers.at(i);
            uint _credit = _amount * _debts[i] / _totalDebt;
            (, uint _currentCredit) = _records.tryGet(_borrower);

            _credit += _currentCredit; // we have to accumulate each time =)

            _records.set(_borrower, _credit);
        }
    }

    function pay() external nonReentrant {
        asset.approve(address(pool), asset.balanceOf(address(this)));

        for (uint i = 0; i < _records.length(); i++) {
            (address _borrower, uint _debt) = _records.at(i);

            // We should check for gasleft here, so we can repay the rest in the next tx if needed
            if (gasleft() <= 50_000) break;
            if (_debt > 0) pool.repayFor(_borrower, _debt);
        }
    }

    function clean() external nonReentrant {
        address[] memory _toRemove = new address[](_records.length());
        uint _toRemoveLength = 0;

        for (uint i = 0; i < _records.length(); i++) {
            (address _borrower, uint _debt) = _records.at(i);

            if (_debt <= 0) _toRemove[_toRemoveLength++] = _borrower;
        }

        for (uint i = 0; i < _toRemoveLength; i++) {
            _records.remove(_toRemove[i]);
        }
    }

    function addBorrower(address _borrower) external onlyPool nonReentrant {
        _borrowers.add(_borrower);
    }

    function removeBorrower(address _borrower) external onlyPool nonReentrant {
        _borrowers.remove(_borrower);
    }
}