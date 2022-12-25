// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IOracle {
    function getLiquidableAmounts(address, address) external view returns (uint, uint);
    function healthFactor(address) external view returns (uint, uint);
}
