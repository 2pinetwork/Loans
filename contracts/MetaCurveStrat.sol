// SPDX-License-Identifier: MIT

pragma solidity 0.8.17;

import "./StratAbs.sol";
import "../interfaces/ICurve.sol";

interface IUniswapV3 {
  struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another along the specified path
    /// @param params The parameters necessary for the multi-hop swap, encoded as `ExactInputParams` in calldata
    /// @return amountOut The amount of the received token
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

contract MetaCurveStrat is StratAbs {
    using SafeERC20 for IERC20;
    using SafeERC20 for IERC20Metadata;

    IERC20Metadata public immutable crvToken;
    address public immutable metaPool;
    address public immutable pool;
    ICurveGauge public immutable gauge;
    ICurveGaugeFactory public immutable gaugeFactory;

    int128 private immutable poolSize;
    int128 private immutable tokenIndex; // want token index on the pool

    uint8 private immutable gaugeType;
    uint8 private constant GAUGE_TYPE_STAKING = 0;
    uint8 private constant GAUGE_TYPE_CHILD_STAKING = 1;

    // UniswapV3 has different fees between each pool (Commonly is 0.3% but can be 0.1% or 1%
    mapping(address => mapping(address => uint24)) public tokenToTokenSwapFee;

    error PoolSizeZero();
    error InvalidIndex();

    constructor(
        IERC20Metadata _want,
        address _controller,
        address _exchange,
        address _treasury,
        IERC20Metadata _crvToken,
        address _pool,
        address _metaPool,
        ICurveGauge _gauge,
        ICurveGaugeFactory _gaugeFactory,
        uint8 _gaugeType,
        int128 _poolSize,
        int128 _tokenIndex
    ) StratAbs(_want, _controller, _exchange, _treasury) {
        require(_pool != address(0), "pool !ZeroAddress");
        require(_metaPool != address(0), "metaPool !ZeroAddress");
        require(address(_gauge) != address(0), "gauge !ZeroAddress");
        require(address(_gaugeFactory) != address(0), "gaugeFactory !ZeroAddress");
        require(_gaugeType < 2, "gaugeType unknown");

        _checkIERC20(_crvToken, "Invalid crvToken");
        // Check gauge _behaves_ as a gauge
        _gauge.claimable_tokens(address(this));
        // Check gauge factory _behaves_ as a gauge factory
        _gaugeFactory.minted(address(this), address(this));

        // poolSize = ICurvePool(_pool).N_ALL_COINS();
        if (_poolSize <= 0) { revert PoolSizeZero(); }

        poolSize     = _poolSize;
        crvToken     = _crvToken;
        pool         = _pool;
        metaPool     = _metaPool;
        gauge        = _gauge;
        gaugeFactory = _gaugeFactory;
        gaugeType    = _gaugeType;
        tokenIndex   = _tokenIndex;
    }

    function identifier() external view returns (string memory) {
        return string(abi.encodePacked(want.symbol(), "@Curve#1.0.0"));
    }

    function wantCRVBalance() public view returns (uint) {
        return crvToken.balanceOf(address(this));
    }

    function balanceOfPool() public view override returns (uint) {
        return gauge.balanceOf(address(this));
    }

    function balanceOfPoolInWant() public view override returns (uint) {
        return _calcWithdrawOneCoin(balanceOfPool());
    }

    function setTokenToTokenSwapFee(address _tokenA, address _tokenB, uint24 _fee) external onlyAdmin {
        require(_tokenA != address(0), "!ZeroAddress tokenA");
        require(_tokenB != address(0), "!ZeroAddress tokenB");
        require(_fee >= 0, "Fee can't be negative");

        tokenToTokenSwapFee[_tokenA][_tokenB] = _fee;
    }

    function _deposit() internal override {
        uint _wantBal = wantBalance();

        if (_wantBal > 0) { _addLiquidity(_wantBal); }

        uint _wantCRVBalance = wantCRVBalance();

        if (_wantCRVBalance > 0) {
            crvToken.safeApprove(address(gauge), _wantCRVBalance);
            gauge.deposit(_wantCRVBalance);
        }
    }

    function _addLiquidity(uint _wantBal) internal {
        uint _expected = _wantToWantCrvDoubleCheck(_wantBal, true);

        if (poolSize == 2) {
            uint[2] memory _amounts;

            _amounts[uint(uint128(tokenIndex))] = _wantBal;

            want.safeApprove(pool, _wantBal);
            ICurvePool(pool).add_liquidity(metaPool, _amounts, _expected, true);
        } else if (poolSize == 4) {
            uint[4] memory _amounts;

            _amounts[uint(uint128(tokenIndex))] = _wantBal;

            want.safeApprove(pool, _wantBal);
            ICurvePool(pool).add_liquidity(metaPool, _amounts, _expected);
        }
    }

    function _withdraw(uint _amount) internal override returns (uint) {
        uint _balance = wantBalance();

        _withdrawFromPool(
            _wantToWantCrvDoubleCheck(_amount - _balance, false)
        );

        uint _withdrawn = wantBalance() - _balance;

        return (_withdrawn > _amount) ? _amount : _withdrawn;
    }

    function _withdrawAll() internal override returns (uint) {
        uint _balance = wantBalance();

        _withdrawFromPool(balanceOfPool());

        return wantBalance() - _balance;
    }

    function _withdrawFromPool(uint _wantCrvAmount) internal override {
        // Remove staked from gauge
        gauge.withdraw(_wantCrvAmount);

        // remove_liquidity
        uint _balance = wantCRVBalance();
        uint _expected = _wantCrvToWantDoubleCheck(_balance);

        require(_expected > 0, "remove_liquidity expected = 0");

        crvToken.safeApprove(pool, _balance);
        ICurvePool(pool).remove_liquidity_one_coin(metaPool, _balance, tokenIndex, _expected);
    }

    function _claimRewards() internal override {
        // CRV rewards
        if (gauge.claimable_tokens(address(this)) > 0) {
            gaugeFactory.mint(address(gauge));
        }

        // no-CRV rewards
        bool _claim = false;

        if (gaugeType == GAUGE_TYPE_STAKING) {
            if (gauge.claimable_reward(address(this)) > 0) {
                _claim = true;
            }
        } else if (gaugeType == GAUGE_TYPE_CHILD_STAKING) {
            for (uint i = 0; i < gauge.reward_count(); i++) {
                address _reward = gauge.reward_tokens(i);

                if (gauge.claimable_reward(address(this), _reward) > 0) {
                    _claim = true;
                    break;
                }
            }
        }

        if (_claim) { gauge.claim_rewards(); }
    }

    function _balanceOfPoolToWant(uint _amount) internal view override returns (uint) {
        return _calcWithdrawOneCoin(_amount);
    }

    function _minWantToWantCrv(uint _amount) internal view returns (uint) {
        // Based on virtual_price (poolMinVirtualPrice) and poolSlippageRatio
        // the expected amount is represented with 18 decimals as crvWant token
        // so we have to add 12 decimals (on USDC and USDT for example) to the want balance.
        // E.g. 1e6 (1WANT) * 1e12 * 99.4 / 100.0 => 0.994e18 crvToken tokens
        return _amount * WANT_MISSING_PRECISION * (RATIO_PRECISION - poolSlippageRatio - poolMinVirtualPrice) / RATIO_PRECISION;
    }

    function _wantToWantCrvDoubleCheck(uint _amount, bool _isDeposit) internal view returns (uint _wantCrvAmount) {
        if (poolSize == 2) {
            uint[2] memory _amounts;

            _amounts[uint(uint128(tokenIndex))] = _amount;
            // calc_token_amount doesn't consider fee
            _wantCrvAmount = ICurvePool(pool).calc_token_amount(metaPool, _amounts, _isDeposit);
        } else if (poolSize == 4) {
            uint[4] memory _amounts;

            _amounts[uint(uint128(tokenIndex))] = _amount;
            // calc_token_amount doesn't consider fee
            _wantCrvAmount = ICurvePool(pool).calc_token_amount(metaPool, _amounts, _isDeposit);
        }

        // Remove max fee
        _wantCrvAmount = _wantCrvAmount * (RATIO_PRECISION - poolSlippageRatio) / RATIO_PRECISION;

        // In case the pool is unbalanced (attack), make a double check for
        // the expected amount with minExpected set ratios.
        uint _wantToWantCrv = _minWantToWantCrv(_amount);

        if (_wantToWantCrv > _wantCrvAmount) { _wantCrvAmount = _wantToWantCrv; }
    }

    // Calculate at least xx% of the expected. The function doesn't
    // consider the fee.
    function _wantCrvToWantDoubleCheck(uint _balance) internal view returns (uint _expected) {
        _expected = (
            _calcWithdrawOneCoin(_balance) * (RATIO_PRECISION - poolSlippageRatio)
        ) / RATIO_PRECISION;

        // Double check for expected value
        // In this case we sum the poolMinVirtualPrice and divide by
        // (for example) 1e12 because we want to swap crvToken => WANT
        uint _minExpected = _balance *
            (RATIO_PRECISION + poolMinVirtualPrice - poolSlippageRatio) /
            RATIO_PRECISION /
            WANT_MISSING_PRECISION;

        if (_minExpected > _expected) { _expected = _minExpected; }
    }

    function _calcWithdrawOneCoin(uint _amount) internal view returns (uint) {
        if (_amount > 0) {
            return ICurvePool(pool).calc_withdraw_one_coin(metaPool, _amount, tokenIndex);
        } else {
            return 0;
        }
    }

    // UniswapV3
    function _swapRewards() internal override {
        for (uint i = 0; i < rewardTokens.length; i++) {
            address rewardToken = rewardTokens[i];
            uint _balance = IERC20Metadata(rewardToken).balanceOf(address(this));

            if (_balance > 0) {
                uint expected = _expectedForSwap(_balance, rewardToken, address(want));

                // Want price sometimes is too high so it requires a lot of rewards to swap
                if (expected > 1) {
                    IERC20Metadata(rewardToken).safeApprove(exchange, _balance);

                    bytes memory _path = abi.encodePacked(rewardToken);

                    for (uint j = 1; j < rewardToWantRoute[rewardToken].length; j++) {
                        uint24 _fee = tokenToTokenSwapFee[rewardToWantRoute[rewardToken][j - 1]][rewardToWantRoute[rewardToken][j]];

                        _path = abi.encodePacked(
                            _path,
                            _fee,
                            rewardToWantRoute[rewardToken][j]
                        );
                    }

                    IUniswapV3(exchange).exactInput(IUniswapV3.ExactInputParams({
                        path: _path,
                        recipient: address(this),
                        deadline: block.timestamp + 60,
                        amountIn: _balance,
                        amountOutMinimum: expected
                    }));
                }
            }
        }
    }
}
