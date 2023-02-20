// SPDX-License-Identifier: MIT

pragma solidity 0.8.17;

interface ICurvePool {
    // _use_underlying If True, withdraw underlying assets instead of aTokens
    function add_liquidity(uint[2] calldata amounts, uint min_mint_amount, bool _use_underlying) external;
    function add_liquidity(uint[2] calldata amounts, uint min_mint_amount) external payable;
    function add_liquidity(address _pool, uint[2] calldata amounts, uint min_mint_amount, bool _use_underlying) external;
    function add_liquidity(address _pool, uint[2] calldata amounts, uint min_mint_amount) external;
    function add_liquidity(uint[4] calldata amounts, uint min_mint_amount, bool _use_underlying) external;
    function add_liquidity(uint[4] calldata amounts, uint min_mint_amount) external;
    function add_liquidity(address _pool, uint[4] calldata amounts, uint min_mint_amount, bool _use_underlying) external;
    function add_liquidity(address _pool, uint[4] calldata amounts, uint min_mint_amount) external;
    function remove_liquidity_one_coin(uint _token_amount, int128 i, uint _min_amount) external returns (uint);
    function remove_liquidity_one_coin(uint _token_amount, int128 i, uint _min_amount, bool _use_underlying) external;
    function remove_liquidity_one_coin(address _pool, uint _token_amount, int128 i, uint _min_amount) external returns (uint);
    function remove_liquidity_one_coin(address _pool, uint _token_amount, int128 i, uint _min_amount, bool _use_underlying) external;
    function calc_withdraw_one_coin(uint _token_amount, int128 i) external view returns (uint);
    function calc_withdraw_one_coin(address _pool, uint _token_amount, int128 i) external view returns (uint);
    function calc_token_amount(uint[2] calldata _amounts, bool is_deposit) external view returns (uint);
    function calc_token_amount(uint[4] calldata _amounts, bool is_deposit) external view returns (uint);
    function calc_token_amount(address _pool, uint[2] calldata _amounts, bool is_deposit) external view returns (uint);
    function calc_token_amount(address _pool, uint[4] calldata _amounts, bool is_deposit) external view returns (uint);
    function underlying_coins(int128 i) external view returns (address);
    function underlying_coins(uint256 i) external view returns (address);
}

interface ICurveGauge {
    // This function should be view but it's not defined as view...
    function claimable_tokens(address) external returns (uint);
    function claimable_reward(address _user) external view returns (uint);
    function claimable_reward(address _user, address _reward) external view returns (uint);
    function reward_count() external view returns (uint);
    function reward_tokens(uint) external view returns (address);
    function balanceOf(address account) external view returns (uint);

    function claim_rewards() external;
    function deposit(uint _value) external;
    function withdraw(uint _value) external;
}

interface ICurveGaugeFactory {
    function mint(address _gauge) external;
    function minted(address _arg0, address _arg1) external returns (uint256);
}
