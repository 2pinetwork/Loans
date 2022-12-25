// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./PiAdmin.sol";

contract Global is PiAdmin {
    using EnumerableSet for EnumerableSet.AddressSet;

    EnumerableSet.AddressSet internal collateralPoolsSet;
    EnumerableSet.AddressSet internal liquidityPoolsSet;

    address public oracle;

    error AlreadyExists();
    error UnknownPool();
    error ZeroAddress();

    constructor() { }

    event NewCollateralPool(address);
    event NewLiquidityPool(address);
    event CollateralPoolRemoved(address);
    event LiquidityPoolRemoved(address);

    function setOracle(address _oracle) external onlyAdmin {
        oracle = _oracle;
    }

    function addCollateralPool(address _pool) external onlyAdmin {
        if (_pool == address(0)) revert ZeroAddress();

        if (! collateralPoolsSet.add(_pool)) revert AlreadyExists();

        emit NewCollateralPool(_pool);
    }

    function removeCollateralPool(address _pool) external onlyAdmin {
        if (_pool == address(0)) revert ZeroAddress();

        if (! collateralPoolsSet.remove(_pool)) revert UnknownPool();

        emit CollateralPoolRemoved(_pool);
    }

    function addLiquidityPool(address _pool) external onlyAdmin {
        if (_pool == address(0)) revert ZeroAddress();

        if (! liquidityPoolsSet.add(_pool)) revert AlreadyExists();

        liquidityPoolsSet.add(_pool);

        emit NewLiquidityPool(_pool);
    }

    function removeLiquidityPool(address _pool) external onlyAdmin {
        if (! liquidityPoolsSet.remove(_pool)) revert UnknownPool();

        emit LiquidityPoolRemoved(_pool);
    }

    function collateralPools() external view returns (address[] memory _pools) {
        _pools = collateralPoolsSet.values();
    }

    function liquidityPools() external view returns (address[] memory _pools) {
        _pools = liquidityPoolsSet.values();
    }
}
