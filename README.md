# 2PI Network loans

Try running some of the following tasks:

```shell
yarn test
yarn coverage
```

# Collateral Pool
Pool used to deposit assets to accomplish 2 main things:
- Be used as collateral to borrow other assets
    - Collateral ratio to be used is defined per pool/asset
- Generate yield (independently of collateral/borrow use)
    - the interest can be autocompounded in the same yield to ingress the yield
    - the interest can be use to auto-repay the debt

Details:
- Collateral ratio can be set & changed
- Can be used only with one asset (defined at deploy time)
- Deposits can be limited per user & per pool
- Withdrawal fee can be defined (max 1%)
- Can be used with or without an underlying strategy to generate yield

On each deposit it returns a share token "2pi-C-assetSymbol" and it's burned on each withdrawal.
> Note: The yield can't be chosen to auto-repay debt and to be autocompounded at the same time it do one or the other.

# Liquidity Pool
Pool used to provide liquidity for borrowers. Liquidity to be borrowed is independent from Collateral pool.

Details:
- The due date of the pool is defined at deploy time.
- The interest rate and origination fee can be configured only when no-one has a debt.
- The repayment can be moved to a "safeBox" to not be borrowed again.

On each deposit it returns a share token "2pi-L-assetSymbol" and burned on each withdrawal.

### Borrowing process
Depending on the amount of collateral deposited (and its usage ratio) the user can borrow assets.
On each borrow LiquidityPool mint debt tokens [2pi-D-assetSymbol] (for original debt & a different for interest to be paid).
Then on each repay (or liquidation) the interest tokens are burned first and then the "original debt tokens". So the pool always pays the interest first and then the origianl debt (that is because it's a linear loan over time).

> Note: the interest tokens are not minted all the time, only happens when the user interacts with the contract (borrow/repay/liquidation) in other case the debt is calculated.
> Note2: Borrowing process will always happen until the user reaches less than 1.0 HF.

# Oracle
It has all the token feeds to get token price in USD (used to check collateral/borrowed assets normalized in USD).
It's used to get/check the HealthFactor(HF) and the LiquidationThreshold(LT) to let a user withdraw, borrow or be liquidated.

# PiGlobal
It has the available collateral and liquidity pools to be used/checked on each withdraw/borrow/liquidation process, as well as the oracle contract to be used along the protocol.

## Liquidations
Liquidations will happened if the HealthFactor(HF) is under the Oracle.LiquidationThreshold and the amount of collateral liquidated will be the needed amount to increase the HF near the Oracle.liquidationExpectedHF.

# Other Contracts
- Controller: CollateralPool uses the Controller to mint/burn tokens, limit deposits and to use (or not) a strategy to generate yield.
- LToken: LiquidityPool uses it to mint/burn tokens for liquidity providers
- DToken: LiquidityPool uses it to mint/burn debt
- DebtSettler: Used to be the "payer" between the strategy harvest (yield) and the LiquidityPool in the auto-repay process
- SafeBox: LiquidityPool use it as a "safe box" in the repay process to put the repayment funds there instead of leaving it in the pool to be borrowed again.

### Other notes
- CollateralPool.paused is used to halt the withdrawal process (the deposit process can be halted changing the Controller.depositLimit to 1)
- LiquidityPool.paused is only used to halt borrow process

### Simple Flow:
![SimpleFlow](/extras/simple-flow.jpg)
