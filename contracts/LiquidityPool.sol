// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "hardhat/console.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {DToken}  from "./DToken.sol";
import {LToken}  from "./LToken.sol";
import {PiAdmin} from "./PiAdmin.sol";
import {Oracle}  from "./Oracle.sol";

contract LiquidityPool is Pausable, ReentrancyGuard, PiAdmin {
    using SafeERC20 for IERC20Metadata;
    IERC20Metadata public immutable asset;
    LToken public immutable lToken;
    // Debt itself
    DToken public immutable dToken;
    // Interest token
    DToken public immutable iToken;
    Oracle public oracle;

    uint public constant PRECISION = 1e18;
    uint public constant SECONDS_PER_YEAR = 365 days;
    uint public constant MAX_INTEREST_RATE = 1e18; // Max interest rate 100% JIC

    // 1%
    uint public interestRate = 0.01e18;

    // Map of users address and the timestamp of their last update (userAddress => lastUpdateTimestamp)
    mapping(address => uint40) internal _timestamps;

    constructor(IERC20Metadata _asset) {
        asset = _asset;

        // Liquidity token
        lToken = new LToken(asset);
        // Debt token
        dToken = new DToken(asset);
        // Interest token
        iToken = new DToken(asset);
    }

    error ZeroAddress();
    error SameValue();
    error InvalidOracle();
    error InsufficientFunds();
    error NoDebt();
    error ZeroShares();
    error ZeroAmount();
    error InsufficientLiquidity();
    error GreaterThan(string _constant);
    error AlreadyInitialized();

    event Deposit(address _sender, address _onBehalfOf, uint _amount, uint _shares);
    event Withdraw(address _sender, address _to, uint _amount, uint _shares);
    event Borrow(address _sender, uint _amount);
    event Repay(address _sender, uint _amount);
    event NewInterestInterestRate(uint _oldInterestRate, uint _newInterestRate);
    event NewOracle(address _oldOracle, address _newOracle);

    /*********** COMMON FUNCTIONS ***********/
    function decimals() public view returns (uint8) {
        return asset.decimals();
    }

    function setInterestInterestRate(uint _newInterestRate) external onlyAdmin {
        if (_newInterestRate > MAX_INTEREST_RATE) revert GreaterThan("MAX_INTEREST_RATE");
        if (dToken.totalSupply() > 0) revert AlreadyInitialized();

        emit NewInterestInterestRate(interestRate, _newInterestRate);

        interestRate = _newInterestRate;
    }

    function setOracle(address _oracle) external onlyAdmin {
        if (_oracle == address(0)) revert ZeroAddress();
        if (_oracle == address(oracle)) revert SameValue();
        // if (Oracle(_oracle).priceFeeds(address(asset)) == address(0)) revert InvalidOracle();

        emit NewOracle(address(oracle), _oracle);

        oracle = Oracle(_oracle);
    }

    /*********** LIQUIDITY FUNCTIONS ***********/
    function balanceOf(address _account) public view returns (uint) {
        return lToken.balanceOf(_account);
    }

    function deposit(uint _amount, address _onBehalfOf) external nonReentrant  whenNotPaused {
        _deposit(_amount, _onBehalfOf);
    }

    function deposit(uint _amount) external nonReentrant  whenNotPaused {
        _deposit(_amount, msg.sender);
    }

    function _deposit(uint _amount, address _onBehalfOf) internal {
        uint _before = balance();

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
     *   - Send the value type(uint).max in order to withdraw the whole aToken balance
     * @param _to Address that will receive the underlying, same as msg.sender if the user
     *   wants to receive it on his own wallet, or a different address if the beneficiary is a
     *   different wallet
     * @return The final amount withdrawn
     **/
    function withdraw(
        uint _shares,
        address _to
    ) external nonReentrant whenNotPaused returns (uint) {
        return _withdraw(_shares, _to);
    }

    function withdraw(uint _shares) external nonReentrant whenNotPaused returns (uint) {
        return _withdraw(_shares, msg.sender);
    }

    function withdrawAll() external nonReentrant whenNotPaused returns (uint) {
        return _withdraw(lToken.balanceOf(msg.sender), msg.sender);
    }

    function _withdraw(uint _shares, address _to) internal returns (uint) {
        if (_shares <= 0) revert ZeroShares();

        uint _amount = (balance() * _shares) / lToken.totalSupply();

        lToken.burn(msg.sender, _shares);

        asset.safeTransfer(_to, _amount);

        emit Withdraw(msg.sender, _to, _amount, _shares);

        return _amount;
    }

    function balance() public view returns (uint) {
        return asset.balanceOf(address(this));
    }

    /*********** BORROW FUNCTIONS  *********/

    function borrow(uint _amount) external nonReentrant {
        if (_amount <= 0) revert ZeroAmount();
        if (_amount > balance()) revert InsufficientLiquidity();
        _checkBorrowAmount(_amount);

        address _account = msg.sender;

        asset.safeTransfer(_account, _amount);

        // New amount + interest tokens to be minted since the last interaction
        // iToken mint should be first to prevent "new dToken mint" to get in
        // the debt calc
        iToken.mint(_account, _debtTokenDiff(_account));
        dToken.mint(_account, _amount);

        _timestamps[_account] = uint40(block.timestamp);

        emit Borrow(_account, _amount);
    }

    function repay(uint _amount) external nonReentrant {
        if (_amount <= 0) revert ZeroAmount();
        if (_timestamps[msg.sender] == 0) revert NoDebt();

        (
            uint _dTokens,
            uint _iTokens,
            uint _diff,
            uint _totalDebt
        ) = _debt(msg.sender);

        // tmp var used to keep track what amount is left to use as payment
        uint _rest = _amount;

        if (_amount >= _totalDebt) {
            // All debt is repaid
            _amount = _totalDebt;
            _timestamps[msg.sender] = 0;
            _rest = 0;

            // Burn debt & interests
            dToken.burn(msg.sender, _dTokens);
            if (_iTokens > 0) iToken.burn(msg.sender, _iTokens);
        } else {
            if (_amount <= _diff) {
                _rest = 0;

                // Pay part of the not-minted amount since last interaction
                // and mint the other part.
                if (_diff - _amount > 0) iToken.mint(msg.sender, _diff - _amount);
            } else {
                _rest -= _diff;

                if (_rest <= _iTokens) {
                    // Pay part of the interest amount
                    iToken.burn(msg.sender, _rest);

                    _rest = 0;
                } else {
                    // Pay all the interests
                    if (_iTokens > 0) iToken.burn(msg.sender, _iTokens);

                    _rest -= _iTokens;

                    // Pay partially the debt
                    dToken.burn(msg.sender, _rest);
                }
            }

            // Update last user interaction
            _timestamps[msg.sender] = uint40(block.timestamp);
        }

        asset.safeTransferFrom(msg.sender, address(this), _amount);

        emit Repay(msg.sender, _amount);
    }

    function debt(address _account) external view returns (uint) {
        (,,, uint _amount) = _debt(_account);

        return _amount;
    }

    function debt() external view returns (uint) {
        (,,, uint _amount) = _debt(msg.sender);

        return _amount;
    }

    function _debt(address _account) internal view returns (uint, uint, uint, uint) {
        uint _dBal = dToken.balanceOf(_account);
        uint _iBal = iToken.balanceOf(_account);

        if (_dBal <= 0 && _iBal <= 0) return (0, 0, 0, 0);

        uint _notMintedInterest = _debtTokenDiff(_account);

        // Interest is only calculated over the original borrow amount
        return (_dBal, _iBal, _notMintedInterest, _dBal + _iBal + _notMintedInterest);
    }

    function _debtTokenDiff(address _account) internal view returns (uint) {
        uint _bal = dToken.balanceOf(_account);
        if (_bal <= 0) return 0;

        return _bal * _calculateInterestRatio(_account) / PRECISION;
    }

    function _calculateInterestRatio(address _account) internal view returns (uint) {
        return interestRate * (block.timestamp - uint(_timestamps[_account])) / SECONDS_PER_YEAR;
    }

    function _checkBorrowAmount(uint _amount) internal view {
        uint _available = oracle.availableCollateralForAsset(msg.sender, address(asset));

        if (_amount > _available) revert InsufficientFunds();
    }
}
