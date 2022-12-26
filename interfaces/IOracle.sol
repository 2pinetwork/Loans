// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IOracle {
    function piGlobal() external view returns (address);
    function getLiquidableAmounts(address, address) external view returns (uint, uint);
    function healthFactor(address) external view returns (uint);
    function availableCollateralForAsset(address, address) external view returns (uint);
}
