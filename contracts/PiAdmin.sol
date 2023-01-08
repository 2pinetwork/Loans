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
    /**
     * @dev Throws if caller is not an admin.
     */
    error NotAdmin();

    constructor() {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @dev Modifier to check if the caller is an admin.
     */
    modifier onlyAdmin() {
        if (! hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        _;
    }
}
