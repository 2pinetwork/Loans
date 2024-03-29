// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./PiAdmin.sol";
import "../interfaces/IChainLink.sol";
import "../interfaces/IPiGlobal.sol";
import "../interfaces/IPool.sol";
import "../libraries/Errors.sol";

/**
 * @title Oracle
 *
 * @dev Price oracle to be used by the protocol.
 */
contract Oracle is PiAdmin {
    mapping(address => IChainLink) public priceFeeds;

    // Price time toleration for price feed
    uint public priceTimeToleration;
    uint public constant MAX_PRICE_TIME_TOLERATION = 24 hours;
    // Precision constants to be use to convert to/from USD price
    uint public constant BASE_DECIMALS  = 18;
    uint public constant BASE_PRECISION = 1e18;

    // Liquidation
    // Max of 50% of the total collateral in debt
    uint public liquidationThreshold = 0.5e18;
    uint public liquidationExpectedHF = 0.6e18;
    uint public liquidationBonus = 0.01e18; // 1% bonus for liquidator
    uint public constant MAX_THRESHOLD = 1.0e18;
    uint public constant MIN_THRESHOLD = 0.20e18;
    uint public constant MAX_LIQUIDATION_BONUS = 0.20e18; // 20% is a huge bonus...
    uint public constant MIN_HEALTHY_HF = 1.0e18;

    IPiGlobal public immutable piGlobal;

    /**
     * @dev Throws if the health factor is below the minimum healthy health factor.
     */
    error LowHealthFactor();

    /**
     * @dev Throws when the price feed is not a valid one.
     */
    error InvalidFeed(address);

    /**
     * @dev Throws when the price time toleration exceeds the maximum allowed.
     */
    error MaxPriceTimeToleration();

    /**
     * @dev Throws when the price time exceeds the toleration.
     */
    error OldPrice();

    /**
     * @dev Throws when some liquidation function gets called and there is nothing to liquidate.
     */
    error NothingToLiquidate();

    /**
     * @dev Emitted when the price time toleration is updated.
     *
     * @param _old The old price time toleration.
     * @param _new The new price time toleration.
     */
    event NewPriceTimeToleration(uint _old, uint _new);

    /**
     * @dev Emitted when a new price feed is added.
     *
     * @param _token The token address.
     * @param _feed The price feed address.
     */
    event NewPriceFeed(address _token, address _feed);

    /**
     * @dev Emitted when the liquidation threshold is updated.
     *
     * @param _oldLT The old liquidation threshold.
     * @param _newLT The new liquidation threshold.
     * @param _oldLEHF The old liquidation expected health factor.
     * @param _newLEHF The new liquidation expected health factor.
     */
    event NewLiquidationThreshold(uint _oldLT, uint _newLT, uint _oldLEHF, uint _newLEHF);

    /**
     * @dev Emitted when the liquidation bonus is updated.
     *
     * @param _old The old liquidation bonus.
     * @param _new The new liquidation bonus.
     */
    event NewLiquidationBonus(uint _old, uint _new);

    /**
     * @dev Initializes the contract.
     *
     * @param _global The PiGlobal address.
     */
    constructor(IPiGlobal _global) {
        // at least check the contract
        _global.collateralPools();
        _global.liquidityPools();

        piGlobal = _global;
    }

    /**
     * @dev Sets the max price time offset toleration.
     *
     * @param _newPriceTimeToleration The new price time toleration.
     */
    function setPriceTimeToleration(uint _newPriceTimeToleration) external onlyAdmin nonReentrant {
        if (_newPriceTimeToleration > MAX_PRICE_TIME_TOLERATION) revert MaxPriceTimeToleration();
        if (priceTimeToleration == _newPriceTimeToleration) revert Errors.SameValue();

        emit NewPriceTimeToleration(priceTimeToleration, _newPriceTimeToleration);

        priceTimeToleration = _newPriceTimeToleration;
    }

    /**
     * @dev Sets the liquidation thresholds. The expected health factor should
     * be higher or equal to the liquidation threshold. The expected health
     * factor is the one that the protocol would target after a liquidation.
     *
     * @param _newLT The new liquidation threshold.
     * @param _newLEHF The new liquidation expected health factor.
     */
    function setLiquidationThreshold(uint _newLT, uint _newLEHF) external onlyAdmin nonReentrant {
        if (_newLT > MAX_THRESHOLD) revert Errors.GreaterThan("LT > MAX_THRESHOLD");
        if (_newLT < MIN_THRESHOLD) revert Errors.LessThan("LT < MIN_THRESHOLD");
        if (_newLEHF <= _newLT) revert Errors.LessThan("LExpectedHF < LT");
        if (_newLEHF > MAX_THRESHOLD) revert Errors.GreaterThan("LExpectedHF > MAX_THRESHOLD");
        if (_newLT == liquidationThreshold && _newLEHF == liquidationExpectedHF) revert Errors.SameValue();

        emit NewLiquidationThreshold(liquidationThreshold, _newLT, liquidationExpectedHF, _newLEHF);

        liquidationThreshold = _newLT;
        liquidationExpectedHF = _newLEHF;
    }

    /**
     * @dev Sets the liquidation bonus for liquidators.
     *
     * @param _newLB The new liquidation bonus.
     */
    function setLiquidationBonus(uint _newLB) external onlyAdmin nonReentrant {
        if (_newLB > MAX_LIQUIDATION_BONUS) revert Errors.GreaterThan("MAX_LIQUIDATION_BONUS");
        if (_newLB == liquidationBonus) revert Errors.SameValue();

        emit NewLiquidationBonus(liquidationBonus, _newLB);

        liquidationBonus = _newLB;
    }

    /**
     * @dev Adds a new price feed for a token.
     *
     * @param _token The token address.
     * @param _feed The price feed address.
     */
    function addPriceOracle(address _token, IChainLink _feed) external onlyAdmin nonReentrant {
        if (_token == address(0)) revert Errors.ZeroAddress();
        if (priceFeeds[_token] == _feed) revert Errors.SameValue();

        (uint80 _round, int _price,,,) = _feed.latestRoundData();
        if (_round == 0 || _price <= 0 || _feed.decimals() <= 6) revert InvalidFeed(_token);

        priceFeeds[_token] = _feed;

        emit NewPriceFeed(_token, address(_feed));
    }

    /**
     * @dev Returns the health factor for a given user.
     *
     * @param _account The user address.
     *
     * @return The health factor.
     */
    function healthFactor(address _account) external view returns (uint) {
        uint _borrowed = _borrowedInUSD(_account);

        return _healthFactor(_account, _borrowed);
    }

    /**
     * @dev Returns the available collateral for a given user on an specific asset.
     *
     * @param _account The user address.
     * @param _asset The asset address.
     *
     * @return _available The available collateral.
     */
    function availableCollateralForAsset(address _account, address _asset) external view returns (uint _available) {
        // Put available collateral in token quantity
        _available = _collateralInUSD(_account) * BASE_PRECISION / _normalizedPrice(_asset);

        // Put _available (in BASE_DECIMALS precision) in token precision
        _available = _fixPrecision(BASE_DECIMALS, IERC20Metadata(_asset).decimals(), _available);

        if (_available == 0) return 0;

        uint _borrowed = _borrowedInAsset(_account, _asset);

        (_available >= _borrowed) ? (_available -= _borrowed) : (_available = 0);
    }

    /**
     * @dev Returns the liquidable amount for a given user on an specific liquidity pool and the debt it would paid.
     *
     * @param _account The user address.
     * @param _liqPool The liquidity pool address.
     *
     * @return _liquidableCollateral The liquidable collateral amount.
     * @return _debtToBePaid The debt to be paid on asset units.
     */
    function getLiquidableAmounts(address _account, address _liqPool) external view returns (uint _liquidableCollateral, uint _debtToBePaid) {
        // First we check if the pool is expired and try to liquidate the whole debt
        // msg.sender (from) address should be a collateralPool
        ICPool _cPool = ICPool(msg.sender);
        ILPool _lPool = ILPool(_liqPool);

        uint _debt = _lPool.debt(_account);
        uint _collateral = _cPool.balanceOf(_account);

        if (_debt == 0 || _collateral == 0) revert NothingToLiquidate();

        uint _cPrice = _normalizedPrice(_cPool.asset());
        uint _lPrice = _normalizedPrice(_lPool.asset());

        // Get debt in USD
        uint _debtInUSD = _fixPrecision(_lPool.decimals(), BASE_DECIMALS, _debt) * _lPrice / BASE_PRECISION;

        // Entire collateral must always cover the liquidation bonus, so we consider the "available collateral"
        // as the collateral _less_ the bonus amount
        uint _collateralWithoutBonus = _collateral - (_collateral * liquidationBonus / BASE_PRECISION);
        uint _availableCollateralInUSD = _fixPrecision(_cPool.decimals(), BASE_DECIMALS, _collateralWithoutBonus) * _cPrice / BASE_PRECISION;

        // If the pool is expired, the liquidable amount is the entire debt
        if (_lPool.expired()) {
            // If collateral without bonus in USD is greater or equal to debt we liquidate the entire debt
            if (_availableCollateralInUSD >= _debtInUSD) _debtToBePaid = _debt;
            // in other case we convert the available collateral in USD to the debt tokens
            else _debtToBePaid = _availableCollateralInUSD * BASE_PRECISION / _lPrice;
         } else {
             // If the pool is not expired, then we check the liquidationFactor
            uint _totalDebtInUSD = _borrowedInUSD(_account);

            uint _hf = _healthFactor(_account, _totalDebtInUSD);

            // If the account is not liquidable, then revert
            if (_hf >= liquidationThreshold) revert NothingToLiquidate();

            // Get the expected HF with 10% more than liquidationThreshold
            uint _liquidableDebtInUSD = _totalDebtInUSD - (_totalDebtInUSD * _hf / liquidationExpectedHF);

            // If liquidableDebt is greater than available, only available will be liquidable...
            if (_liquidableDebtInUSD > _availableCollateralInUSD) _liquidableDebtInUSD = _availableCollateralInUSD;

            // If collateral without bonus in USD is greater or equal to debt we liquidate the entire debt
            if (_liquidableDebtInUSD >= _debtInUSD) _debtToBePaid = _debt;
              // in other case we convert the liquidable debt in USD to the debt tokens
            else _debtToBePaid = _liquidableDebtInUSD * BASE_PRECISION / _lPrice;
         }

         // _debtToBePaid is the debt tokens to be liquidated so we need to convert it to
         // collateral tokens via the prices
         _liquidableCollateral = _debtToBePaid * _lPrice / _cPrice;
         // have to add the liquidation bonus %
         _liquidableCollateral += Math.mulDiv(_liquidableCollateral, liquidationBonus, BASE_PRECISION, Math.Rounding.Up);
    }

    /**
     * @dev Health factor check, used to raise if it's lower than expected on liquidation and transfers.
     *
     * @param _account The user address.
     */
    function checkHealthy(address _account) external view {
        uint _borrowed = _borrowedInUSD(_account);

        if (_healthFactor(_account, _borrowed) < MIN_HEALTHY_HF) revert LowHealthFactor();
    }

    function _healthFactor(address _account, uint _borrowedInUsd) internal view returns (uint) {
        if (_borrowedInUsd == 0) return type(uint).max;

        return _collateralInUSD(_account) * BASE_PRECISION / _borrowedInUsd;
    }

    function _borrowedInAsset(address _account, address _asset) internal view returns (uint) {
        uint _assetPrice = _normalizedPrice(_asset);
        uint _assetDec   = IERC20Metadata(_asset).decimals();
        uint _borrowed   = _borrowedInUSD(_account) * _assetPrice / BASE_PRECISION;

        return _fixPrecision(BASE_DECIMALS, _assetDec, _borrowed);
    }

    function _normalizedPrice(address _asset) internal view returns (uint) {
        (
            uint80 _id,
            int _roundPrice,
            ,
            uint _timestamp,
            uint80 _answeredInRound
        ) =  priceFeeds[_asset].latestRoundData();
        if (_id < _answeredInRound) revert OldPrice();
        if (_timestamp < block.timestamp - priceTimeToleration) revert OldPrice();

        // ChainLink always returng 8 decimals
        // Represent price in 18 decimals precisions
        uint _offset = BASE_PRECISION / (10 ** priceFeeds[_asset].decimals());

        return uint(_roundPrice) * _offset;
    }

    function _fixPrecision(uint _dec, uint _assetDec, uint _amount) internal pure returns (uint) {
        if (_assetDec > _dec) return _amount * 10 ** (_assetDec - _dec);
        else                  return _amount / 10 ** (_dec - _assetDec);
    }

    function _borrowedInUSD(address _account) internal view returns (uint _amount) {
        address[] memory _lPools = piGlobal.liquidityPools();

        for (uint i = 0; i < _lPools.length; i++) {
            ILPool _pool = ILPool(_lPools[i]);
            uint _debt   = _pool.debt(_account);

            if (_debt == 0) continue;

            uint _price = _normalizedPrice(_pool.asset());

            if (_price == 0) revert InvalidFeed(_pool.asset());

            _amount += _fixPrecision(_pool.decimals(), BASE_DECIMALS, _debt) * _price / BASE_PRECISION;
        }
    }

    function _collateralInUSD(address _account) internal view returns (uint _availableInUSD) {
        address[] memory _cPools = piGlobal.collateralPools();

        for (uint i = 0; i < _cPools.length; i++) {
            ICPool _pool    = ICPool(_cPools[i]);
            uint _available = _pool.availableCollateral(_account);

            if (_available == 0) continue;

            uint _price = _normalizedPrice(_pool.asset());

            if (_price == 0) revert InvalidFeed(_pool.asset());

            // Collateral in USD in 18 decimals precision
            _availableInUSD += _fixPrecision(_pool.decimals(), BASE_DECIMALS, _available) * _price / BASE_PRECISION;
        }
    }
}
