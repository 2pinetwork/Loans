// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;
// import "hardhat/console.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {LToken} from "./LToken.sol";
import {BToken} from "./BToken.sol";

contract LiquidityPool is Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;
    IERC20Metadata public immutable asset;
    LToken public immutable lToken;
    BToken public immutable bToken;

    constructor(IERC20Metadata _asset) {
        asset = _asset;

        lToken = new LToken(asset);
        bToken = new BToken(asset);
    }

    error ZeroShares();

    event Deposit(address _sender, address _onBehalfOf, uint _amount, uint _shares);
    event Withdraw(address _sender, address _to, uint _amount, uint _shares);
    event Borrow(address _sender, uint _amount);
    event Repay(address _sender, uint _amount);

    function decimals() public view returns (uint8) {
        return asset.decimals();
    }

    /*********** LIQUIDITY FUNCTIONS ***********/

    function balanceOf(address _account) public view returns (uint) {
        return lToken.balanceOf(_account);
    }

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
        uint _supply = lToken.totalSupply();
        uint _shares;

        if (_supply <= 0) {
            _shares = _amount;
        } else {
            _shares = (_amount * _supply) / _before;
        }

        if (_shares <= 0) revert ZeroShares();

        lToken.mint(_onBehalfOf, _shares);

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
        return _withdraw(lToken.balanceOf(msg.sender), msg.sender);
    }

    function _withdraw(uint256 _shares, address _to) internal returns (uint256) {
        if (_shares <= 0) revert ZeroShares();

        uint _amount = (balance() * _shares) / lToken.totalSupply();

        lToken.burn(msg.sender, _shares);

        asset.safeTransfer(_to, _amount);

        emit Withdraw(msg.sender, _to, _amount, _shares);

        return _amount;
    }

    function balance() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /*********** BORROW FUNCTIONS  *********/

    function borrow(uint _amount) external nonReentrant {
        if (_amount <= 0) revert ZeroAmount();

        bToken.mint(msg.sender, _amount);
        asset.safeTransfer(msg.sender, _amount);

        emit Borrow(msg.sender, _amount);
    }

    function repay(uint _amount) external nonReentrant {
        if (_amount <= 0) revert ZeroAmount();

        uint _totalDebt = _debt(msg.sender);

        if (_amount > _totalDebt) _amount = _totalDebt;

        asset.safeTransferFrom(msg.sender, _amount);

        bToken.burn(msg.sender, _amount);

        emit Repay(msg.sender, _amount);
    }

    function debt(address _account) external view returns (uint) {
        return _debt(_account);
    }

    function debt() external view returns (uint) {
        return _debt(msg.sender);
    }

    function _debt(address _account) internal view returns (uint) {
        uint _amount = bToken.balanceOf(_account);
        if (_amount <= 0) return 0;

        return _amount.mulRay(_calculateInterest(_account));
    }

    function getPricePerFullShare() public view returns (uint) {
        return (10 ** decimals());
    }

    function _calculateInterest(address _account) internal view returns (uint) {
        _calculateCompoundedInterest(_timestamps[account])
    }

    function _calculateCompoundedInterest( uint40 lastUpdateTimestamp) internal pure returns (uint256) {
    //solium-disable-next-line
    uint256 exp = block.timestamp - uint256(lastUpdateTimestamp);

    if (exp == 0) {
      return WadRayMath.ray();
    }

    uint256 expMinusOne = exp - 1;

    uint256 expMinusTwo = exp > 2 ? exp - 2 : 0;

    uint256 ratePerSecond = rate / SECONDS_PER_YEAR;

    uint256 basePowerTwo = ratePerSecond.rayMul(ratePerSecond);
    uint256 basePowerThree = basePowerTwo.rayMul(ratePerSecond);

    uint256 secondTerm = exp * expMinusOne * basePowerTwo / 2;
    uint256 thirdTerm = exp * expMinusOne * expMinusTwo * basePowerThree / 6;

    return WadRayMath.ray() + (ratePerSecond * exp) + secondTerm + thirdTerm;
  }
}
