// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./PiAdmin.sol";

interface IGlobal {
    function collateralPools() external view returns (address[] memory);
    function liquidityPools() external view returns (address[] memory);
}

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
    function aggregator() external view returns (address);
}

contract Oracle is PiAdmin {
    mapping(address => IChainLink) public priceFeeds;

    // Time toleration for price feed
    uint public toleration;
    uint public constant MAX_TOLERATION = 24 hours;

    IGlobal public immutable global;

    error OldPrice();
    error MaxToleration();
    error SameToleration();

    constructor(IGlobal _global) {
        // at least check the contract
        _global.collateralPools();
        _global.liquidityPools();

        global = _global;
    }

    event NewToleration(uint _old, uint _new);

    function setToleration(uint _newToleration) external onlyAdmin {
        if (_newToleration > MAX_TOLERATION) { revert MaxToleration(); }
        if (toleration == _newToleration) { revert SameToleration(); }

        emit NewToleration(toleration, _newToleration);

        toleration = _newToleration;
    }

    function addPriceOracle(address _token, IChainLink _feed) external onlyAdmin {
        require(_token != address(0), "!ZeroAddress");
        require(priceFeeds[_token] != _feed, "!ZeroAddress");

        (uint80 round, int price,,,) = _feed.latestRoundData();
        require(round > 0 && price > 0, "Invalid feed");

        priceFeeds[_token] = _feed;
    }

    function availableCollateral(address _account) external view returns (uint _available) {
        address[] memory _pools = global.collateralPools();

        for (uint i = 0; i < _pools.length; i++) {
            IPool _pool = IPool(_pools[i]);
            uint price = _price(_pool.asset());


            uint _bal = (
                // shares balance
                _pool.balanceOf(_account) *
                // Keep everything with 18 decimals at price level
                (10 ** (18 - _pool.decimals())) *
                // Price per share
            _pool.getPricePerFullShare() *
                // Share precision
                (10 ** _pool.decimals())
            );

            // Cambiar este 1e8
            _available += (_bal * price / 1e8);
        }
    }

    function availableLiquidity() external view returns (uint _available) {
        address[] memory _pools = global.liquidityPools();

        for (uint i = 0; i < _pools.length; i++) {
            IPool _pool = IPool(_pools[i]);
            uint price = _price(_pool.asset());

            // Keep everything with 18 decimals at price level
            uint _bal = ( _pool.balance() * (10 ** (18 - _pool.decimals())));

            // Cambiar este 1e8
            _available += (_bal * price / 1e8);
        }
    }

    function _price(address _asset) internal view returns (uint) {
        (
            uint80 _id,
            int _roundPrice,
            ,
            uint _timestamp,
            uint80 _answeredInRound
        ) =  priceFeeds[_asset].latestRoundData();
        if (_id < _answeredInRound) { revert OldPrice(); }
        if (_timestamp + toleration < block.timestamp) { revert OldPrice(); }

        return uint(_roundPrice);
    }
}
