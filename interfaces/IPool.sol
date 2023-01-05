// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IPool {
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint);
    function balance() external view returns (uint);
    function piGlobal() external view returns (address);
}

interface ICPool is IPool {
    function getPricePerFullShare() external view returns (uint);
    function collateralRatio() external view returns (uint);
    function MAX_COLLATERAL_RATIO() external view returns (uint);
    function availableCollateral(address) external view returns (uint);
    function repay(address, address, uint) external;
}

interface ILPool is IPool {
    function debt(address) external view returns (uint);
    function liquidate(address, address, uint) external;
    function expired() external view returns (bool);
    function repayFor(address, uint) external;
    function treasury() external view returns (address);
}
