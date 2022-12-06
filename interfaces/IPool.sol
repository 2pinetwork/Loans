// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IPool {
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
    function getPricePerFullShare() external view returns (uint);
    function balanceOf(address) external view returns (uint);
    function balance() external view returns (uint);
    function debt(address) external view returns (uint);
    function collateralRatio() external view returns (uint);
    function MAX_COLLATERAL_RATIO() external view returns (uint);
    function availableCollateral(address) external view returns (uint);
}