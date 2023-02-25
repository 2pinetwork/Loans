// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IController {
    function pool() external view returns (address);
    function decimals() external view returns (uint8);
    function pricePerShare() external view returns (uint);
    function piGlobal() external view returns (address);
    function asset() external view returns (address);
    function balanceOf(address _account) external view returns (uint);
    function balance() external view returns (uint);
    function convertToShares(uint _amount) external view returns (uint);
    function convertToAssets(uint _shares) external view returns (uint);
    function totalSupply() external view returns (uint);
    function deposit(address _onBehalfOf, uint _amount) external returns (uint);
    function withdraw(address _caller, address _to, uint _shares) external returns (uint, uint);
    function withdrawForLiquidation(address _liquidated, uint _shares) external returns (uint);
    function availableUserDeposit(address _user) external view returns (uint);
}
