// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract CToken is ERC20 {
    IERC20Metadata public immutable asset;
    address public immutable pool;

    constructor(IERC20Metadata _asset) ERC20(
        string(abi.encodePacked("2pi Collateral ", _asset.symbol())),
        string(abi.encodePacked("2pi-C-", _asset.symbol()))
    ) {
        asset = _asset;
        pool = msg.sender; // creator
    }

    modifier onlyPool() {
        require(msg.sender == pool, "!Pool");
        _;
    }

    function decimals() public view override returns (uint8) {
        return asset.decimals();
    }

    function mint(address _to, uint _amount) external onlyPool {
        _mint(_to, _amount);
    }

    function burn(address _from, uint _amount) external onlyPool {
        _burn(_from, _amount);
    }
}
