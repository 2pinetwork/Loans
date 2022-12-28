// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract SafeBox is ReentrancyGuard{
    using SafeERC20 for IERC20;

    address public immutable owner;
    IERC20 public immutable asset;

    constructor(address _asset) {
        owner = msg.sender; // creator
        asset = IERC20(_asset);
    }

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function balance() public view returns (uint) {
        return asset.balanceOf(address(this));
    }

    function transfer(uint _amount) external nonReentrant onlyOwner {
        asset.safeTransfer(msg.sender, _amount);
    }
}
