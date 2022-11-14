// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";

abstract contract PiAdmin is AccessControl {
    error NotAdmin();

    constructor() {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    modifier onlyAdmin() {
        if (! hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        _;
    }
}
