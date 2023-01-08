// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SafeBox
 *
 * @dev This contract is a simple vault where liquidity pools can deposit when debt is repaid.
 */
contract SafeBox is ReentrancyGuard{
    using SafeERC20 for IERC20;

    address public immutable owner;
    IERC20 public immutable asset;

    /**
     * @dev Initializes the contract.
     *
     * @param _asset The address of the asset to be deposited.
     */
    constructor(address _asset) {
        owner = msg.sender; // creator
        asset = IERC20(_asset);
    }

    /**
     * @dev Throws if called by any account other than the owner.
     */
    error NotOwner();

    /**
     * @dev Modifier to make a function callable only by the owner.
     */
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @dev Returns the amount of asset in the safebox.
     */
    function balance() public view returns (uint) {
        return asset.balanceOf(address(this));
    }

    /**
     * @dev Transfers the given amount of asset to the sender.
     * Can only be called by the current owner.
     *
     * @param _amount The amount of asset to be transferred.
     */
    function transfer(uint _amount) external nonReentrant onlyOwner {
        asset.safeTransfer(msg.sender, _amount);
    }
}
