// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "hardhat/console.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import  "./PiAdmin.sol";
import {CToken} from "./CToken.sol";

import "../interfaces/IOracle.sol";
import "../interfaces/IPiGlobal.sol";
import {ILPool} from "../interfaces/IPool.sol";

contract CollateralPool is PiAdmin, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;
    IERC20Metadata public immutable asset;
    CToken public immutable cToken;

    IPiGlobal public immutable piGlobal;

    // The percentage of collateral from this pool that can be used as
    // collateral for loans. 100% = 1e18
    uint public collateralRatio;
    uint public constant MAX_COLLATERAL_RATIO = 1e18;
    // Minimum HF for withdraws
    uint public constant MIN_HF_FOR_WITHDRAW = 1e18;

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
        piGlobal = IPiGlobal(_piGlobal);

        // Deploy collateral shares-token
        cToken = new CToken(asset);
    }

    error CantLiquidate(string);
    error GreaterThan(string);
    error SameValue();
    error ZeroAddress();
    error ZeroShares();
    error LowHealthFactor();

    event Deposit(address _sender, address _onBehalfOf, uint _amount, uint _shares);
    event Withdraw(address _sender, address _to, uint _amount, uint _shares);
    event NewCollateralRatio(uint _oldRatio, uint _newRatio);
    event LiquidationCall(address _liquidator, address _liquidated, uint _collateral, address _liquidityPool, uint _debt);

    function setCollateralRatio(uint _collateralRatio) external onlyAdmin {
        if (_collateralRatio == collateralRatio) revert SameValue();
        if (_collateralRatio > MAX_COLLATERAL_RATIO) revert GreaterThan('MAX_COLLATERAL_RATIO');

        emit NewCollateralRatio(_collateralRatio, collateralRatio);

        collateralRatio = _collateralRatio;
    }

    function decimals() public view returns (uint8) {
        return asset.decimals();
    }

    function balanceOf(address _account) public view returns (uint) {
        return cToken.balanceOf(_account);
    }

    function balance() public view returns (uint) {
        return asset.balanceOf(address(this));
    }

    // TMP: Will be calculated when collateral could be deposited in other strategy
    function getPricePerFullShare() public view returns (uint) {
        return _precision();
    }

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
        return _withdraw(cToken.balanceOf(msg.sender), msg.sender);
    }

    function availableCollateral(address _account) external view returns (uint) {
        return balanceOf(_account) * getPricePerFullShare() * collateralRatio / MAX_COLLATERAL_RATIO / _precision();
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

        // Get the burnable amount of tokens
        uint _shares = _collateralToBeUsed * cToken.totalSupply() / balance();

        // Burn liquidated account tokens
        cToken.burn(_account, _shares);
        // Transfer liquidable amount to liquidator
        asset.safeTransfer(msg.sender, _collateralToBeUsed);

        // Liquidator must repay
        ILPool(_liquidityPool).liquidate(msg.sender, _account, _amount);

        // Recheck HF after liquidation is not less than before
        if (_oracle.healthFactor(_account) <= _hf) revert CantLiquidate("HF is lower than before");

        emit LiquidationCall(msg.sender, _account, _collateralToBeUsed, _liquidityPool, _amount);
    }

    function _precision() internal view returns (uint) {
        return 10 ** decimals();
    }

    function _deposit(uint _amount, address _onBehalfOf) internal {
        uint _before = balance();

        asset.safeTransferFrom(msg.sender, address(this), _amount);

        // SaveGas
        uint _supply = cToken.totalSupply();
        uint _shares;

        if (_supply <= 0) {
            _shares = _amount;
        } else {
            _shares = (_amount * _supply) / _before;
        }

        if (_shares <= 0) revert ZeroShares();

        cToken.mint(_onBehalfOf, _shares);

        emit Deposit(msg.sender, _onBehalfOf, _amount, _shares);
    }

    function _withdraw(uint _shares, address _to) internal returns (uint) {
        if (_shares <= 0) revert ZeroShares();

        uint _amount = (balance() * _shares) / cToken.totalSupply();

        cToken.burn(msg.sender, _shares);

        asset.safeTransfer(_to, _amount);

        IOracle _oracle = IOracle(piGlobal.oracle());

        // Can't withdraw with a HF lower than 1.0
        if (_oracle.healthFactor(msg.sender) <= MIN_HF_FOR_WITHDRAW) revert LowHealthFactor();

        emit Withdraw(msg.sender, _to, _amount, _shares);

        return _amount;
    }
}
