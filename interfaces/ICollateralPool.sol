// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface ICollateralPool {
    function asset() external view returns (address);
    function deposit(uint _amount) external;
    function deposit(uint _amount, address _onBehalfOf) external;
    function withdraw(uint _amount) external;
    function withdraw(uint _amount, address _to) external;
    function withdrawAll() external;
}
