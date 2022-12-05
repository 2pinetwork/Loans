// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./PiAdmin.sol";
import "../interfaces/IChainLink.sol";
import "../interfaces/IGlobal.sol";
import "../interfaces/IPool.sol";

contract Oracle is PiAdmin {
    mapping(address => IChainLink) public priceFeeds;

    // Time toleration for price feed
    uint public toleration;
    uint public constant MAX_TOLERATION = 24 hours;
    uint public constant BASE_PRECISION = 1e18;

    IGlobal public immutable piGlobal;

    error InvalidFeed(address);
    error MaxToleration();
    error OldPrice();
    error SameFeed();
    error SameToleration();
    error ZeroAddress();

    constructor(IGlobal _global) {
        // at least check the contract
        _global.collateralPools();
        _global.liquidityPools();

        piGlobal = _global;
    }

    event NewToleration(uint _old, uint _new);
    event NewPriceFeed(address _token, address _feed);

    function setToleration(uint _newToleration) external onlyAdmin {
        if (_newToleration > MAX_TOLERATION) revert MaxToleration();
        if (toleration == _newToleration) revert SameToleration();

        emit NewToleration(toleration, _newToleration);

        toleration = _newToleration;
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
            _available += _fromPoolPrecision(_pool, _assetDec, _bal) * _price / _assetPrice;
        }

        if (_available <= 0) return _available;

        uint _borrowed = _borrowedInAsset(_account, _asset);

        (_available > _borrowed) ? (_available -= _borrowed) : (_available = 0);
    }

    function _borrowedInAsset(address _account, address _asset) internal view returns (uint _borrowed) {
        address[] memory _pools = piGlobal.liquidityPools();

        uint _assetPrice = _normalizedPrice(_asset);
        uint _assetDec   = IERC20Metadata(_asset).decimals();

        if (_assetPrice <= 0) revert InvalidFeed(_asset);

        for (uint i = 0; i < _pools.length; i++) {
            IPool _pool = IPool(_pools[i]);
            uint _debt  = _pool.debt(_account);

            if (_debt <= 0) continue;

            uint _price = _normalizedPrice(_pool.asset());

            if (_price <= 0) revert InvalidFeed(_pool.asset());

            // Return balance in the _asset precision
            _borrowed += _fromPoolPrecision(_pool, _assetDec, _debt) * _price / _assetPrice;
        }
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

    function _fromPoolPrecision(IPool _pool, uint _assetDec, uint _amount) internal view returns (uint) {
        uint _poolDec = _pool.decimals();

        if (_assetDec > _poolDec) return _amount * 10 ** (_assetDec - _poolDec);
        else                      return _amount / 10 ** (_poolDec - _assetDec);
    }

}
