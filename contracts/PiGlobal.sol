// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./PiAdmin.sol";
import "../interfaces/IOracle.sol";
import "../libraries/Errors.sol";

contract PiGlobal is PiAdmin {
    using EnumerableSet for EnumerableSet.AddressSet;

    EnumerableSet.AddressSet internal collateralPoolsSet;
    EnumerableSet.AddressSet internal liquidityPoolsSet;

    address public oracle;
    address public treasury;

    error AlreadyExists();
    error UnknownPool();
    error WrongOracle();

    event NewOracle(address _old, address _new);
    event NewCollateralPool(address);
    event NewLiquidityPool(address);
    event CollateralPoolRemoved(address);
    event LiquidityPoolRemoved(address);
    event NewTreasury(address _old, address _new);

    constructor() { treasury = msg.sender; }

    function setOracle(address _oracle) external onlyAdmin {
        if (_oracle == address(0)) revert Errors.ZeroAddress();
        if (IOracle(_oracle).piGlobal() != address(this)) revert WrongOracle();

        emit NewOracle(oracle, _oracle);

        oracle = _oracle;
    }

    // To be used by default
    function setTreasury(address _treasury) external onlyAdmin {
        if (_treasury == address(0)) revert Errors.ZeroAddress();
        if (_treasury == treasury) revert Errors.SameValue();

        emit NewTreasury(treasury, _treasury);

        treasury = _treasury;
    }

    function addCollateralPool(address _pool) external onlyAdmin {
        if (_pool == address(0)) revert Errors.ZeroAddress();

        if (! collateralPoolsSet.add(_pool)) revert AlreadyExists();

        emit NewCollateralPool(_pool);
    }

    function removeCollateralPool(address _pool) external onlyAdmin {
        if (_pool == address(0)) revert Errors.ZeroAddress();

        if (! collateralPoolsSet.remove(_pool)) revert UnknownPool();

        emit CollateralPoolRemoved(_pool);
    }

    function addLiquidityPool(address _pool) external onlyAdmin {
        if (_pool == address(0)) revert Errors.ZeroAddress();

        if (! liquidityPoolsSet.add(_pool)) revert AlreadyExists();

        liquidityPoolsSet.add(_pool);

        emit NewLiquidityPool(_pool);
    }

    function removeLiquidityPool(address _pool) external onlyAdmin {
        if (_pool == address(0)) revert Errors.ZeroAddress();

        if (! liquidityPoolsSet.remove(_pool)) revert UnknownPool();

        emit LiquidityPoolRemoved(_pool);
    }

    function collateralPools() external view returns (address[] memory _pools) {
        _pools = collateralPoolsSet.values();
    }

    function liquidityPools() external view returns (address[] memory _pools) {
        _pools = liquidityPoolsSet.values();
    }

    function isValidCollateralPool(address _pool) external view returns (bool) {
        return collateralPoolsSet.contains(_pool);
    }
}
