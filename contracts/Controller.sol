// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ICPool} from "../interfaces/IPool.sol";
import "../interfaces/IPiGlobal.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IOracle.sol";
import "../libraries/Errors.sol";

contract Controller is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for ERC20;

    address public immutable pool;
    ERC20 public immutable asset;
    IPiGlobal public immutable piGlobal;

    IStrategy public strategy;
    address public treasury;

    // Fees
    uint constant public RATIO_PRECISION = 10000;
    uint constant public MAX_WITHDRAW_FEE = 100; // 1%
    uint public withdrawFee = 0; // 0%

    // Deposit limit a contract can hold
    // This value should be in the same decimal representation as asset
    // 0 value means unlimit
    uint public depositLimit;
    uint public userDepositLimit;

    event StrategyChanged(address oldStrategy, address newStrategy);
    event NewTreasury(address oldTreasury, address newTreasury);
    event NewDepositLimit(uint oldLimit, uint newLimit);
    event NewUserDepositLimit(uint oldLimit, uint newLimit);
    event WithdrawalFee(uint amount);
    event NewWithdrawFee(uint oldFee, uint newFee);

    error CouldNotWithdrawFromStrategy();
    error InsufficientBalance();
    error NotPool();
    error NotSameAsset();
    error StrategyStillHasDeposits();

    constructor(ICPool _pool) ERC20(
        string(abi.encodePacked("2pi Collateral ", ERC20(_pool.asset()).symbol())),
        string(abi.encodePacked("2pi-C-", ERC20(_pool.asset()).symbol()))
    ) {
        asset = ERC20(_pool.asset());
        piGlobal = IPiGlobal(_pool.piGlobal());
        treasury = piGlobal.treasury();
        pool = address(_pool);
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert NotPool();
        _;
    }

    function decimals() override public view returns (uint8) { return asset.decimals(); }

    // AferTransfer callback to prevent transfers when a debt is still open
    function _afterTokenTransfer(address from, address to, uint256 amount) internal virtual override {
        if (from != address(0) && to != address(0) && amount > 0) {
            IOracle(piGlobal.oracle()).checkHealthy(from);
        }
    }

    function setTreasury(address _treasury) external onlyOwner nonReentrant {
        if (_treasury == treasury) revert Errors.SameValue();
        if (_treasury == address(0)) revert Errors.ZeroAddress();

        emit NewTreasury(treasury, _treasury);

        treasury = _treasury;
    }

    // ZeroAddress means that there's no strategy to put the assets, so the assets
    // will be kept in the controller (no yield)
    function setStrategy(IStrategy _newStrategy) external onlyOwner nonReentrant {
        if (_newStrategy == strategy) revert Errors.SameValue();

        if (address(_newStrategy) != address(0) && _newStrategy.want() != address(asset)) revert NotSameAsset();

        if (address(strategy) != address(0)) {
            strategy.retireStrat();

            if (strategy.balance() > 0) revert StrategyStillHasDeposits();
        }

        emit StrategyChanged(address(strategy), address(_newStrategy));

        strategy = _newStrategy;

        _strategyDeposit();
    }

    function setWithdrawFee(uint _fee) external onlyOwner nonReentrant {
        if (_fee == withdrawFee) revert Errors.SameValue();
        if (_fee > MAX_WITHDRAW_FEE) revert Errors.GreaterThan('MAX_WITHDRAW_FEE');

        emit NewWithdrawFee(withdrawFee, _fee);

        withdrawFee = _fee;
    }

    function setDepositLimit(uint _amount) external onlyOwner nonReentrant {
        if (_amount == depositLimit) revert Errors.SameValue();

        emit NewDepositLimit(depositLimit, _amount);

        depositLimit = _amount;
    }

    function setUserDepositLimit(uint _amount) external onlyOwner nonReentrant {
        if (_amount == userDepositLimit) revert Errors.SameValue();

        emit NewUserDepositLimit(userDepositLimit, _amount);

        userDepositLimit = _amount;
    }

    function deposit(address _senderUser, uint _amount) external nonReentrant onlyPool returns (uint _shares) {
        if (_amount <= 0) revert Errors.ZeroAmount();
        _checkDepositLimit(_senderUser, _amount);

        if (_withStrat()) strategy.beforeMovement();

        uint _before = balance();

        asset.safeTransferFrom(
            pool, // Pool
            address(this),
            _amount
        );

        uint _diff = balance() - _before;

        _shares = (totalSupply() <= 0) ? _diff : (_diff * totalSupply()) / _before;

        _mint(_senderUser, _shares);

        _strategyDeposit();
    }

    // Withdraw partial funds, normally used with a vault withdrawal
    function withdraw(address _senderUser, uint _shares) external onlyPool nonReentrant returns (uint) {
        if (_shares <= 0) revert Errors.ZeroShares();
        if (_withStrat()) strategy.beforeMovement();

        uint _amount = (balance() * _shares) / totalSupply();

        // Override with what really have been withdrawn
        return _withdraw(_senderUser, _shares, _amount, true);
    }

    // Same as withdraw, but without withdrawal fee
    // and if the withdrawn amount is more than the requested amount
    // it will be returned to the strategy. We don't want to liquidate more than needed
    function withdrawForLiquidation(address _senderUser, uint _expectedAmount) external onlyPool nonReentrant returns (uint _withdrawn) {
        if (_expectedAmount <= 0) revert Errors.ZeroAmount();
        if (_withStrat()) strategy.beforeMovement();

        uint _shares = _expectedAmount * totalSupply() / balance();

        return _withdraw(_senderUser, _shares, _expectedAmount, false);
    }

    function _withdraw(address _senderUser, uint _shares, uint _amount, bool _withFee) internal returns (uint) {
        if (_amount <= 0 || _shares <= 0) revert Errors.ZeroAmount();

        _burn(_senderUser, _shares);

        uint _balance = assetBalance();

        if (_balance < _amount) {
            if (! _withStrat()) revert InsufficientBalance();

            uint _diff = _amount - _balance;

            // withdraw will revert if anyything weird happend with the
            // transfer back but just in case we ensure that the withdraw is
            // positive
            uint withdrawn = strategy.withdraw(_diff);
            if (withdrawn <= 0) revert CouldNotWithdrawFromStrategy();

            _balance = assetBalance();
            if (_balance < _amount) _amount = _balance;
        }

        if (_withFee) {
            uint _withdrawalFee = _amount * withdrawFee / RATIO_PRECISION;

            if (_withdrawalFee > 0) {
                _amount -= _withdrawalFee;

                asset.safeTransfer(treasury, _withdrawalFee);
                emit WithdrawalFee(_withdrawalFee);
            }
        }

        asset.safeTransfer(pool, _amount);

        _strategyDeposit();

        return _amount;
    }

    function strategyBalance() public view returns (uint){
        return _withStrat() ? strategy.balance() : 0;
    }

    function assetBalance() public view returns (uint) { return asset.balanceOf(address(this)); }

    function balance() public view returns (uint) { return assetBalance() + strategyBalance(); }

    // Check whats the max available amount to deposit
    function availableDeposit() external view returns (uint _available) {
        if (depositLimit <= 0) { // without limit
            _available = type(uint).max;
        } else if (balance() < depositLimit) {
            _available = depositLimit - balance();
        }
    }

    function availableUserDeposit(address _user) public view returns (uint _available) {
        if (userDepositLimit <= 0) { // without limit
            _available = type(uint).max;
        } else {
            _available = userDepositLimit;
            // if there's no deposit yet, the totalSupply division raise
            if (totalSupply() > 0) {
                // Check the real amount in asset for the user
                uint _current = balanceOf(_user) * pricePerShare() / _precision();

                if (_current >= _available) {
                    _available = 0;
                }  else {
                    _available -= _current;
                }
            }
        }
    }

    function _strategyDeposit() internal {
        if (! _withStrat()) return;
        // If the line before didn't break the flow, strategy is present
        if (strategy.paused()) return;

        uint _amount = assetBalance();

        if (_amount > 0) {
            asset.safeTransfer(address(strategy), _amount);

            strategy.deposit();
        }
    }

    function _checkDepositLimit(address _user, uint _amount) internal view {
        // 0 depositLimit means no-limit
        if (depositLimit > 0 && (balance() + _amount) > depositLimit)
            revert Errors.GreaterThan("depositLimit");

        if (userDepositLimit > 0 && _amount > availableUserDeposit(_user))
            revert Errors.GreaterThan("userDepositLimit");
    }

    function pricePerShare() public view returns (uint) {
        return totalSupply() <= 0 ? _precision() : (balance() * _precision() / totalSupply());
    }

    function _precision() internal view returns (uint) { return 10 ** decimals(); }
    function _withStrat() internal view returns (bool) { return address(strategy) != address(0); }
}
