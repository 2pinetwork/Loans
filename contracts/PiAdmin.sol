// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title PiAdmin
 *
 * @dev This contract is used to check if the caller is an admin.
 */
abstract contract PiAdmin is AccessControl, ReentrancyGuard {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /**
     * @dev Throws if caller is not an admin.
     */
    error NotAdmin();

    /**
     * @dev Throws if caller is not a pauser.
     */
    error NotPauser();

    constructor() {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    /**
     * @dev Modifier to check if the caller is an admin.
     */
    modifier onlyAdmin() {
        if (! hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        _;
    }

    /**
     * @dev Modifier to check if the caller is a pauser.
     */
    modifier onlyPauser() {
        if (! hasRole(PAUSER_ROLE, msg.sender)) revert NotPauser();
        _;
    }
}
