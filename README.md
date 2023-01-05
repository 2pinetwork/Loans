# 2PI Network loans

Try running some of the following tasks:

```shell
npx hardhat help
npx hardhat test
GAS_REPORT=true npx hardhat test
npx hardhat node
npx hardhat run scripts/deploy.js
```


=== Notes for future docs
- CollateralPool.paused is used to halt the withdraw process (the deposit process can be halted changing the Controller.depositLimit to 1)
- LiquidityPool.paused is only used to halt borrow process
-- Repay process should always work
-- deposit/withdraw from liquidity providers should always work as well
