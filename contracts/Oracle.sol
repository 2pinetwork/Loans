// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "hardhat/console.sol";
import "./PiAdmin.sol";
import "../interfaces/IChainLink.sol";
import "../interfaces/IGlobal.sol";
import "../interfaces/IPool.sol";

contract Oracle is PiAdmin {
    mapping(address => IChainLink) public priceFeeds;

    // Price time toleration for price feed
    uint public priceTimeToleration;
    uint public constant MAX_PRICE_TIME_TOLERATION = 24 hours;
    uint public constant BASE_DECIMALS  = 18;
    uint public constant BASE_PRECISION = 1e18;

    // Max of 50% of the total collateral in debt
    uint public liquidationThreshold = 0.5e18;
    uint public liquidationExpectedHF = 0.6e18;
    uint public liquidationBonus = 0.01e18; // 1% bonus for liquidator
    uint public constant MAX_THREASHOLD = 1.0e18;
    uint public constant MIN_THREASHOLD = 0.20e18;
    uint public constant MAX_LIQUIDATION_BONUS = 0.20e18; // 20% is a huge bonus...

    IGlobal public immutable piGlobal;

    error NotValidPool();
    error InvalidFeed(address);
    error MaxPriceTimeToleration();
    error OldPrice();
    error SameFeed();
    error SamePriceTimeToleration();
    error ZeroAddress();
    error GreaterThan(string);
    error LessThan(string);
    error NothingToLiquidate();

    constructor(IGlobal _global) {
        // at least check the contract
        _global.collateralPools();
        _global.liquidityPools();

        piGlobal = _global;
    }

    event NewPriceTimeToleration(uint _old, uint _new);
    event NewPriceFeed(address _token, address _feed);
    event NewLiquidationThreshold(uint _oldLT, uint _newLT, uint _oldLEHF, uint _newLEHF);
    event NewLiquidationBonus(uint _old, uint _new);

    function setPriceTimeToleration(uint _newPriceTimeToleration) external onlyAdmin {
        if (_newPriceTimeToleration > MAX_PRICE_TIME_TOLERATION) revert MaxPriceTimeToleration();
        if (priceTimeToleration == _newPriceTimeToleration) revert SamePriceTimeToleration();

        emit NewPriceTimeToleration(priceTimeToleration, _newPriceTimeToleration);

        priceTimeToleration = _newPriceTimeToleration;
    }

    function setLiquidationThreshold(uint _newLT, uint _newLEHF) external onlyAdmin {
        if (_newLT > MAX_THREASHOLD) revert GreaterThan('LT > MAX_THREASHOLD');
        if (_newLT < MIN_THREASHOLD) revert LessThan('LT < MIN_THREASHOLD');
        if (_newLEHF <= _newLT) revert LessThan('LExpectedHF < LT');
        if (_newLEHF > MAX_THREASHOLD) revert GreaterThan('LExpectedHF > MAX_THREASHOLD');

        emit NewLiquidationThreshold(liquidationThreshold, _newLT, liquidationExpectedHF, _newLEHF);

        liquidationThreshold = _newLT;
        liquidationExpectedHF = _newLEHF;
    }

    function setLiquidationBonus(uint _newLB) external onlyAdmin {
        if (_newLB > MAX_LIQUIDATION_BONUS) revert GreaterThan('MAX_LIQUIDATION_BONUS');

        emit NewLiquidationBonus(liquidationBonus, _newLB);

        liquidationBonus = _newLB;
    }

    function addPriceOracle(address _token, IChainLink _feed) external onlyAdmin {
        if (_token == address(0)) revert ZeroAddress();
        if (priceFeeds[_token] == _feed) revert SameFeed();

        (uint80 round, int price,,,) = _feed.latestRoundData();
        if (round <= 0 || price <= 0) revert InvalidFeed(_token);

        if (_feed.decimals() <= 6) revert InvalidFeed(_token);

        priceFeeds[_token] = _feed;

        emit NewPriceFeed(_token, address(_feed));
    }

    // HF, liquidation Threadhold
    function healthFactor(address _account) public view returns (uint _hf, uint _lf) {
        uint _borrowed = _borrowedInUSD(_account);

        return _healthFactor(_account, _borrowed);
    }

    function _healthFactor(address _account, uint _borrowed) internal view returns (uint _hf, uint _lf) {
        if (_borrowed <= 0) return (type(uint).max, type(uint).max);

        (uint _available, uint _total) = _collateralInUSD(_account);
        // console.log("Coll:", _total, "Borr:", _borrowed);

        _hf = _available * BASE_PRECISION / _borrowed;
        _lf = _total * liquidationThreshold / _borrowed;
    }

    // TODO: Refactor with _borrowed and _collateral methods
    function availableCollateralForAsset(address _account, address _asset) external view returns (uint _available) {
        address[] memory _pools = piGlobal.collateralPools();

        uint _assetPrice = _normalizedPrice(_asset);
        uint _assetDec   = IERC20Metadata(_asset).decimals();

        if (_assetPrice <= 0) revert InvalidFeed(_asset);

        for (uint i = 0; i < _pools.length; i++) {
            ICPool _pool = ICPool(_pools[i]);
            uint _price = _normalizedPrice(_pool.asset());

            if (_price <= 0) revert InvalidFeed(_pool.asset());

            // Get current available collateral for the pool
            uint _bal = _pool.availableCollateral(_account);

            if (_bal <= 0) continue;

            // Return balance in the _asset precision
            _available += _fixPrecision(_pool.decimals(), _assetDec, _bal) * _price / _assetPrice;
        }

        if (_available <= 0) return _available;

        uint _borrowed = _borrowedInAsset(_account, _asset);

        (_available >= _borrowed) ? (_available -= _borrowed) : (_available = 0);
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
            uint _price = _normalizedPrice(_pool.asset());

            if (_price <= 0) revert InvalidFeed(_pool.asset());

            uint _debt  = _pool.debt(_account);

            _amount += _fixPrecision(_pool.decimals(), BASE_DECIMALS, _debt) * _price / BASE_PRECISION;
        }
    }

    function _collateralInUSD(address _account) internal view returns (uint _availableInUSD, uint _totalInUSD) {
        address[] memory _cPools = piGlobal.collateralPools();

        for (uint i = 0; i < _cPools.length; i++) {
            ICPool _pool = ICPool(_cPools[i]);
            uint _price = _normalizedPrice(_pool.asset());

            if (_price <= 0) revert InvalidFeed(_pool.asset());

            uint _available = _pool.availableCollateral(_account);
            uint _bal       = _pool.fullCollateral(_account);

            if (_bal <= 0 && _available <= 0) continue;

            // Collateral in USD in 18 decimals precision
            _availableInUSD += _fixPrecision(_pool.decimals(), BASE_DECIMALS, _available) * _price / BASE_PRECISION;
            _totalInUSD += _fixPrecision(_pool.decimals(), BASE_DECIMALS, _bal) * _price / BASE_PRECISION;
        }
    }

    // Return values are liquidableAmount(collateral asset) and debtToBePaid(debt asset)
    function getLiquidableAmounts(address _account, address _liqPool) external view returns (uint _liquidableCollateral, uint _debtToBePaid) {
        // First we check if the pool is expired and try to liquidate the whole debt
        // msg.sender (from) address should be a collateralPool
        ICPool _cPool = ICPool(msg.sender);
        ILPool _lPool = ILPool(_liqPool);

        uint _debt = _lPool.debt(_account);
        uint _collateral = _cPool.balanceOf(_account);

        if (_debt <= 0 || _collateral <= 0) revert NothingToLiquidate();

        uint _cPrice = _normalizedPrice(_cPool.asset());
        uint _lPrice = _normalizedPrice(_lPool.asset());

        // Get debt in USD
        uint _debtInUSD = _fixPrecision(_lPool.decimals(), BASE_DECIMALS, _debt) * _lPrice / BASE_PRECISION;

        // Entire collateral must always cover the liquidation bonus, so we consider the "available collateral"
        // as the collateral _less_ the bonus amount
        uint _collateralWithBonus = _collateral - (_collateral * liquidationBonus / BASE_PRECISION);
        uint _availableCollateralInUSD = _fixPrecision(_cPool.decimals(), BASE_DECIMALS, _collateralWithBonus) * _cPrice / BASE_PRECISION;

        console.log("DebtInUSD:", _debtInUSD);
        console.log("availableInUSD:", _availableCollateralInUSD);

        // If the pool is expired, the liquidable amount is the entire debt
        if (_lPool.expired()) {
            // If collateral without bonus in USD is greater or equal to debt we liquidate the entire debt
            if (_availableCollateralInUSD >= _debtInUSD) _debtToBePaid = _debt;
            // in other case we convert the available collateral in USD to the debt tokens
            else _debtToBePaid = _availableCollateralInUSD * BASE_PRECISION / _lPrice;

            console.log("[C Oracle] Debt: ", _debt, "Debt To be paid:", _debtToBePaid);
         } else {
             // If the pool is not expired, then we check the liquidationFactor
            uint _totalDebtInUSD = _borrowedInUSD(_account);
            console.log("totalDebtInUSD:", _totalDebtInUSD);

            (uint _hf, ) = _healthFactor(_account, _totalDebtInUSD);

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
         _liquidableCollateral += _liquidableCollateral * liquidationBonus / BASE_PRECISION;
    }
}
