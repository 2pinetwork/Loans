// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title DToken
 *
 * @dev This token represents the user's debt to the protocol.
 */
contract DToken is ERC20, ReentrancyGuard {
    IERC20Metadata public immutable asset;
    address public immutable pool;

    /**
     * @dev Initializes the contract.
     *
     * @param _asset The address of the underlying asset.
     */
    constructor(IERC20Metadata _asset) ERC20(
        string(abi.encodePacked("2pi Debt ", _asset.symbol())),
        string(abi.encodePacked("2pi-D-", _asset.symbol()))
    ) {
        asset = _asset;
        pool = msg.sender;
    }

    /**
     * @dev Throws if called by any account other than the pool.
     */
    error NotPool();

    /**
     * @dev Throws if any transfer is attempted.
     */
    error TransferNotSupported();

    /**
     * @dev Modifier to make a function callable only by the pool.
     */
    modifier onlyPool() {
        if (msg.sender != pool) revert NotPool();
        _;
    }

    /**
     * @dev Returns the number of decimals of the underlying asset.
     *
     * @return The number of decimals.
     */
    function decimals() public view override returns (uint8) {
        return asset.decimals();
    }

    /**
     * @dev Mints new debt tokens.
     *
     * @param _to The address of the recipient.
     * @param _amount The amount of debt tokens to mint.
     */
    function mint(address _to, uint _amount) external onlyPool nonReentrant {
        _mint(_to, _amount);
    }

    /**
     * @dev Burns debt tokens.
     *
     * @param _from The address of the owner.
     * @param _amount The amount of debt tokens to burn.
     */
    function burn(address _from, uint _amount) external onlyPool nonReentrant {
        _burn(_from, _amount);
    }

    /**
     * @dev Being non transferable, the debt token does not implement any of the
     * standard ERC20 functions for transfer and allowance.
     **/
    function transfer(address /* recipient */, uint256 /* amount */) public virtual override returns (bool) {
        revert TransferNotSupported();
    }

    /**
     * @dev Being non transferable, the debt token does not implement any of the
     * standard ERC20 functions for transfer and allowance.
     **/
    function transferFrom(address /* from */, address /* recipient */, uint256 /* amount */) public virtual override returns (bool) {
        revert TransferNotSupported();
    }
}
