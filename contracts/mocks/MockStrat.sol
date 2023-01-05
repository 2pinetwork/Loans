// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "hardhat/console.sol";

contract MockStrat {
    IERC20 public want;
    bool public paused;

    bool private notRetire = false;

    constructor(address _want) { want = IERC20(_want); }

    function balance() public view returns (uint) {
        return want.balanceOf(address(this));
    }

    function retireStrat() external {
        if (!notRetire && balance() > 0) want.transfer(msg.sender, balance());
    }

    function beforeMovement() external { }
    function deposit() external { }
    function withdraw(uint _amount) external returns (uint) {
        if (notRetire) return 0;

        uint _bal = balance();

        if (_bal < _amount) _amount = _bal;

        want.transfer(msg.sender, _amount);
        return _amount;
    }

    function pause(bool _s) external { paused = _s; }
    function breakRetire(bool _s) external { notRetire = _s; }

}
