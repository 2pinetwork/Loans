// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import  "./PiAdmin.sol";
import "../interfaces/IController.sol";
import "../interfaces/IOracle.sol";
import "../interfaces/IPiGlobal.sol";
import {ILPool} from "../interfaces/IPool.sol";
import "../libraries/Errors.sol";

/**
 * @title CollateralPool
 *
 * @notice The CollateralPool contract is responsible for managing the collateral of some asset.
 *
 * @dev The CollateralPool contract is responsible for managing the collateral of some asset, and if chosen, it can also generate some yield or repay some debt using earned interest.
 */
contract CollateralPool is PiAdmin, Pausable {
    using SafeERC20 for IERC20Metadata;

    IERC20Metadata public immutable asset;
    IPiGlobal public immutable piGlobal;

    // Should be immutable but it's not set in constructor
    // to prevent large contract size
    IController public controller;

    // The percentage of collateral from this pool that can be used as
    // collateral for loans. 100% = 1e18
    uint public collateralRatio;
    uint public constant MAX_COLLATERAL_RATIO = 1e18;
    bool public onlyEOA;
    // Whitelisted addresses to interact with the pool
    mapping(address => bool) public whitelisted;
    bool public whitelistEnabled;

    /**
     * @dev Throws if called when a controller is already set.
     */
    error AlreadyInitialized();

    /**
     * @dev Throws when for some reason the liquidation is not possible.
     */
    error CantLiquidate(string);

    /**
     * @dev Throws if the given controller is not a valid one.
     */
    error InvalidController();

    /**
     * @dev Throws when withdrawing would return 0.
     */
    error NoFundsWithdrawn();

    /**
     * @dev Throws when the account is not allowed to perform the action because it's not an EOA.
     */
    error OnlyEOA();

    /**
     * @dev Throws when the account is not whitelisted to perform the action.
     */
    error NotWhitelisted();

    /**
     * @dev Initializes the contract.
     *
     * @param _piGlobal The address of the PiGlobal contract.
     * @param _asset The address of the asset that this pool manages.
     */
    constructor(IPiGlobal _piGlobal, IERC20Metadata _asset) {
        if (address(_piGlobal) == address(0)) revert Errors.ZeroAddress();

        // just to check
        _piGlobal.collateralPools();
        _piGlobal.liquidityPools();

        // Ensure at least has ERC20 methods
        _asset.symbol();
        _asset.decimals();
        _asset.balanceOf(address(this));

        asset = _asset;
        piGlobal = _piGlobal;
    }

    /**
     * @dev Modifier to restrict access to only EOA accounts and/or whitelisted addresses.
     */
    modifier checkAccess() {
        if (onlyEOA && (msg.sender != tx.origin || msg.sender.code.length > 0)) revert OnlyEOA();
        if (whitelistEnabled && !whitelisted[msg.sender]) revert NotWhitelisted();
        _;
    }

    /**
     * @dev Emitted when a user deposits some asset into the pool.
     *
     * @param _sender The address of the user who sent the deposit transaction.
     * @param _onBehalfOf The address of the user on behalf of whom the deposit was made.
     * @param _amount The amount of asset deposited.
     * @param _shares The amount of shares minted.
     */
    event Deposit(address _sender, address _onBehalfOf, uint _amount, uint _shares);

    /**
     * @dev Emitted when a user withdraws some asset from the pool.
     *
     * @param _sender The address of the user who sent the withdrawal request.
     * @param _to The address of the user to whom the withdrawal was made.
     * @param _owner The address of the user who owns the shares.
     * @param _amount The amount of asset withdrawn.
     * @param _shares The amount of shares burned.
     */
    event Withdraw(address _sender, address _to, address _owner, uint _amount, uint _shares);

    /**
     * @dev Emitted when the collateral ratio is changed.
     *
     * @param _oldRatio The old collateral ratio.
     * @param _newRatio The new collateral ratio.
     */
    event NewCollateralRatio(uint _oldRatio, uint _newRatio);

    /**
     * @dev Emitted when a liquidation is performed.
     *
     * @param _liquidator The address of the originator of the liquidation.
     * @param _liquidated The address of the user who was liquidated.
     * @param _collateral The amount of collateral withdrawn.
     * @param _liquidityPool The address of the liquidity pool on which the liquidity was restored.
     * @param _debt The amount of debt settled.
     */
    event LiquidationCall(address _liquidator, address _liquidated, uint _collateral, address _liquidityPool, uint _debt);

    /**
     * @dev Emitted when the controller is changed.
     *
     * @param _controller The new controller.
     */
    event ControllerSet(address _controller);

    /**
     * @dev Sets the controller of the pool.
     *
     * @param _controller The address of the controller.
     */
    function setController(IController _controller) external onlyAdmin nonReentrant {
        if (address(_controller) == address(0)) revert Errors.ZeroAddress();
        if (address(controller) != address(0)) revert AlreadyInitialized();
        // Controller constructor takes pool asset & piGlobal
        if (_controller.pool() != address(this)) revert InvalidController();

        emit ControllerSet(address(_controller));

        controller = _controller;
    }

    /**
     * @dev Sets the collateral ratio of the pool.
     *
     * @param _collateralRatio The new collateral ratio.
     */
    function setCollateralRatio(uint _collateralRatio) external onlyAdmin nonReentrant {
        if (_collateralRatio == collateralRatio) revert Errors.SameValue();
        if (_collateralRatio > MAX_COLLATERAL_RATIO) revert Errors.GreaterThan("MAX_COLLATERAL_RATIO");

        emit NewCollateralRatio(_collateralRatio, collateralRatio);

        collateralRatio = _collateralRatio;
    }

    /**
     * @dev Returns the balance for the given account.
     *
     * @param _account The address of the account.
     *
     * @return The balance of the account.
     */
    function balanceOf(address _account) public view returns (uint) {
        return controller.balanceOf(_account);
    }

    /**
     * @dev Returns the shares equivalent of the amount of liquidity.
     *
     * @param _amount The amount of liquidity.
     *
     * @return The shares equivalent of the amount of liquidity.
     */
    function convertToShares(uint _amount) public view returns (uint) {
        return controller.convertToShares(_amount);
    }

    /**
     * @dev Returns the liquidity equivalent of the amount of shares.
     *
     * @param _shares The amount of shares.
     *
     * @return The liquidity equivalent of the amount of shares.
     */
    function convertToAssets(uint _shares) public view returns (uint) {
        return controller.convertToAssets(_shares);
    }

    /**
     * @dev Returns the total amount of assets in the pool.
     *
     * @return The total amount of assets in the pool.
     */
    function totalAssets() public view returns (uint) {
        return controller.balance();
    }

    /**
     * @dev Return the maximum amount of assets deposit would allow to be deposited.
     *
     * @param _receiver The address of the user on behalf of whom the deposit is made.
     *
     * @return The maximum amount of assets deposit would allow to be deposited.
     */
    function maxDeposit(address _receiver) public view returns (uint) {
        return controller.availableUserDeposit(_receiver);
    }

    /**
     * @dev Returns the maximum amount of shares allowed to be minted.
     *
     * @param _receiver The address of the user on behalf of whom the mint is made.
     *
     * @return The maximum amount of shares allowed to be minted.
     */
    function maxMint(address _receiver) public view returns (uint) {
        uint _maxDeposit = controller.availableUserDeposit(_receiver);

        return controller.convertToShares(_maxDeposit);
    }

    /**
     * @dev Returns the amount of shares if user deposits the given amount of assets.
     *
     * @param _amount The amount of assets to deposit.
     *
     * @return The amount of shares if user deposits the given amount of assets.
     */
    function previewDeposit(uint _amount) public view returns (uint) {
        return controller.convertToShares(_amount);
    }

    /**
     * @dev Returns the amount of assets if user withdraws the given amount of shares.
     *
     * @param _shares The amount of shares to withdraw.
     *
     * @return The amount of assets if user withdraws the given amount of shares.
     */
    function previewMint(uint _shares) public view returns (uint) {
        return controller.convertToAssets(_shares);
    }

    /**
     * @dev Mints shares to receiver by depositing assets to the pool.
     *
     * @param _shares The amount of shares to mint.
     * @param _to The address of the receiver.
     *
     * @return The amount of assets deposited.
     */
    function mint(uint _shares, address _to) external nonReentrant checkAccess returns (uint) {
        if (_to == address(0)) revert Errors.ZeroAddress();

        uint _amount = controller.convertToAssets(_shares);

        _deposit(_amount, _to);

        return _amount;
    }

    /**
     * @dev Maximum amount of the underlying asset that can be withdrawn by the receiver.
     *
     * @param _receiver The address of the user on behalf of whom the withdraw is made.
     *
     * @return The maximum amount of the underlying asset that can be withdrawn by the receiver.
     */
    function maxWithdraw(address _receiver) public view returns (uint) {
        return controller.convertToAssets(controller.balanceOf(_receiver));
    }

    /**
     * @dev Returns the amount of shares if user withdraws the given amount of assets.
     *
     * @param _amount The amount of assets to withdraw.
     *
     * @return The amount of shares if user withdraws the given amount of assets.
     */
    function previewWithdraw(uint _amount) public view returns (uint) {
        return controller.convertToShares(_amount);
    }

    /**
     * @dev Returns the maximum amount of shares that can be redeemed from the owner.
     *
     * @param _owner The address of the owner.
     *
     * @return The maximum amount of shares that can be redeemed from the owner.
     */
    function maxRedeem(address _owner) public view returns (uint) {
        return controller.balanceOf(_owner);
    }

    /**
     * @dev Returns the amount of assets if user redeems the given amount of shares.
     *
     * @param _shares The amount of shares to redeem.
     *
     * @return The amount of assets if user redeems the given amount of shares.
     */
    function previewRedeem(uint _shares) public view returns (uint) {
        return controller.convertToAssets(_shares);
    }

    /**
     * @dev Performs a withdraw from the pool.
     *
     * @param _shares The amount of shares to withdraw.
     * @param _to The address of the user on behalf of whom the withdraw is made.
     *
     * @return The amount of assets withdrawn.
     */
    function redeem(uint _shares, address _to) external nonReentrant whenNotPaused checkAccess returns (uint) {
        return _withdraw(_shares, _to, msg.sender);
    }

    /**
     * @dev Returns the total balance of the controller.
     *
     * @return The total balance of the controller.
     */
    function balance() public view returns (uint) { return controller.balance(); }

    /**
     * @dev Returns the controller's decimals.
     *
     * @return The decimals of the controller.
     */
    function decimals() public view returns (uint8) { return controller.decimals(); }

    /**
     * @dev Returns the controller's price per share.
     *
     * @return The controller's price per share.
     */
    function pricePerShare() public view returns (uint) { return controller.pricePerShare(); }

    /**
     * @dev Performs a deposit into the pool.
     *
     * @param _amount The amount of asset to deposit.
     * @param _onBehalfOf The address of the user on behalf of whom the deposit is made.
     */
    function deposit(uint _amount, address _onBehalfOf) external nonReentrant checkAccess {
        _deposit(_amount, _onBehalfOf);
    }

    /**
     * @dev Performs a deposit into the pool on behalf of the sender.
     *
     * @param _amount The amount of asset to deposit.
     */
    function deposit(uint _amount) external nonReentrant checkAccess {
        _deposit(_amount, msg.sender);
    }

    /**
     * @dev Performs a withdrawal from the pool.
     *
     * @param _shares The amount of shares to withdraw.
     * @param _to The address of the user to whom the withdrawal is made.
     * @param _owner The address of the owner.
     *
     * @return The amount of assets withdrawn.
     */
    function withdraw(uint _shares, address _to, address _owner) external nonReentrant whenNotPaused checkAccess returns (uint) {
        return _withdraw(_shares, _to, _owner);
    }

    /**
     * @dev Performs a withdrawal from the pool.
     *
     * @param _shares The amount of shares to withdraw.
     * @param _to The address of the user to whom the withdrawal is made.
     *
     * @return The amount of assets withdrawn.
     */
    function withdraw(uint _shares, address _to) external nonReentrant whenNotPaused checkAccess returns (uint) {
        return _withdraw(_shares, _to, msg.sender);
    }

    /**
     * @dev Performs a withdrawal from the pool on behalf of the sender.
     *
     * @param _shares The amount of shares to withdraw.
    *
    * @return The amount of assets withdrawn.
     */
    function withdraw(uint _shares) external nonReentrant whenNotPaused checkAccess returns (uint) {
        return _withdraw(_shares, msg.sender, msg.sender);
    }

    /**
     * @dev Performs a total withdrawal from the pool.
     */
    function withdrawAll() external nonReentrant whenNotPaused checkAccess returns (uint) {
        return _withdraw(controller.balanceOf(msg.sender), msg.sender, msg.sender);
    }

    /**
     * @dev Returns the amount of collateral available for the given account.
     *
     * @param _account The address of the account.
     *
     * @return The amount of collateral available for the given account.
     */
    function availableCollateral(address _account) external view returns (uint) {
        return balanceOf(_account) * pricePerShare() * collateralRatio / MAX_COLLATERAL_RATIO / _precision();
    }

    /**
     * @dev Performs a liquidation of the given account.
     *
     * @param _account The address of the account to be liquidated.
     * @param _liquidityPool The address of the liquidity pool on which the liquidity should be restored.
     * @param _amount The amount of debt to be settled.
     */
    function liquidationCall(address _account, address _liquidityPool, uint _amount) external nonReentrant checkAccess {
        IOracle _oracle = IOracle(piGlobal.oracle());

        // Get the maximum amount of liquidable debt and its equivalent collateral
        // reverts if _liquidableCollateral or _liquidableDebt is 0
        (uint _liquidableCollateral, uint _liquidableDebt) = _oracle.getLiquidableAmounts(_account, _liquidityPool);


        uint _collateralToBeUsed = _liquidableCollateral;

        if (_amount >= _liquidableDebt) _amount = _liquidableDebt;
        else _collateralToBeUsed = _amount * _liquidableCollateral / _liquidableDebt;

        // Just in case
        if (_collateralToBeUsed > _liquidableCollateral) revert CantLiquidate("_amount uses too much collateral");
        if (_collateralToBeUsed == 0) revert CantLiquidate("Collateral unused");

        // Get HF before liquidation
        uint _hf = _oracle.healthFactor(_account);

        // withdraw from controller the collateral asset to be liquidated
        uint _withdrawn = controller.withdrawForLiquidation(_account, _collateralToBeUsed);

        // if withdrawn for anyreason is different than _collateralToBeUsed
        // we calculate the _amount based on the oracle liquidation ratio
        if (_withdrawn != _collateralToBeUsed) {
            _amount = _withdrawn * _liquidableDebt / _liquidableCollateral;
        }

        if (_amount > _liquidableDebt) revert CantLiquidate("_withdrawn > _liquidableDebt");

        // Transfer liquidable amount to liquidator
        asset.safeTransfer(msg.sender, _withdrawn);

        // Liquidator must repay
        ILPool(_liquidityPool).liquidate(msg.sender, _account, _amount);

        // Recheck HF after liquidation is not less than before
        if (_oracle.healthFactor(_account) <= _hf) revert CantLiquidate("HF is lower than before");

        emit LiquidationCall(msg.sender, _account, _withdrawn, _liquidityPool, _amount);
    }

    function _precision() internal view returns (uint) { return 10 ** decimals(); }

    function _deposit(uint _amount, address _onBehalfOf) internal {
        if (_amount == 0) revert Errors.ZeroAmount();

        // Get asset from sender
        asset.safeTransferFrom(msg.sender, address(this), _amount);
        // Deposit in controller
        asset.safeIncreaseAllowance(address(controller), _amount);
        uint _shares = controller.deposit(_onBehalfOf, _amount);

        emit Deposit(msg.sender, _onBehalfOf, _amount, _shares);
    }

    function _withdraw(uint _shares, address _to, address _owner) internal returns (uint) {
        if (_shares == 0) revert Errors.ZeroShares();

        (uint _withdrawn, uint _burnedShares) = controller.withdraw(msg.sender, _owner, _shares);
        if (_withdrawn == 0) revert NoFundsWithdrawn();

        asset.safeTransfer(_to, _withdrawn);

        // Can't withdraw with a HF lower than 1.0
        IOracle(piGlobal.oracle()).checkHealthy(_owner);

        emit Withdraw(msg.sender, _to, _owner, _withdrawn, _burnedShares);

        return _withdrawn;
    }

    /**
     * @dev Recovers the given ERC20 token from the treasury.
     *
     * @param _asset The address of the ERC20 token to recover.
     */
    function rescueFounds(IERC20Metadata _asset) external nonReentrant onlyAdmin {
        address _treasury = piGlobal.treasury();

        _asset.safeTransfer(_treasury, _asset.balanceOf(address(this)));
    }

    /**
     * @dev Pauses/Unpauses the pool.
     */
    function togglePause() external onlyPauser nonReentrant {
        paused() ? _unpause() : _pause();
    }

    /**
     * @dev Enables/Disables EOA only interactions.
     */
    function toggleOnlyEOA() external nonReentrant onlyAdmin {
        onlyEOA = !onlyEOA;
    }

    /**
     * @dev Enables/Disables the whitelist check.
     */
    function setWhitelistEnabled(bool _status) external onlyAdmin nonReentrant {
        if (whitelistEnabled == _status) revert Errors.SameValue();

        whitelistEnabled = _status;
    }

    /**
     * @dev Enables/Disables address whitelist.
     */
    function setWhitelisted(address _user, bool _status) external onlyAdmin nonReentrant {
        if (whitelisted[_user] == _status) revert Errors.SameValue();

        whitelisted[_user] = _status;
    }
}
