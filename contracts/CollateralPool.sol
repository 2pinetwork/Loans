// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;
// import "hardhat/console.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {CToken} from "./CToken.sol";

contract CollateralPool is Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;
    IERC20Metadata public immutable asset;
    CToken public immutable cToken;

    constructor(IERC20Metadata _asset) {
        asset = _asset;

        cToken = new CToken(asset);
    }

    event Deposit(address _sender, address _onBehalfOf, uint _amount);
    event Withdraw(address _sender, address _to, uint _amount);

    function deposit(uint256 _amount, address _onBehalfOf) external nonReentrant  whenNotPaused {
        _deposit(_amount, _onBehalfOf);
    }

    function deposit(uint256 _amount) external nonReentrant  whenNotPaused {
        _deposit(_amount, msg.sender);
    }

    function _deposit(uint _amount, address _onBehalfOf) internal {
        asset.safeTransferFrom(msg.sender, address(this), _amount);

        cToken.mint(_onBehalfOf, _amount);

        emit Deposit(msg.sender, _onBehalfOf, _amount);
    }

    /**
        * @dev Withdraws an `amount` of underlying asset from the reserve, burning the equivalent aTokens owned
    * E.g. User has 100 aUSDC, calls withdraw() and receives 100 USDC, burning the 100 aUSDC
    * @param _amount The underlying amount to be withdrawn
    *   - Send the value type(uint256).max in order to withdraw the whole aToken balance
    * @param _to Address that will receive the underlying, same as msg.sender if the user
        *   wants to receive it on his own wallet, or a different address if the beneficiary is a
            *   different wallet
    * @return The final amount withdrawn
    **/
    function withdraw(
        uint256 _amount,
        address _to
    ) external nonReentrant whenNotPaused returns (uint256) {
        return _withdraw(_amount, _to);
    }

    function withdraw(uint256 _amount) external nonReentrant whenNotPaused returns (uint256) {
        return _withdraw(_amount, msg.sender);
    }

    function _withdraw(uint256 _amount, address _to) internal returns (uint256) {
        if (_amount == type(uint256).max) { _amount = cToken.balanceOf(msg.sender); }

        cToken.burn(msg.sender, _amount);

        asset.safeTransfer(_to, _amount);

        emit Withdraw(msg.sender, _to, _amount);

        return _amount;
    }
}
