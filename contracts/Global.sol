// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./PiAdmin.sol";

contract Global is PiAdmin {
    using EnumerableSet for EnumerableSet.AddressSet;

    EnumerableSet.AddressSet public collateralPools;
    EnumerableSet.AddressSet public liquidityPools;

    error AlreadyExists();
    error ZeroAddress();

    constructor() { }

    event NewCollateralPool(address);
    event NewLiquidityPool(address);

    function addCollateralPool(address _pool) external onlyAdmin {
        if (_pool == address(0)) { revert ZeroAddress(); }

        for (uint i = 0; i < collateralPools.length() ; i++) {
            if (collateralPools.at(i) == _pool) { revert AlreadyExists(); }
        }

        collateralPools.add(_pool);

        emit NewCollateralPool(_pool);
    }

    function removeCollateralPool(address _pool) external onlyAdmin {
        if (! collateralPools.remove(_pool)) { revert UnknownPool() };
    }

    function addLiquidityPool(address _pool) external onlyAdmin {
        if (_pool == address(0)) { revert ZeroAddress(); }

        for (uint i = 0; i < liquidityPools.length() ; i++) {
            if (liquidityPools.at(i) == _pool) { revert AlreadyExists(); }
        }

        liquidityPools.add(_pool);

        emit NewLiquidityPool(_pool);
    }

    function removeLiquidityPool(address _pool) external onlyAdmin {
        if (! liquidityPools.remove(_pool)) { revert UnknownPool() };
    }
}
