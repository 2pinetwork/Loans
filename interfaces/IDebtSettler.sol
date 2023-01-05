// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IDebtSettler {
    function addBorrower(address) external;
    function removeBorrower(address) external;
    function build(uint) external;
}
