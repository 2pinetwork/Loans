// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title LToken
 *
 * @dev LToken represents a liquidity deposit in the liquidity pool.
 */
contract LToken is ERC20, ReentrancyGuard {
    IERC20Metadata public immutable asset;
    address public immutable pool;

    /**
     * @dev Initializes the LToken.
     *
     * @param _asset The asset that the LToken represents.
     */
    constructor(IERC20Metadata _asset, uint _dueDate) ERC20(
        string(abi.encodePacked("2pi Liquidity ", _asset.symbol(), " - ", Strings.toString(_dueDate))),
        string(abi.encodePacked("2pi-L-", _asset.symbol(), "-", Strings.toString(_dueDate)))
    ) {
        asset = _asset;
        pool = msg.sender;
    }

    /**
     * @dev Emitted when a call is made from a non-pool address.
     */
    error NotPool();

    /**
     * @dev Reverts if the caller is not the pool.
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
     * @dev Mints new LTokens.
     *
     * @param _to The address to mint the tokens to.
     * @param _amount The amount to mint.
     */
    function mint(address _to, uint _amount) external onlyPool nonReentrant {
        _mint(_to, _amount);
    }

    /**
     * @dev Burns LTokens.
     *
     * @param _from The address to burn from.
     * @param _amount The amount to burn.
     */
    function burn(address _from, uint _amount) external onlyPool nonReentrant {
        _burn(_from, _amount);
    }
}
