// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "hardhat/console.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import  "./PiAdmin.sol";
import {Controller} from "./Controller.sol";

import "../interfaces/IOracle.sol";
import "../interfaces/IPiGlobal.sol";
import {ILPool} from "../interfaces/IPool.sol";

interface IController {
    function pool() external view returns (address);
    function decimals() external view returns (uint8);
    function pricePerShare() external view returns (uint);
    function piGlobal() external view returns (address);
    function asset() external view returns (address);
    function balanceOf(address _account) external view returns (uint);
    function balance() external view returns (uint);
    function totalSupply() external view returns (uint);
    function deposit(address _onBehalfOf, uint _amount) external returns (uint);
    function withdraw(address _to, uint _shares) external returns (uint);
    function withdrawForLiquidation(address _liquidated, uint _shares) external returns (uint);
}

contract CollateralPool is PiAdmin, Pausable, ReentrancyGuard {
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

    error CantLiquidate(string);
    error GreaterThan(string);
    error MaxRatio();
    error SameAddress();
    error SameRatio();
    error SameValue();
    error ZeroAddress();
    error ZeroShares();
    error InvalidController();
    error AlreadyInitialized();

    constructor(IPiGlobal _piGlobal, IERC20Metadata _asset) {
        if (address(_piGlobal) == address(0)) revert ZeroAddress();

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

    event Deposit(address _sender, address _onBehalfOf, uint _amount, uint _shares);
    event Withdraw(address _sender, address _to, uint _amount, uint _shares);
    event NewCollateralRatio(uint _oldRatio, uint _newRatio);
    event LiquidationCall(address _liquidator, address _liquidated, uint _collateral, address _liquidityPool, uint _debt);
    event ControllerSet(address _controller);

    function setController(IController _controller) external onlyAdmin {
        if (address(_controller) == address(0)) revert ZeroAddress();
        if (address(controller) != address(0)) revert AlreadyInitialized();

        if (_controller.pool() != address(this)) revert InvalidController();
        if (_controller.piGlobal() != address(piGlobal)) revert InvalidController();
        if (_controller.asset() != address(asset)) revert InvalidController();

        emit ControllerSet(address(_controller));

        controller = _controller;
    }

    function setCollateralRatio(uint _collateralRatio) external onlyAdmin {
        if (_collateralRatio == collateralRatio) revert SameValue();
        if (_collateralRatio > MAX_COLLATERAL_RATIO) revert GreaterThan("MAX_COLLATERAL_RATIO");

        emit NewCollateralRatio(_collateralRatio, collateralRatio);

        collateralRatio = _collateralRatio;
    }

    function balanceOf(address _account) public view returns (uint) {
        return controller.balanceOf(_account);
    }

    function balance() public view returns (uint) { return controller.balance(); }
    function decimals() public view returns (uint8) { return controller.decimals(); }
    function pricePerShare() public view returns (uint) { return controller.pricePerShare(); }

    function deposit(uint _amount, address _onBehalfOf) external nonReentrant whenNotPaused {
        _deposit(_amount, _onBehalfOf);
    }

    function deposit(uint _amount) external nonReentrant whenNotPaused {
        _deposit(_amount, msg.sender);
    }

    function withdraw(uint _shares, address _to) external nonReentrant whenNotPaused returns (uint) {
        return _withdraw(_shares, _to);
    }

    function withdraw(uint _shares) external nonReentrant whenNotPaused returns (uint) {
        return _withdraw(_shares, msg.sender);
    }

    function withdrawAll() external nonReentrant whenNotPaused returns (uint) {
        return _withdraw(controller.balanceOf(msg.sender), msg.sender);
    }

    function availableCollateral(address _account) external view returns (uint) {
        return balanceOf(_account) * pricePerShare() * collateralRatio / MAX_COLLATERAL_RATIO / _precision();
    }

    // _account is the wallet to be liquidated
    // _liquidityPool is the pool with the debt to be paid
    // _amount is the debt (liquidityPool) amount to be liquidated
    function liquidationCall(address _account, address _liquidityPool, uint _amount) external nonReentrant {
        IOracle _oracle = IOracle(piGlobal.oracle());

        // Get the maximum amount of liquidable debt and its equivalent collateral
        (uint _liquidableCollateral, uint _liquidableDebt) = _oracle.getLiquidableAmounts(_account, _liquidityPool);

        if (_liquidableCollateral <= 0 || _liquidableDebt <= 0) revert CantLiquidate("No liquidable amount");

        uint _collateralToBeUsed = _liquidableCollateral;

        if (_amount >= _liquidableDebt) _amount = _liquidableDebt;
        else _collateralToBeUsed = _amount * _liquidableCollateral / _liquidableDebt;

        // Just in case
        if (_collateralToBeUsed > _liquidableCollateral) revert CantLiquidate("_amount uses too much collateral");
        if (_collateralToBeUsed <= 0) revert CantLiquidate("Collateral unused");

        // Get HF before liquidation
        uint _hf = _oracle.healthFactor(_account);

        // withdraw from controller the collateral asset to be liquidated
        uint _withdrawn = controller.withdrawForLiquidation(_account, _collateralToBeUsed);

        // if withdrawn for anyreason is different than _collateralToBeUsed
        // we calculate the _amount based on the oracle liquidation ratio
        if (_withdrawn != _collateralToBeUsed)
            _amount = _withdrawn * _liquidableDebt / _liquidableCollateral;

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
        // Get asset from sender
        asset.safeTransferFrom(msg.sender, address(this), _amount);
        // Deposit in controller
        asset.safeIncreaseAllowance(address(controller), _amount);
        uint _shares = controller.deposit(_onBehalfOf, _amount);

        emit Deposit(msg.sender, _onBehalfOf, _amount, _shares);
    }

    function _withdraw(uint _shares, address _to) internal returns (uint) {
        if (_shares <= 0) revert ZeroShares();

        uint _withdrawn = controller.withdraw(msg.sender, _shares);
        require(_withdrawn > 0, "No funds withdrawn");

        asset.safeTransfer(_to, _withdrawn);

        // Can't withdraw with a HF lower than 1.0
        IOracle(piGlobal.oracle()).checkHealthy(msg.sender);

        emit Withdraw(msg.sender, _to, _withdrawn, _shares);

        return _withdrawn;
    }

    // In case somebody send tokens to this contract directly
    // we can recover them from the treasury
    function fun() external nonReentrant whenNotPaused {
        // change this for piGlobal.treasury()
        _deposit(asset.balanceOf(address(this)), msg.sender);
    }
}
