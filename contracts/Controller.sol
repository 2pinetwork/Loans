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

/**
 * @title Controller
 *
 * @dev Controller used by the collateral pool to handle minting and burning
 * and setting the strategy to use (none, yield generation or auto-repay)
 */
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
    uint public minStrategyDepositAmount;

    // Deposit limit a contract can hold
    // This value should be in the same decimal representation as asset
    // 0 value means unlimit
    uint public depositLimit;
    uint public userDepositLimit;
    uint public depositShareThreshold;
    uint public withdrawShareThreshold;

    /**
     * @dev Emitted when for some reason the founds can't be withdrawn from the strategy
     */
    error CouldNotWithdrawFromStrategy();

    /**
     * @dev Emitted when asked amount is greater than the available
     */
    error InsufficientBalance();

    /**
     * @dev Emitted when a restricted method is called by a non pool contract
     */
    error NotPool();


    /**
     * @dev Emitted when trying to set a strategy that is not for the same asset
     */
    error NotSameAsset();

    /**
     * @dev Emitted when trying to retire a strategy that still has funds
     */
    error StrategyStillHasDeposits();

    /**
     * @dev Emitted when for some reason the strategy is paused
     */
    error StrategyPaused();

    /**
     * @dev Emitted when for some reason the price per share is less than the thredhold
     */
    error LowSharePrice();

    /**
     * @dev Emitted when the strategy is changed
     *
     * @param oldStrategy The old strategy
     * @param newStrategy The new strategy
     */
    event StrategyChanged(address oldStrategy, address newStrategy);

    /**
     * @dev Emitted when the treasury is changed
     *
     * @param oldTreasury The old treasury
     * @param newTreasury The new treasury
     */
    event NewTreasury(address oldTreasury, address newTreasury);

    /**
     * @dev Emitted when a new deposit limit is set
     *
     * @param oldLimit The old limit
     * @param newLimit The new limit
     */
    event NewDepositLimit(uint oldLimit, uint newLimit);

    /**
     * @dev Emitted when a new user deposit limit is set
     *
     * @param oldLimit The old limit
     * @param newLimit The new limit
     */
    event NewUserDepositLimit(uint oldLimit, uint newLimit);

    /**
     * @dev Emitted when withdraw fee is taken
     *
     * @param amount The amount of the fee
     */
    event WithdrawalFee(uint amount);

    /**
     * @dev Emitted when a new withdraw fee is set
     *
     * @param oldFee The old fee
     * @param newFee The new fee
     */
    event NewWithdrawFee(uint oldFee, uint newFee);

    /**
     * @dev Emitted when a new min strategy deposit amount is set
     *
     * @param oldAmount The old amount
     * @param newAmount The new amount
     */
    event NewMinStrategyDepositAmount(uint oldAmount, uint newAmount);

    /**
     * @dev Initializes the contract
     *
     * @param _pool The address of the collateral pool
     */
    constructor(ICPool _pool) ERC20(
        string(abi.encodePacked("2pi Collateral ", ERC20(_pool.asset()).symbol())),
        string(abi.encodePacked("2pi-C-", ERC20(_pool.asset()).symbol()))
    ) {
        asset = ERC20(_pool.asset());
        piGlobal = IPiGlobal(_pool.piGlobal());
        treasury = piGlobal.treasury();
        pool = address(_pool);

        minStrategyDepositAmount = 10 ** (asset.decimals() - 1); // default 0.1
        // 99% of share/token value
        depositShareThreshold = (10 ** asset.decimals()) * 9900 / RATIO_PRECISION;
        withdrawShareThreshold = (10 ** asset.decimals()) * 9900 / RATIO_PRECISION;
    }

    /**
     * @dev Modifier to restrict access to only the collateral pool
     */
    modifier onlyPool() {
        if (msg.sender != pool) revert NotPool();
        _;
    }

    /**
     * @dev Returns the decimals of the collateral token
     *
     * @return The decimals of the collateral token
     */
    function decimals() override public view returns (uint8) { return asset.decimals(); }

    // AferTransfer callback to prevent transfers when a debt is still open
    function _afterTokenTransfer(address from, address to, uint256 amount) internal virtual override {
        if (from != address(0) && to != address(0) && amount > 0) {
            IOracle(piGlobal.oracle()).checkHealthy(from);
        }
    }

    /**
     * @dev Sets the treasury address
     *
     * @param _treasury The address of the treasury
     */
    function setTreasury(address _treasury) external onlyOwner nonReentrant {
        if (_treasury == treasury) revert Errors.SameValue();
        if (_treasury == address(0)) revert Errors.ZeroAddress();

        emit NewTreasury(treasury, _treasury);

        treasury = _treasury;
    }

    /**
     * @dev Sets the strategy to use. Zero address means that there's no strategy to put the assets, so
     * the assets will be kept in the controller (no yield)
     *
     * @param _newStrategy The address of the strategy
     */
    function setStrategy(IStrategy _newStrategy) external onlyOwner nonReentrant {
        if (_newStrategy == strategy) revert Errors.SameValue();

        if (address(_newStrategy) != address(0) && _newStrategy.want() != address(asset)) revert NotSameAsset();

        if (address(strategy) != address(0)) {
            strategy.retireStrat();

            if (strategy.balance() > 0) revert StrategyStillHasDeposits();
        }

        emit StrategyChanged(address(strategy), address(_newStrategy));

        strategy = _newStrategy;

        // Ensure it doesn't revert for low amount
        if (assetBalance() >= minStrategyDepositAmount) _strategyDeposit();
    }

    /**
     * @dev Sets the withdrawal fee
     *
     * @param _fee The fee to set
     */
    function setWithdrawFee(uint _fee) external onlyOwner nonReentrant {
        if (_fee == withdrawFee) revert Errors.SameValue();
        if (_fee > MAX_WITHDRAW_FEE) revert Errors.GreaterThan('MAX_WITHDRAW_FEE');

        emit NewWithdrawFee(withdrawFee, _fee);

        withdrawFee = _fee;
    }

    /**
     * @dev Sets the deposit limit
     *
     * @param _amount The amount to set
     */
    function setDepositLimit(uint _amount) external onlyOwner nonReentrant {
        if (_amount == depositLimit) revert Errors.SameValue();

        emit NewDepositLimit(depositLimit, _amount);

        depositLimit = _amount;
    }

    /**
     * @dev Sets the user deposit limit
     *
     * @param _amount The amount to set
     */
    function setUserDepositLimit(uint _amount) external onlyOwner nonReentrant {
        if (_amount == userDepositLimit) revert Errors.SameValue();

        emit NewUserDepositLimit(userDepositLimit, _amount);

        userDepositLimit = _amount;
    }

    /**
     * @dev Sets the minimum amount of assets to deposit in the strategy
     *
     * @param _amount The amount to set
     */
    function setMinStrategyDepositAmount(uint _amount) external onlyOwner nonReentrant {
        if (_amount == minStrategyDepositAmount) revert Errors.SameValue();

        emit NewMinStrategyDepositAmount(minStrategyDepositAmount, _amount);

        minStrategyDepositAmount = _amount;
    }

    function setDepositShareThreshold(uint _t) external onlyOwner nonReentrant {
        if (depositShareThreshold == _t) revert Errors.SameValue();

        depositShareThreshold = _t;
    }

    function setWithdrawShareThreshold(uint _t) external onlyOwner nonReentrant {
        if (withdrawShareThreshold == _t) revert Errors.SameValue();

        withdrawShareThreshold = _t;
    }


    /**
     * @dev Deposits collateral into the pool
     *
     * @param _senderUser The user account that is depositing
     * @param _amount The amount to deposit
     */
    function deposit(address _senderUser, uint _amount) external nonReentrant onlyPool returns (uint _shares) {
        if (_amount == 0) revert Errors.ZeroAmount();
        _checkDepositLimit(_senderUser, _amount);
        _checkDepositShareThreadhold();

        if (_withStrat()) strategy.beforeMovement();

        uint _before = balance();

        asset.safeTransferFrom(
            pool, // Pool
            address(this),
            _amount
        );

        uint _diff = balance() - _before;

        _shares = (totalSupply() == 0) ? _diff : (_diff * totalSupply() / _before);

        _mint(_senderUser, _shares);

        _strategyDeposit();

        _checkDepositShareThreadhold();
    }

    /**
     * @dev Withdraws collateral from the pool, normally used with a vault withdrawal
     *
     * @param _caller The caller of the function
     * @param _owner The owner of the shares
     * @param _shares The amount of shares to withdraw
     *
     * @return The amount of collateral withdrawn
     * @return The amount of shares burned
     */
    function withdraw(address _caller, address _owner, uint _shares) external onlyPool nonReentrant returns (uint, uint) {
        if (_shares == 0) revert Errors.ZeroShares();
        if (_withStrat()) strategy.beforeMovement();

        uint _amount = balance() * _shares / totalSupply();

        // Override with what really have been withdrawn
        return _withdraw(_caller, _owner, _shares, _amount, true);
    }

    /**
     * @dev Withdraws collateral from the pool, without withdrawal fee. If the
     * withdrawn amount is more than the requested the rest will be
     * returned to the strategy. We don't want to liquidate more than needed
     *
     * @param _owner The owner of the shares
     * @param _expectedAmount The amount of collateral to withdraw
     *
     * @return _withdrawn The amount of collateral withdrawn
     */
    function withdrawForLiquidation(address _owner, uint _expectedAmount) external onlyPool nonReentrant returns (uint _withdrawn) {
        if (_expectedAmount == 0) revert Errors.ZeroAmount();
        if (_withStrat()) strategy.beforeMovement();

        uint _shares = _expectedAmount * totalSupply() / balance();

        (_withdrawn, ) = _withdraw(_owner, _owner, _shares, _expectedAmount, false);
    }

    function _withdraw(address _caller, address _owner, uint _shares, uint _amount, bool _withFee) internal returns (uint, uint) {
        if (_amount == 0 || _shares == 0) revert Errors.ZeroAmount();
        _checkWithdrawShareThreadhold();

        uint _toTransfer = _amount;
        uint _balance = assetBalance();

        if (_balance < _amount) {
            if (! _withStrat()) revert InsufficientBalance();

            uint _diff = _amount - _balance;

            // withdraw will revert if anyything weird happend with the
            // transfer back but just in case we ensure that the withdraw is
            // positive
            uint _withdrawn = strategy.withdraw(_diff);
            if (_withdrawn == 0) revert CouldNotWithdrawFromStrategy();

            _balance = assetBalance();
            if (_balance < _amount) _toTransfer = _balance;
        }

        // In case the strategy returns less than the requested amount
        // and the user is not the only one in the pool trying to withdraw all.
        // If it's the only one withdrawing all the funds. The price share check
        // will revert because of balance is 0
        if (_toTransfer < _amount && totalSupply() != _shares)
            _shares = _toTransfer * _shares / _amount;

        uint _withdrawalFee;
        if (_withFee) {
            _withdrawalFee = _toTransfer * withdrawFee / RATIO_PRECISION;

            if (_withdrawalFee > 0) _toTransfer -= _withdrawalFee;
        }

        if (_caller != _owner) _spendAllowance(_owner, _caller, _shares);

        _burn(_owner, _shares);

        if (_withdrawalFee > 0) {
            asset.safeTransfer(treasury, _withdrawalFee);
            emit WithdrawalFee(_withdrawalFee);
        }

        asset.safeTransfer(pool, _toTransfer);

        // Ensure it doesn't revert for low amount
        if (assetBalance() >= minStrategyDepositAmount) _strategyDeposit();

        _checkWithdrawShareThreadhold();

        return (_toTransfer, _shares);
    }

    /**
     * @dev Returns the balance of the strategy
     *
     * @return The balance of the strategy
     */
    function strategyBalance() public view returns (uint) {
        return _withStrat() ? strategy.balance() : 0;
    }

    /**
     * @dev Returns this controller balance of the asset
     *
     * @return The balance of the asset
     */
    function assetBalance() public view returns (uint) { return asset.balanceOf(address(this)); }

    /**
     * @dev Returns the balance of the asset on this controller and the strategy
     *
     * @return The balance of the asset
     */
    function balance() public view returns (uint) { return assetBalance() + strategyBalance(); }

    /**
     * @dev Returns the shares equivalent of the amount of liquidity.
     *
     * @param _amount The amount of liquidity
     *
     * @return The shares equivalent of the amount of liquidity
     */
    function convertToShares(uint _amount) external view returns (uint) {
        // Save some gas
        uint _totalSupply = totalSupply();

        return (_totalSupply == 0) ? _amount : (_amount * _totalSupply) / balance();
    }

    /**
     * @dev Returns the amount of liquidity equivalent of the shares.
     *
     * @param _shares The amount of shares
     *
     * @return The amount of liquidity equivalent of the shares
     */
    function convertToAssets(uint _shares) public view returns (uint) {
        // Save some gas
        uint _totalSupply = totalSupply();

        return (_totalSupply == 0) ? _shares : _shares * balance() / _totalSupply;
    }

    /**
     * @dev Returns the max amount of asset that can be deposited
     *
     * @return _available The max amount of asset that can be deposited
     */
    function availableDeposit() external view returns (uint _available) {
        if (depositLimit == 0) { // without limit
            _available = type(uint).max;
        } else if (balance() < depositLimit) {
            _available = depositLimit - balance();
        }
    }

    /**
     * @dev Returns the max amount of asset that can be deposited by the user
     *
     * @param _user The user to check
     *
     * @return _available The max amount of asset that can be deposited by the user
     */
    function availableUserDeposit(address _user) public view returns (uint _available) {
        if (userDepositLimit == 0) { // without limit
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

    // This shouldn't be called with strategy paused or low amount
    function _strategyDeposit() internal {
        if (! _withStrat()) return;
        // If the line before didn't break the flow, strategy is present
        if (strategy.paused()) revert StrategyPaused();
        uint _amount = assetBalance();

        // Only transfer and call strategy if the deposit threshold is exceeded
        if (_amount >= minStrategyDepositAmount) {
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

    /**
     * @dev Returns the price per share
     *
     * @return The price per share
     */
    function pricePerShare() public view returns (uint) {
        uint _totalSupply = totalSupply();

        return _totalSupply == 0 ? _precision() : (balance() * _precision() / _totalSupply);
    }

    function _precision() internal view returns (uint) { return 10 ** decimals(); }
    function _withStrat() internal view returns (bool) { return address(strategy) != address(0); }

    function _checkDepositShareThreadhold() internal view {
        if (depositShareThreshold > pricePerShare()) revert LowSharePrice();
    }

    function _checkWithdrawShareThreadhold() internal view {
        if (withdrawShareThreshold > pricePerShare()) revert LowSharePrice();
    }
}
