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

    error ZeroShares();

    event Deposit(address _sender, address _onBehalfOf, uint _amount, uint _shares);
    event Withdraw(address _sender, address _to, uint _amount, uint _shares);

    function deposit(uint256 _amount, address _onBehalfOf) external nonReentrant  whenNotPaused {
        _deposit(_amount, _onBehalfOf);
    }

    function deposit(uint256 _amount) external nonReentrant  whenNotPaused {
        _deposit(_amount, msg.sender);
    }

    function _deposit(uint _amount, address _onBehalfOf) internal {
        uint256 _before = balance();

        asset.safeTransferFrom(msg.sender, address(this), _amount);

        // SaveGas
        uint _supply = cToken.totalSupply();
        uint _shares;

        if (_supply <= 0) {
            _shares = _amount;
        } else {
            _shares = (_amount * _supply) / _before;
        }

        if (_shares <= 0) { revert ZeroShares(); }

        cToken.mint(_onBehalfOf, _shares);

        emit Deposit(msg.sender, _onBehalfOf, _amount, _shares);
    }

    /**
        * @dev Withdraws an `amount` of underlying asset from the reserve, burning the equivalent aTokens owned
    * E.g. User has 100 aUSDC, calls withdraw() and receives 100 USDC, burning the 100 aUSDC
    * @param _shares The shares to be withdrawn
    *   - Send the value type(uint256).max in order to withdraw the whole aToken balance
    * @param _to Address that will receive the underlying, same as msg.sender if the user
        *   wants to receive it on his own wallet, or a different address if the beneficiary is a
            *   different wallet
    * @return The final amount withdrawn
    **/
    function withdraw(
        uint256 _shares,
        address _to
    ) external nonReentrant whenNotPaused returns (uint256) {
        return _withdraw(_shares, _to);
    }

    function withdraw(uint256 _shares) external nonReentrant whenNotPaused returns (uint256) {
        return _withdraw(_shares, msg.sender);
    }

    function withdrawAll() external nonReentrant whenNotPaused returns (uint256) {
        return _withdraw(cToken.balanceOf(msg.sender), msg.sender);
    }

    function _withdraw(uint256 _shares, address _to) internal returns (uint256) {
        if (_shares <= 0) { revert ZeroShares(); }

        uint _amount = (balance() * _shares) / cToken.totalSupply();

        cToken.burn(msg.sender, _shares);

        asset.safeTransfer(_to, _amount);

        emit Withdraw(msg.sender, _to, _amount, _shares);

        return _amount;
    }

    function balance() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }
}
