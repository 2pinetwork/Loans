// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

library Errors {
    error SameValue();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares();
    // string is the identifier of a var/constant/method compared
    error GreaterThan(string);
    error LessThan(string);
}
