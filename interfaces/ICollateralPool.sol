// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface ICollateralPool {
    function asset() external view returns (address);
    function deposit(uint _amount) external;
    function deposit(uint _amount, address _onBehalfOf) external;
    function mint(uint _amount, address _to) external;
    function withdraw(uint _amount) external;
    function withdraw(uint _amount, address _to) external;
    function withdraw(uint _amount, address _to, address _owner) external;
    function withdrawAll() external;
    function redeem(uint _amount, address _to) external;
}
