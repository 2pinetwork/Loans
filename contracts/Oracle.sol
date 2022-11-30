// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./PiAdmin.sol";
import "../interfaces/IGlobal.sol";

interface IPool {
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
    function getPricePerFullShare() external view returns (uint);
    function balanceOf(address) external view returns (uint);
    function balance() external view returns (uint);
}

interface IChainLink {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
    // function aggregator() external view returns (address);
}

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

    // // function availableCollateral(address _account) external view returns (uint _available) {
    // //     address[] memory _pools = piGlobal.collateralPools();

    // //     for (uint i = 0; i < _pools.length; i++) {
    // //         IPool _pool = IPool(_pools[i]);
    // //         uint _price = _normalizedPrice(_pool.asset());
    // //         uint _poolPrecision = 10 ** _pool.decimals();
    // //         uint _offset = BASE_PRECISION / _poolPrecision;

    // //         uint _bal = (
    // //             // shares balance
    // //             _pool.balanceOf(_account) *
    // //             // Keep everything with 18 decimals at price level
    // //             _offset *
    // //             // Price per share
    // //             _pool.getPricePerFullShare() /
    // //             // Share precision
    // //             _poolPrecision
    // //         );

    // //         // Price is on 1e18 precision
    // //         _available += (_bal * _price / BASE_PRECISION);
    // //     }
    // // }

    function availableCollateralForAsset(address _account, address _asset) external view returns (uint _available) {

        address[] memory _pools = piGlobal.collateralPools();

        uint _assetPrice = _normalizedPrice(_asset);

        if (_assetPrice <= 0) revert InvalidFeed(_asset);

        for (uint i = 0; i < _pools.length; i++) {
            IPool _pool = IPool(_pools[i]);
            uint _price = _normalizedPrice(_pool.asset());

            if (_price <= 0) revert InvalidFeed(_pool.asset());

            uint _poolPrecision = 10 ** _pool.decimals();
            uint _offset = BASE_PRECISION / _poolPrecision;

            uint _bal = (
                // shares balance
                _pool.balanceOf(_account) *
                // Keep everything with 18 decimals at price level
                _offset *
                // Price per share
                _pool.getPricePerFullShare() /
                // Share precision
                _poolPrecision
            );

            _available += (_bal * _price / _assetPrice);
        }
    }

    // // function availableLiquidity() external view returns (uint _available) {
    // //     address[] memory _pools = piGlobal.liquidityPools();

    // //     for (uint i = 0; i < _pools.length; i++) {
    // //         IPool _pool = IPool(_pools[i]);
    // //         uint _price = _normalizedPrice(_pool.asset());

    // //         // Keep everything with 18 decimals at price level
    // //         uint _offset = BASE_PRECISION / (10 ** _pool.decimals());
    // //         uint _bal =  _pool.balance() * _offset;

    // //         // Price is on 1e18 precision
    // //         _available += (_bal * _price / BASE_PRECISION);
    // //     }
    // // }

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
}
