// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./PiAdmin.sol";
import "../interfaces/IOracle.sol";
import "../libraries/Errors.sol";

/**
 * @title PiGlobal
 *
 * @dev PiGlobal is a contract that manages all the available liquidity and
 * collateral pools, as well as the oracle.
 */
contract PiGlobal is PiAdmin {
    using EnumerableSet for EnumerableSet.AddressSet;

    EnumerableSet.AddressSet internal collateralPoolsSet;
    EnumerableSet.AddressSet internal liquidityPoolsSet;

    address public oracle;
    address public treasury;

    /**
     * @dev Throws if called with an already registered pool.
     */
    error AlreadyExists();

    /**
     * @dev Throws if called with a non registered pool.
     */
    error UnknownPool();

    /**
     * @dev Throws if called with an oracle registered on another PiGlobal.
     */
    error WrongOracle();

    /**
     * @dev Emmited when a new oracle is registered.
     */
    event NewOracle(address _old, address _new);

    /**
     * @dev Emmited when a new collateral pool is registered.
     */
    event NewCollateralPool(address);

    /**
     * @dev Emmited when a new liquidity pool is registered.
     */
    event NewLiquidityPool(address);

    /**
     * @dev Emmited when a collateral pool is unregistered.
     */
    event CollateralPoolRemoved(address);

    /**
     * @dev Emmited when a liquidity pool is unregistered.
     */
    event LiquidityPoolRemoved(address);

    /**
     * @dev Emmited when a new treasury is registered.
     */
    event NewTreasury(address _old, address _new);

    constructor() { treasury = msg.sender; }

    /**
     * @dev Set the oracle address
     *
     * @param _oracle The address of the new oracle
     */
    function setOracle(address _oracle) external onlyAdmin nonReentrant {
        if (_oracle == address(0)) revert Errors.ZeroAddress();
        if (IOracle(_oracle).piGlobal() != address(this)) revert WrongOracle();

        emit NewOracle(oracle, _oracle);

        oracle = _oracle;
    }

    /**
     * @dev Set the treasury address, it should be the one used by default on every new contract
     *
     * @param _treasury The address of the new treasury
     */
    function setTreasury(address _treasury) external onlyAdmin nonReentrant {
        if (_treasury == address(0)) revert Errors.ZeroAddress();
        if (_treasury == treasury) revert Errors.SameValue();

        emit NewTreasury(treasury, _treasury);

        treasury = _treasury;
    }

    /**
     * @dev Register a new collateral pool
     *
     * @param _pool The address of the new collateral pool
     */
    function addCollateralPool(address _pool) external onlyAdmin nonReentrant {
        if (_pool == address(0)) revert Errors.ZeroAddress();

        if (! collateralPoolsSet.add(_pool)) revert AlreadyExists();

        emit NewCollateralPool(_pool);
    }

    /**
     * @dev Removes a collateral pool
     *
     * @param _pool The address of the collateral pool to remove
     */
    function removeCollateralPool(address _pool) external onlyAdmin nonReentrant {
        if (_pool == address(0)) revert Errors.ZeroAddress();

        if (! collateralPoolsSet.remove(_pool)) revert UnknownPool();

        emit CollateralPoolRemoved(_pool);
    }

    /**
     * @dev Register a new liquidity pool
     *
     * @param _pool The address of the new liquidity pool
     */
    function addLiquidityPool(address _pool) external onlyAdmin nonReentrant {
        if (_pool == address(0)) revert Errors.ZeroAddress();

        if (! liquidityPoolsSet.add(_pool)) revert AlreadyExists();

        emit NewLiquidityPool(_pool);
    }

    /**
     * @dev Removes a liquidity pool
     *
     * @param _pool The address of the liquidity pool to remove
     */
    function removeLiquidityPool(address _pool) external onlyAdmin nonReentrant {
        if (_pool == address(0)) revert Errors.ZeroAddress();

        if (! liquidityPoolsSet.remove(_pool)) revert UnknownPool();

        emit LiquidityPoolRemoved(_pool);
    }

    /**
     * @dev Returns a list of all registered collateral pools
     */
    function collateralPools() external view returns (address[] memory _pools) {
        _pools = collateralPoolsSet.values();
    }

    /**
     * @dev Returns a list of all registered liquidity pools
     */
    function liquidityPools() external view returns (address[] memory _pools) {
        _pools = liquidityPoolsSet.values();
    }

    /**
     * @dev Returns true if the given address is a registered collateral pool
     */
    function isValidCollateralPool(address _pool) external view returns (bool) {
        return collateralPoolsSet.contains(_pool);
    }
}
