// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "../../interfaces/ICollateralPool.sol";

contract ContractInteractionMock {
    ICollateralPool public cPool;

    constructor(ICollateralPool _cPool) {
        cPool = _cPool;
    }

    function deposit() external {
        IERC20Metadata _asset = IERC20Metadata(cPool.asset());
        uint _balance = _asset.balanceOf(address(this));

        _asset.approve(address(cPool), _balance);

        cPool.deposit(_balance);
    }

    function deposit2() external {
        cPool.deposit(1000, address(0));
    }

    function mint() external {
        cPool.mint(1000, address(0));
    }

    function withdraw() external {
        cPool.withdraw(1000);
    }

    function withdraw2() external {
        cPool.withdraw(1000, address(0));
    }

    function withdraw3() external {
        cPool.withdraw(1000, address(0), address(0));
    }

    function withdrawAll() external {
        cPool.withdrawAll();
    }

    function redeem() external {
        cPool.redeem(1000, address(0));
    }
}
