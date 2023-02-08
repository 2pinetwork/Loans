// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";

import {ILPool} from "../interfaces/IPool.sol";

import "hardhat/console.sol";

import "./PiAdmin.sol";
import "../libraries/Errors.sol";

/**
 * @title DebtSettler
 *
 * @notice This contract is used to settle debt when the protocol earns interest.
 *
 * @dev This contract is used to settle debt when the protocol earns interest.
 * It contains the list of borrowers and the amount of credit they have.
 */
contract DebtSettler is PiAdmin {
    using SafeERC20 for IERC20Metadata;
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using EnumerableSet for EnumerableSet.AddressSet;

    ILPool public immutable pool;
    IERC20Metadata public immutable asset;

    // Keep track of the credit for each borrower
    EnumerableMap.AddressToUintMap internal _records;
    // Keep track of borrowers
    EnumerableSet.AddressSet internal _borrowers;

    bytes32 public constant HANDLER_ROLE = keccak256("HANDLER_ROLE");

    uint internal _lastIndexBuilt;
    uint internal _lastCredit;
    uint internal _lastIndexPaid;

    IERC20Metadata internal dToken ;
    IERC20Metadata internal iToken ;
    error InvalidPool();
    error StillBuilding();
    error UnknownSender();

    /**
     * @dev Initialize the contract.
     *
     * @param _pool The liquidity pool address.
     */
    constructor(ILPool _pool) {
        if (address(_pool) == address(0)) revert Errors.ZeroAddress();
        if (_pool.expired()) revert InvalidPool();

        pool = _pool;
        asset = IERC20Metadata(_pool.asset());

        dToken = IERC20Metadata(pool.dToken());
        iToken = IERC20Metadata(pool.iToken());
    }

    /**
     * @dev Modifier to restrict access to the liquidity pool.
     */
    modifier onlyPool() {
        if (msg.sender != address(pool)) revert UnknownSender();
        _;
    }

    /**
     * @dev Modifier to restrict access to the handler.
     */
    modifier onlyHandler() {
        if (! hasRole(HANDLER_ROLE, msg.sender)) revert UnknownSender();
        _;
    }

    /**
     * @dev Build a list of borrowers
     */
    function build() external onlyHandler nonReentrant {
        uint _length = _borrowers.length();

        if (_length == 0) return;

        uint _totalDebt = dToken.totalSupply() + iToken.totalSupply();

        if (_totalDebt == 0) return;

        // will always use first the "last balance snapshot"
        uint _amount = _lastCredit;
        // If there's a new loop we save the current balance
        if (_lastIndexBuilt == 0) _amount = _lastCredit = asset.balanceOf(address(this));

        if (_amount == 0) return;
        if (_amount > _totalDebt) _amount = _lastCredit =  _totalDebt;

        uint i = _lastIndexBuilt == 0 ? 0 : (_lastIndexBuilt + 1);

        console.log("amount, debt, i", _amount, _totalDebt, i);

        for (i; i < _length; i++) {
            address _borrower = _borrowers.at(i);
            uint _credit = _amount * _debt(_borrower) / _totalDebt;
            (, uint _currentCredit) = _records.tryGet(_borrower);

            // we have to accumulate each time =)
            _records.set(_borrower, _credit + _currentCredit);

            // each loop use aprox 80k of gas
            if (gasleft() <= 100_000) {
                _lastIndexBuilt = i;
                // console.log("Salio por el gasLeft", _lastIndexBuilt);
                return;
            }
        }
        console.log("termino bien", _lastIndexBuilt);

        _lastIndexBuilt = 0; // ensure that if ends always starts from 0
    }

    /**
     * @dev Settle the debt to all borrowers registered using the build() function.
     *
     * If for some reason it runs out of gas, it will stop on the last borrower that could be settled.
     */
    function pay() external nonReentrant {
        // Ensure always pay after build is finished
        if (_lastIndexBuilt > 0) revert StillBuilding();

        asset.approve(address(pool), _lastCredit);

        // keep going from last paid
        uint i = _lastIndexPaid == 0 ? 0 : (_lastIndexPaid + 1);

        // just in case the records decrease in size before pay
        if (i > _records.length()) i = _lastIndexPaid = 0;

        for (i; i < _records.length(); i++) {
            console.log("gasLimit: ", i, gasleft());
            // We should check for gasleft here, so we can repay the rest in the next tx if needed
            (address _borrower, uint _credit) = _records.at(i);

            if (_credit > 0) {
                pool.repayFor(_borrower, _credit);
                _records.set(_borrower, 0);
            }

            // each loop use aprox 40k of gas
            if (gasleft() <= 60_000) {
                console.log("Salio el pay por gasLimit", i);
                _lastIndexPaid = i;
                return;
            }
        } // for

        _lastIndexPaid = 0; // ensure that if ends always starts from 0
    }

    /**
     * @dev Clean up the list of borrowers which have no debt left.
     */
    function clean() external nonReentrant {
        address[] memory _toRemove = new address[](_records.length());
        uint _toRemoveLength = 0;

        for (uint i = 0; i < _records.length(); i++) {
            (address _borrower, uint _credit) = _records.at(i);

            if (_credit == 0) _toRemove[_toRemoveLength++] = _borrower;
        }

        for (uint i = 0; i < _toRemoveLength; i++) {
            _records.remove(_toRemove[i]);
        }
    }

    /**
     * @dev Get the number of records in the list (borrowers -> credit).
     *
     * @return The number of records.
     */
    function recordsLength() external view returns (uint) {
        return _records.length();
    }

    /**
     * @dev Add a borrower to the list.
     *
     * @param _borrower The borrower address.
     */
    function addBorrower(address _borrower) external onlyPool nonReentrant {
        _borrowers.add(_borrower);
    }

    /**
     * @dev Remove a borrower from the list.(reentrancy is called from repay
     *
     * @param _borrower The borrower address.
     */
    function removeBorrower(address _borrower) external onlyPool {
        _borrowers.remove(_borrower);
    }

    /**
     * @dev Rescue founds from the contract. Just in case something goes wrong
     * and we need to recover funds. They are sent to the treasury and only
     * works if the list of borrowers is empty.
     */
    function rescueFounds() external nonReentrant {
        uint _balance = asset.balanceOf(address(this));

        if (_borrowers.length() == 0 && _balance > 0) {
            asset.safeTransfer(pool.treasury(), _balance);
        }
    }

    function _debt(address _borrower) internal view returns (uint) {
        return dToken.balanceOf(_borrower) + iToken.balanceOf(_borrower);
    }
}
