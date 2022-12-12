// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

// import "hardhat/console.sol";
import "./PiAdmin.sol";
import "../interfaces/IChainLink.sol";
import "../interfaces/IGlobal.sol";
import "../interfaces/IPool.sol";

contract Oracle is PiAdmin {
    mapping(address => IChainLink) public priceFeeds;

    // Time toleration for price feed
    uint public toleration;
    uint public constant MAX_TOLERATION = 24 hours;
    uint public constant BASE_DECIMALS  = 18;
    uint public constant BASE_PRECISION = 1e18;

    // Max of 50% of the total collateral in debt
    uint public liquidationThreshold = 0.5e18;
    uint public constant MAX_THREASHOLD = 0.95e18; // at least 5% to reward the liquidator
    uint public constant MIN_THREASHOLD = 0.20e18;

    IGlobal public immutable piGlobal;

    error InvalidFeed(address);
    error MaxToleration();
    error OldPrice();
    error SameFeed();
    error SameToleration();
    error ZeroAddress();
    error GreaterThan(string);
    error LessThan(string);

    constructor(IGlobal _global) {
        // at least check the contract
        _global.collateralPools();
        _global.liquidityPools();

        piGlobal = _global;
    }

    event NewToleration(uint _old, uint _new);
    event NewPriceFeed(address _token, address _feed);
    event NewLiquidationThreshold(uint _old, uint _new);

    function setToleration(uint _newToleration) external onlyAdmin {
        if (_newToleration > MAX_TOLERATION) revert MaxToleration();
        if (toleration == _newToleration) revert SameToleration();

        emit NewToleration(toleration, _newToleration);

        toleration = _newToleration;
    }

    function setLiquidationThreshold(uint _newLT) external onlyAdmin {
        if (_newLT > MAX_THREASHOLD) revert GreaterThan('MAX_THREASHOLD');
        if (_newLT < MIN_THREASHOLD) revert LessThan('MIN_THREASHOLD');

        emit NewLiquidationThreshold(liquidationThreshold, _newLT);

        liquidationThreshold = _newLT;
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
        uint _borrowed = _borrowedInUsd(_account);

        if (_borrowed <= 0) return (type(uint).max, type(uint).max);

        (uint _available, uint _total) = _collateralInUsd(_account);

        _hf = _available * BASE_PRECISION / _borrowed;
        _lf = _total * liquidationThreshold / _borrowed;
    }

    function availableCollateralForAsset(address _account, address _asset) external view returns (uint _available) {
        address[] memory _pools = piGlobal.collateralPools();

        uint _assetPrice = _normalizedPrice(_asset);
        uint _assetDec   = IERC20Metadata(_asset).decimals();

        if (_assetPrice <= 0) revert InvalidFeed(_asset);

        for (uint i = 0; i < _pools.length; i++) {
            IPool _pool = IPool(_pools[i]);
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

        (_available > _borrowed) ? (_available -= _borrowed) : (_available = 0);
    }

    function _borrowedInAsset(address _account, address _asset) internal view returns (uint) {
        uint _assetPrice = _normalizedPrice(_asset);
        uint _assetDec   = IERC20Metadata(_asset).decimals();
        uint _borrowed   = _borrowedInUsd(_account) * _assetPrice / BASE_PRECISION;

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
        if (_timestamp + toleration < block.timestamp) revert OldPrice();

        // ChainLink always returng 8 decimals
        // Represent price in 18 decimals precisions
        uint _offset = BASE_PRECISION / (10 ** priceFeeds[_asset].decimals());

        return uint(_roundPrice) * _offset;
    }

    function _fixPrecision(uint _dec, uint _assetDec, uint _amount) internal pure returns (uint) {
        if (_assetDec > _dec) return _amount * 10 ** (_assetDec - _dec);
        else                  return _amount / 10 ** (_dec - _assetDec);
    }

    function _borrowedInUsd(address _account) internal view returns (uint _amount) {
        address[] memory _lPools = piGlobal.liquidityPools();

        for (uint i = 0; i < _lPools.length; i++) {
            IPool _pool = IPool(_lPools[i]);
            uint _price = _normalizedPrice(_pool.asset());

            if (_price <= 0) revert InvalidFeed(_pool.asset());

            uint _debt  = _pool.debt(_account);

            _amount += _fixPrecision(_pool.decimals(), BASE_DECIMALS, _debt) * _price / BASE_PRECISION;
        }
    }

    function _collateralInUsd(address _account) internal view returns (uint _availableInUsd, uint _totalInUsd) {
        address[] memory _cPools = piGlobal.collateralPools();

        for (uint i = 0; i < _cPools.length; i++) {
            IPool _pool = IPool(_cPools[i]);
            uint _price = _normalizedPrice(_pool.asset());

            if (_price <= 0) revert InvalidFeed(_pool.asset());

            uint _available = _pool.availableCollateral(_account);
            uint _bal       = _pool.fullCollateral(_account);

            if (_bal <= 0 && _available <= 0) continue;

            // Collateral in USD in 18 decimals precision
            _availableInUsd += _fixPrecision(_pool.decimals(), BASE_DECIMALS, _available) * _price / BASE_PRECISION;
            _totalInUsd += _fixPrecision(_pool.decimals(), BASE_DECIMALS, _bal) * _price / BASE_PRECISION;
        }
    }
}
