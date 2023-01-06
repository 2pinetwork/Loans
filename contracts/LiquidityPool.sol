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
import {SafeBox} from "./SafeBox.sol";
import {IDebtSettler} from "../interfaces/IDebtSettler.sol";

import "../interfaces/IOracle.sol";
import "../interfaces/IPiGlobal.sol";
import "../libraries/Errors.sol";

contract LiquidityPool is Pausable, PiAdmin {
    using SafeERC20 for IERC20Metadata;

    IERC20Metadata public immutable asset;
    // Liquidity token
    LToken public immutable lToken;
    // Debt token
    DToken public immutable dToken;
    // Debt Interest token
    DToken public immutable iToken;
    // PiGlobal
    IPiGlobal public immutable piGlobal;

    uint public constant PRECISION = 1e18;
    uint public constant SECONDS_PER_YEAR = 365 days;
    uint public constant MAX_RATE = 1e18; // Max rate 100% JIC

    // 1%
    uint public interestRate = 0.01e18;

    // Map of users address and the timestamp of their last update (userAddress => lastUpdateTimestamp)
    mapping(address => uint40) internal _timestamps;

    // Due date to end the pool
    uint public immutable dueDate;

    // Fees
    address public treasury;
    uint public piFee;
    uint public originatorFee;
    // Fees to be paid by borrowers
    mapping(address => uint) public remainingOriginatorFee;

    // Put the repayment amount in other contract
    // to prevent re-borrowing
    SafeBox public safeBox;
    bool public safeBoxEnabled;

    // Debt settler
    IDebtSettler public debtSettler;

    error AlreadyInitialized();
    error DueDateInThePast();
    error ExpiredPool();
    error InsufficientFunds();
    error InsufficientLiquidity();
    error NoDebt();
    error UnknownSender();

    constructor(IPiGlobal _piGlobal, IERC20Metadata _asset, uint _dueDate) {
        if (_dueDate <= block.timestamp) revert DueDateInThePast();
        if (address(_piGlobal) == address(0)) revert Errors.ZeroAddress();
        if (_piGlobal.oracle() == address(0)) revert Errors.ZeroAddress();

        asset = _asset;
        dueDate = _dueDate;

        // Liquidity token
        lToken = new LToken(asset);
        // Debt token
        dToken = new DToken(asset);
        // Interest token
        iToken = new DToken(asset);

        treasury = _piGlobal.treasury();
        piGlobal = _piGlobal;
    }

    modifier notExpired() {
        if (expired()) revert ExpiredPool();
        _;
    }

    modifier fromCollateralPool {
        if (! piGlobal.isValidCollateralPool(msg.sender)) revert UnknownSender();
        _;
    }

    event Deposit(address _sender, address _onBehalfOf, uint _amount, uint _shares);
    event Withdraw(address _sender, address _to, uint _amount, uint _shares);
    event Borrow(address _sender, uint _amount);
    event Repay(address _sender, uint _amount);
    event NewOriginatorFee(uint _oldFee, uint _newFee);
    event NewInterestRate(uint _oldInterestRate, uint _newInterestRate);
    event NewOracle(address _oldOracle, address _newOracle);
    event NewPiFee(uint _oldFee, uint _newFee);
    event NewTreasury(address _oldTreasury, address _newTreasury);
    event CollectedFee(uint _fee);
    event CollectedOriginatorFee(uint _fee);
    event SafeBoxChanged(address _safeBox, bool _newState);
    event NewDebtSettler(address _old, address _new);

    /*********** COMMON FUNCTIONS ***********/
    function decimals() public view returns (uint8) {
        return asset.decimals();
    }

    function setInterestRate(uint _newInterestRate) external onlyAdmin nonReentrant {
        if (_newInterestRate > MAX_RATE) revert Errors.GreaterThan("MAX_RATE");
        if (dToken.totalSupply() > 0) revert AlreadyInitialized();

        emit NewInterestRate(interestRate, _newInterestRate);

        interestRate = _newInterestRate;
    }

    function setOriginatorFee(uint _newOriginatorFee) external onlyAdmin nonReentrant {
        // No more than 100% JIC
        if (_newOriginatorFee > MAX_RATE) revert Errors.GreaterThan("MAX_RATE");
        if (dToken.totalSupply() > 0) revert AlreadyInitialized();

        emit NewOriginatorFee(originatorFee, _newOriginatorFee);

        originatorFee = _newOriginatorFee;
    }

    function setPiFee(uint _piFee) external onlyAdmin nonReentrant {
        if (_piFee > MAX_RATE) revert Errors.GreaterThan("MAX_RATE");
        if (dToken.totalSupply() > 0) revert AlreadyInitialized();

        emit NewPiFee(piFee, _piFee);

        piFee = _piFee;
    }

    function setTreasury(address _treasury) external onlyAdmin nonReentrant {
        if (_treasury == address(0)) revert Errors.ZeroAddress();
        if (_treasury == treasury) revert Errors.SameValue();

        emit NewTreasury(treasury, _treasury);

        treasury = _treasury;
    }

    function setDebtSettler(IDebtSettler _debtSettler) external onlyAdmin {
        if (address(_debtSettler) == address(0)) revert Errors.ZeroAddress();
        if (address(_debtSettler) == address(debtSettler)) revert Errors.SameValue();

        emit NewDebtSettler(address(debtSettler), address(_debtSettler));

        debtSettler = _debtSettler;
    }

    function setSafeBoxEnabled(bool _newState) external onlyAdmin nonReentrant {
        if (safeBoxEnabled == _newState) revert Errors.SameValue();

        if (_newState) {
            // Create the contract if not created
            if (address(safeBox) == address(0)) safeBox = new SafeBox(address(asset));

            safeBoxEnabled = true;
        } else {
            uint _safeBal = safeBox.balance();

            // If safe is in use and now we want to permit the asset
            // been borrowed again, we have to get the asset back
            if (_safeBal > 0) safeBox.transfer(_safeBal);

            safeBoxEnabled = false;
        }

        emit SafeBoxChanged(address(safeBox), safeBoxEnabled);
    }

    function expired() public view returns (bool) {
        return block.timestamp > dueDate;
    }

    function balance() public view returns (uint) {
        return asset.balanceOf(address(this));
    }

    /*********** LIQUIDITY FUNCTIONS ***********/
    function balanceOf(address _account) public view returns (uint) {
        return lToken.balanceOf(_account);
    }

    function deposit(uint _amount, address _onBehalfOf) external nonReentrant notExpired {
        _deposit(_amount, _onBehalfOf);
    }

    function deposit(uint _amount) external nonReentrant notExpired {
        _deposit(_amount, msg.sender);
    }

    function _deposit(uint _amount, address _onBehalfOf) internal {
        uint _before = _balanceForSharesCalc();

        asset.safeTransferFrom(msg.sender, address(this), _amount);

        // SaveGas
        uint _supply = lToken.totalSupply();
        uint _shares;

        if (_supply <= 0) {
            _shares = _amount;
        } else {
            _shares = (_amount * _supply) / _before;
        }

        if (_shares <= 0) revert Errors.ZeroShares();

        lToken.mint(_onBehalfOf, _shares);

        emit Deposit(msg.sender, _onBehalfOf, _amount, _shares);
    }

    function withdraw(uint _shares, address _to) external nonReentrant returns (uint) {
        return _withdraw(_shares, _to);
    }

    function withdraw(uint _shares) external nonReentrant returns (uint) {
        return _withdraw(_shares, msg.sender);
    }

    function withdrawAll() external nonReentrant returns (uint) {
        return _withdraw(lToken.balanceOf(msg.sender), msg.sender);
    }

    function _withdraw(uint _shares, address _to) internal returns (uint) {
        if (_shares <= 0) revert Errors.ZeroShares();

        uint _amount = (_balanceForSharesCalc() * _shares) / lToken.totalSupply();


        uint _assetBal = balance();
        uint _safeBal = _safeBalance();

        if (_amount > (_assetBal + _safeBal)) revert InsufficientLiquidity();

        lToken.burn(msg.sender, _shares);

        // Ensure if we don't have the entire amount take it from safe
        if (_amount > _assetBal) safeBox.transfer(_amount - _assetBal);

        asset.safeTransfer(_to, _amount);

        emit Withdraw(msg.sender, _to, _amount, _shares);

        return _amount;
    }

    /*********** BORROW FUNCTIONS  *********/

    function borrow(uint _amount) external nonReentrant whenNotPaused notExpired {
        if (_amount <= 0) revert Errors.ZeroAmount();
        if (_amount > balance()) revert InsufficientLiquidity();
        _checkBorrowAmount(_amount);

        // Originator fee is based on the borrowed amount,
        // and will be prioritized over the interest fee when the debt is paid.
        uint _originatorFeeAmount = _originatorFeeFor(_amount);
        remainingOriginatorFee[msg.sender] += _originatorFeeAmount;

        // New amount + interest tokens to be minted since the last interaction
        // iToken mint should be first to prevent "new dToken mint" to get in
        // the debt calc
        uint _interestTokens = _debtTokenDiff(msg.sender);
        // originatorFee is directly added to the interest to prevent the borrower
        // receive less than expected. Instead the account will have to pay the interest for it
        _interestTokens += _originatorFeeAmount;

        // Mint interest tokens
        iToken.mint(msg.sender, _interestTokens);
        // Mint real debt tokens
        dToken.mint(msg.sender, _amount);

        // Set last interaction
        _timestamps[msg.sender] = uint40(block.timestamp);

        asset.safeTransfer(msg.sender, _amount);

        if (_hasDebtSettler()) debtSettler.addBorrower(msg.sender);

        emit Borrow(msg.sender, _amount);
    }

    function repay(uint _amount) external nonReentrant {
        _repay(msg.sender, msg.sender, _amount);
    }

    function repayFor(address _account, uint _amount) external nonReentrant {
        _repay(msg.sender, _account, _amount);
    }

    // Only collateralPools can call this
    // if anyone could call this, any unlimited allowance to this contract could be used to repay
    // debt on behalf of anyone...
    function liquidate(address _payer, address _account, uint _amount) external nonReentrant fromCollateralPool {
        _repay(_payer, _account, _amount);
    }

    function buildMassiveRepay(uint _amount) external nonReentrant {
        asset.safeTransferFrom(msg.sender, address(debtSettler), _amount);
        debtSettler.build(_amount);
    }

    function _repay(address _payer, address _account, uint _amount) internal {
        if (_amount <= 0) revert Errors.ZeroAmount();
        if (_timestamps[_account] == 0) revert NoDebt();

        (
            uint _dTokens,
            uint _iTokens,
            uint _diff,
            uint _totalDebt
        ) = _debt(_account);

        // tmp var used to keep track what amount is left to use as payment
        uint _rest = _amount;
        uint _interestToBePaid = 0;

        if (_amount >= _totalDebt) {
            // All debt is repaid
            _amount = _totalDebt;
            _timestamps[_account] = 0;
            _rest = 0;
            _interestToBePaid = _diff + _iTokens;

            // Burn debt & interests
            dToken.burn(_account, _dTokens);
            if (_iTokens > 0) iToken.burn(_account, _iTokens);

            // Remove from debtSettler
            if (_hasDebtSettler()) debtSettler.removeBorrower(_account);
        } else {
            // In case of amount <= diff || amount <= (diff + iTokens)
            _interestToBePaid = _amount;

            if (_amount <= _diff) {
                _rest = 0;

                // Pay part of the not-minted amount since last interaction
                // and mint the other part.
                if (_diff - _amount > 0) iToken.mint(_account, _diff - _amount);
            } else {
                _rest -= _diff;

                if (_rest <= _iTokens) {
                    // Pay part of the interest amount
                    iToken.burn(_account, _rest);

                    _rest = 0;
                } else {
                    // Pay all the interests
                    if (_iTokens > 0) iToken.burn(_account, _iTokens);

                    _rest -= _iTokens;
                    _interestToBePaid = _diff + _iTokens;

                    // Pay partially the debt
                    dToken.burn(_account, _rest);
                }
            }

            // Update last user interaction (or ending timestamp)
            uint _newTs = block.timestamp;
            if (_newTs > dueDate) _newTs = dueDate;
            _timestamps[_account] = uint40(_newTs);
        }

        // Take the payment
        asset.safeTransferFrom(_payer, address(this), _amount);

        uint _piFee = 0;
        // charge fees from payment
        if (_interestToBePaid > 0) _piFee = _chargeFees(_interestToBePaid);

        // Send the payment to safeBox
        if (safeBoxEnabled) asset.safeTransfer(address(safeBox), _amount - _piFee);

        emit Repay(_account, _amount);
    }

    function debt(address _account) external view returns (uint) {
        (,,, uint _amount) = _debt(_account);

        return _amount;
    }

    function debt() external view returns (uint) {
        (,,, uint _amount) = _debt(msg.sender);

        return _amount;
    }

    function totalDebt() external view returns (uint) {
        return dToken.totalSupply() + iToken.totalSupply();
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

        if (_bal <= 0 || _timestamps[_account] <= 0) return 0;

        // Difference between the last interaction and (now or due date)
        uint _timeDiff = block.timestamp;

        if (_timeDiff > dueDate) _timeDiff = dueDate;

        _timeDiff -= _timestamps[_account];

        // Interest is only calculated over the original borrow amount
        // Use all the operations here to prevent _losing_ precision
        return _bal * (interestRate + piFee) * _timeDiff / SECONDS_PER_YEAR / PRECISION;
    }

    function _checkBorrowAmount(uint _amount) internal view {
        uint _available = _oracle().availableCollateralForAsset(msg.sender, address(asset));

        if (_amount > _available) revert InsufficientFunds();
    }

    function _originatorFeeFor(uint _amount) internal view returns (uint) {
        return _amount * originatorFee / PRECISION;
    }

    function _chargeFees(uint _interestAmount) internal returns (uint _fee) {
        uint _originator = remainingOriginatorFee[msg.sender];

        if (_originator > 0) {
            if (_interestAmount >= _originator) {
                // Send to treasury the entire originatorFee and the remaining part
                _fee = _originator + ((_interestAmount - _originator) * piFee / (piFee + interestRate));

                // Clean originatorFee debt
                remainingOriginatorFee[msg.sender] = 0;

                emit CollectedOriginatorFee(_originator);
            } else {
                // Send to treasury the entire interest amount (originator Fee has priority)
                _fee = _interestAmount;

                // Pay part of the originatorFee debt
                remainingOriginatorFee[msg.sender] -= _interestAmount;

                emit CollectedOriginatorFee(_interestAmount);
            }
        } else {
            _fee = _interestAmount * piFee / (piFee + interestRate);
        }

        if (_fee <= 0) return 0;

        asset.safeTransfer(treasury, _fee);

        emit CollectedFee(_fee);
    }

    function _oracle() internal view returns (IOracle) {
        return IOracle(piGlobal.oracle());
    }

    // Balance with primary debt to calculate shares
    function _balanceForSharesCalc() internal view returns (uint) {
        return balance() + dToken.totalSupply() + _safeBalance();
    }

    function _safeBalance() internal view returns (uint) {
        return safeBoxEnabled ? safeBox.balance() : 0;
    }

    function _hasDebtSettler() internal view returns (bool) {
        return address(debtSettler) != address(0);
    }
}
