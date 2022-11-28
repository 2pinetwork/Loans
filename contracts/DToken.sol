// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract DToken is ERC20 {
    IERC20Metadata public immutable asset;
    address public immutable pool;

    constructor(IERC20Metadata _asset) ERC20(
        string(abi.encodePacked("2pi Debt ", _asset.symbol())),
        string(abi.encodePacked("2pi-D-", _asset.symbol()))
    ) {
        asset = _asset;
        pool = msg.sender;
    }

    error TransferNotSupported();

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

    /**
     * @dev Being non transferrable, the debt token does not implement any of the
     * standard ERC20 functions for transfer and allowance.
     **/
    function transfer(address /* recipient */, uint256 /* amount */) public virtual override returns (bool) {
        revert TransferNotSupported();
    }

    function transferFrom(address /* from */, address /* recipient */, uint256 /* amount */) public virtual override returns (bool) {
        revert TransferNotSupported();
    }
}
