// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IGlobal {
    function collateralPools() external view returns (address[] memory);
    function liquidityPools() external view returns (address[] memory);
}
