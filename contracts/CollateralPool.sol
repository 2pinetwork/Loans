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
import "../interfaces/IGlobal.sol";
import {ILPool} from "../interfaces/IPool.sol";

contract CollateralPool is PiAdmin, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;
    IERC20Metadata public immutable asset;
    CToken public immutable cToken;

    IGlobal public piGlobal;

    // The percentage of collateral from this pool that can be used as
    // collateral for loans. 100% = 1e18
    uint public collateralRatio;
    uint public constant MAX_COLLATERAL_RATIO = 1e18;

    constructor(IERC20Metadata _asset) {
        asset = _asset;

        cToken = new CToken(asset);
    }

    error ZeroShares();
    error SameRatio();
    error MaxRatio();
    error ZeroAddress();
    error SameAddress();
    error CantLiquidate(string);

    event Deposit(address _sender, address _onBehalfOf, uint _amount, uint _shares);
    event Withdraw(address _sender, address _to, uint _amount, uint _shares);
    event NewCollateralRatio(uint _oldRatio, uint _newRatio);
    event NewPiGlobal(address _old, address _new);
    event LiquidationCall(address _liquidator, address _liquidated, uint _collateral, address _liquidityPool, uint _debt);

    function setCollateralRatio(uint _collateralRatio) external onlyAdmin {
        if (_collateralRatio == collateralRatio) revert SameRatio();
        if (_collateralRatio > MAX_COLLATERAL_RATIO) revert MaxRatio();

        emit NewCollateralRatio(_collateralRatio, collateralRatio);

        collateralRatio = _collateralRatio;
    }

    function setPiGlobal(IGlobal _piGlobal) external onlyAdmin nonReentrant {
        if (address(_piGlobal) == address(0)) revert ZeroAddress();
        if (_piGlobal == piGlobal) revert SameAddress();
        // just to check
        _piGlobal.collateralPools();
        _piGlobal.liquidityPools();

        emit NewPiGlobal(address(_piGlobal), address(piGlobal));

        piGlobal = IGlobal(_piGlobal);
    }

    function decimals() public view returns (uint8) {
        return asset.decimals();
    }

    function balanceOf(address _account) public view returns (uint) {
        return cToken.balanceOf(_account);
    }

    function getPricePerFullShare() public view returns (uint) {
        return (10 ** decimals());
    }

    function deposit(uint256 _amount, address _onBehalfOf) external nonReentrant  whenNotPaused {
        _deposit(_amount, _onBehalfOf);
    }

    function deposit(uint256 _amount) external nonReentrant  whenNotPaused {
        _deposit(_amount, msg.sender);
    }

    function _deposit(uint _amount, address _onBehalfOf) internal {
        uint256 _before = balance();

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

    /**
        * @dev Withdraws an `amount` of underlying asset from the reserve, burning the equivalent aTokens owned
    * E.g. User has 100 aUSDC, calls withdraw() and receives 100 USDC, burning the 100 aUSDC
    * @param _shares The shares to be withdrawn
    *   - Send the value type(uint256).max in order to withdraw the whole aToken balance
    * @param _to Address that will receive the underlying, same as msg.sender if the user
        *   wants to receive it on his own wallet, or a different address if the beneficiary is a
            *   different wallet
    * @return The final amount withdrawn
    **/
    function withdraw(
        uint256 _shares,
        address _to
    ) external nonReentrant whenNotPaused returns (uint256) {
        return _withdraw(_shares, _to);
    }

    function withdraw(uint256 _shares) external nonReentrant whenNotPaused returns (uint256) {
        return _withdraw(_shares, msg.sender);
    }

    function withdrawAll() external nonReentrant whenNotPaused returns (uint256) {
        return _withdraw(cToken.balanceOf(msg.sender), msg.sender);
    }

    function _withdraw(uint256 _shares, address _to) internal returns (uint256) {
        if (_shares <= 0) revert ZeroShares();

        uint _amount = (balance() * _shares) / cToken.totalSupply();

        cToken.burn(msg.sender, _shares);

        asset.safeTransfer(_to, _amount);

        emit Withdraw(msg.sender, _to, _amount, _shares);

        return _amount;
    }

    function balance() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function availableCollateral(address _account) public view returns (uint) {
        return balanceOf(_account) * getPricePerFullShare() * collateralRatio / MAX_COLLATERAL_RATIO / (10 ** decimals());
    }

    function fullCollateral(address _account) public view returns (uint) {
        return balanceOf(_account) * getPricePerFullShare() / (10 ** decimals());
    }

    // _account is the wallet to be liquidated
    // _liquidityPool is the pool with the debt to be paid
    // _amount is the debt (liquidityPool) amount to be liquidated
    function liquidationCall(address _account, address _liquidityPool, uint _amount) public nonReentrant {
        IOracle _oracle = IOracle(piGlobal.oracle());

        (uint _liquidableCollateral, uint _liquidableDebt) = _oracle.getLiquidableAmounts(_account, _liquidityPool);

        // console.log("[C] LiquidableCol:", _liquidableCollateral, "LiqDebt:", _liquidableDebt);

        if (_liquidableCollateral <= 0 || _liquidableDebt <= 0) revert CantLiquidate("No liquidable amount");

        uint _collateralToBeUsed = _liquidableCollateral;

        if (_amount >= _liquidableDebt) _amount = _liquidableDebt;
        // regla de 3 simple para obtener la cantidad de tokens a liquidar
        else _collateralToBeUsed = _amount * _liquidableCollateral / _liquidableDebt;
        // console.log("Collat: ", _collateralToBeUsed, "DebtToPay:", _amount);

        // JiC...
        if (_collateralToBeUsed > _liquidableCollateral) revert CantLiquidate("_amount use too much collateral");

        (uint _hf, ) = _oracle.healthFactor(_account);

        // Get the burnable amount of tokens
        uint _shares = _collateralToBeUsed * cToken.totalSupply() / balance();

        // Burn liquidated account tokens
        cToken.burn(_account, _shares);
        // Transfer liquidable amount to liquidator
        asset.safeTransfer(msg.sender, _collateralToBeUsed);

        // Liquidator must repay
        ILPool(_liquidityPool).liquidate(msg.sender, _account, _amount);

        (uint _newHf, ) = _oracle.healthFactor(_account);

        if (_newHf <= _hf) revert CantLiquidate("HF is lower than before");

        emit LiquidationCall(msg.sender, _account, _collateralToBeUsed, _liquidityPool, _amount);
    }
}
