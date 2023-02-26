const {
  createCPool,
  createOracles,
  deploy,
  mine,
  resetHardhat,
  setChainlinkRoundForNow,
  setCustomBalanceFor,
  waitFor,
} = require('../helpers')

const changeExchangeRate = async function () {
  const holder  = (await ethers.getSigners())[17]
  const mToken  = await ethers.getContractAt('IMToken', '0xE840B73E5287865EEc17d250bFb1536704B43B21', holder)
  const imToken = await ethers.getContractAt('IIMToken', '0x5290Ad3d83476CA6A2b178Cd9727eE1EF72432af', holder)
  const imVault = await ethers.getContractAt('IMVault', '0x32aBa856Dc5fFd5A56Bcd182b13380e5C855aa29', holder)


  const newBalance = ethers.BigNumber.from('' + 10e6) // 1000 USDC
  await setCustomBalanceFor(USDC.address, holder.address, newBalance)

  await waitFor(USDC.connect(holder).approve(mToken.address, newBalance))
  await waitFor(mToken.mint(USDC.address, newBalance, 1, holder.address))

  const mBalance = await mToken.balanceOf(holder.address)

  await waitFor(mToken.approve(imToken.address, mBalance))

  await waitFor(imToken.depositSavings(mBalance))
  const credits = await imToken.balanceOf(holder.address)

  await waitFor(imToken.approve(imVault.address, credits))
  await waitFor(imVault.stake(credits))
}

describe('mStable Strat', function () {
  let cPool
  let controller
  let strat
  let REWARD_TOKEN

  let stratCallback

  beforeEach(async function () {
    await resetHardhat(26121479); // https://polygonscan.com/tx/0x765753c4dad28a8ac51912cf3c9d8192fce86ed90ad3a056a982811d6b24af2a

    REWARD_TOKEN = await ethers.getContractAt('IERC20Metadata', '0xF501dd45a1198C2E1b5aEF5314A68B9006D842E0') // MTA (Meta)

    const deployed = await createCPool(USDC, 'MStableStrat')

    cPool = deployed.cPool
    controller = deployed.cToken
    strat = deployed.strategy;

    let tokensData = {
      [REWARD_TOKEN.address]: { price: 0.425 }
    }

    await createOracles(tokensData);

    stratCallback = async function (strategy) {
      await Promise.all([
        waitFor(strategy.setMaxPriceOffset(86400)),
        waitFor(strategy.setPoolSlippageRatio(50)), // 0.5%
        waitFor(strategy.setSwapSlippageRatio(150)), // 1.5%
        waitFor(strategy.setPriceFeed(USDC.address, usdcFeed.address)),
        waitFor(strategy.setPriceFeed(REWARD_TOKEN.address, tokensData[REWARD_TOKEN.address].oracle.address)),
        waitFor(strategy.setRewardToWantRoute(REWARD_TOKEN.address, [REWARD_TOKEN.address, DAI.address, USDC.address])),
      ])
    }

    await Promise.all([
      setChainlinkRoundForNow(usdcFeed),
      stratCallback(strat),
    ])
  })

  it('Full deposit + harvest strat + withdraw', async function () {
    const newBalance = ethers.BigNumber.from('' + 100000e6) // 100000 USDC
    await setCustomBalanceFor(USDC.address, bob.address, newBalance)

    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(USDC.connect(bob).approve(cPool.address, '' + 100000e6))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await USDC.balanceOf(bob.address)))

    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    const balance = await strat.balanceOfPool() // more decimals

    await changeExchangeRate()

    await mine(100)

    const treasuryBalance = await USDC.balanceOf(owner.address)
    await expect(strat.harvest()).to.emit(strat, 'Harvested').to.emit(strat, 'PerformanceFee')
    expect(await USDC.balanceOf(owner.address)).to.be.above(treasuryBalance)

    expect(await strat.balanceOfPool()).to.be.above(balance)

    // withdraw 9500 USDC in shares
    const toWithdraw = (
      (await controller.totalSupply()).mul(95000e6 + '').div(
        await controller.balance()
      )
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await USDC.balanceOf(bob.address)).to.within(
      94900e6 + '', 95000e6 + '' // 9500 - 0.1% withdrawFee
    )
    expect(await USDC.balanceOf(strat.address)).to.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await USDC.balanceOf(bob.address)).to.within(
      99800e6 + '', // between 0.1%
      100100e6 + ''
    )
  })

  it('Full deposit with compensation + harvest strat + withdraw', async function () {
    const newBalance = ethers.BigNumber.from('' + 100000e6) // 100000 USDC
    await setCustomBalanceFor(USDC.address, bob.address, newBalance)
    await setCustomBalanceFor(USDC.address, owner.address, newBalance)

    await waitFor(USDC.connect(owner).approve(strat.address, newBalance))

    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(USDC.connect(bob).approve(cPool.address, '' + 100000e6))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await USDC.balanceOf(bob.address)))

    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    const balance = await strat.balanceOfPool() // more decimals

    await changeExchangeRate()

    await mine(100)

    const treasuryBalance = await USDC.balanceOf(owner.address)
    await expect(strat.harvest()).to.emit(strat, 'Harvested').to.emit(strat, 'PerformanceFee')
    expect(await USDC.balanceOf(owner.address)).to.be.above(treasuryBalance)

    expect(await strat.balanceOfPool()).to.be.above(balance)

    // withdraw 9500 USDC in shares
    const toWithdraw = (
      (await controller.totalSupply()).mul(95000e6 + '').div(
        await controller.balance()
      )
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await USDC.balanceOf(bob.address)).to.within(
      94900e6 + '', 95000e6 + '' // 9500 - 0.1% withdrawFee
    )
    expect(await USDC.balanceOf(strat.address)).to.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await USDC.balanceOf(bob.address)).to.within(
      99001e6 + '', // between 0.1% and 0.01%
      99999e6 + ''
    )
  })

  it('Controller.setStrategy works', async function () {
    const newBalance = ethers.BigNumber.from('' + 100000e6) // 100000 USDC
    await setCustomBalanceFor(USDC.address, bob.address, newBalance)

    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(USDC.connect(bob).approve(cPool.address, '' + 100000e6))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await USDC.balanceOf(bob.address)))

    expect(await controller.balanceOf(bob.address)).to.be.equal('' + 100000e6)
    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    const otherStrat = await deploy(
      'MStableStrat',
      USDC.address,
      controller.address,
      global.exchange.address,
      owner.address
    )

    await stratCallback(otherStrat)

    await mine(5)

    await expect(controller.setStrategy(otherStrat.address)).to.emit(
      controller, 'StrategyChanged'
    ).withArgs(strat.address, otherStrat.address)

    expect(await controller.balanceOf(bob.address)).to.be.equal('' + 100000e6)
    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(strat.unpause())

    await expect(controller.setStrategy(strat.address)).to.emit(
      controller, 'StrategyChanged'
    ).withArgs(otherStrat.address, strat.address)

    expect(await controller.balanceOf(bob.address)).to.be.equal('' + 100000e6)
    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)
  })

  it('boost should revert for unknown user', async function () {
    const booster = (await ethers.getSigners())[8]
    await expect(strat.connect(booster).boost(1e6)).to.be.revertedWith('Not a booster')
    expect(await strat.lastExternalBoost()).to.be.equal(0)
  })

  it('Deposit with compensation + manual reward', async function () {
    // give booster permissions
    const booster = (await ethers.getSigners())[8]
    const equalizer = (await ethers.getSigners())[9]
    await waitFor(strat.grantRole(await strat.BOOSTER_ROLE(), booster.address))

    const newBalance = ethers.BigNumber.from('' + 100000e6) // 100000 USDC
    await setCustomBalanceFor(USDC.address, bob.address, newBalance)
    await setCustomBalanceFor(USDC.address, equalizer.address, newBalance)
    await setCustomBalanceFor(USDC.address, booster.address, newBalance)

    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(USDC.connect(bob).approve(cPool.address, newBalance))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await USDC.balanceOf(bob.address)))

    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    let balance = await strat.balance()
    let treasuryBalance = await USDC.balanceOf(owner.address)
    let boosterBalance = await USDC.balanceOf(booster.address)

    await waitFor(USDC.connect(booster).approve(strat.address, newBalance))
    await waitFor(strat.connect(booster).boost(1e6))
    expect(await strat.lastExternalBoost()).to.be.equal(1e6)
    // treasury shouldn't change
    expect(await USDC.balanceOf(owner.address)).to.be.equal(treasuryBalance)
    expect(await USDC.balanceOf(booster.address)).to.be.equal(boosterBalance.sub(1e6))

    expect(await strat.balance()).to.be.within(
      balance.add(0.99e6), balance.add(1.01e6)
    )

    balance = await strat.balance()
    treasuryBalance = await USDC.balanceOf(owner.address)
    boosterBalance = await USDC.balanceOf(booster.address)

    // compensate
    await waitFor(USDC.connect(owner).approve(strat.address, newBalance))
    await waitFor(USDC.connect(equalizer).approve(strat.address, newBalance))
    await waitFor(strat.setEqualizer(equalizer.address))

    await waitFor(strat.connect(booster).boost(1e6))
    expect(await strat.lastExternalBoost()).to.be.equal(1e6)
    expect(await USDC.balanceOf(owner.address)).to.be.equal(treasuryBalance)
    expect(await USDC.balanceOf(booster.address)).to.be.equal(boosterBalance.sub(1e6))
    expect(await strat.balance()).to.be.within(
      balance.add(1.0001e6), balance.add(1.01e6)
    )
  })

  it('should revert if not whitelisted', async function () {
    expect(await cPool.whitelistEnabled()).to.be.equal(false)

    await waitFor(cPool.setWhitelistEnabled(true))

    expect(await cPool.whitelistEnabled()).to.be.equal(true)

    await expect(cPool.connect(bob)['deposit(uint256)'](1)).to.be.revertedWithCustomError(cPool, 'NotWhitelisted')
  })

 it('Full deposit + harvest strat + withdraw for whitelisted user', async function () {
    await cPool.setWhitelistEnabled(true)
    await cPool.setWhitelisted(bob.address, true)

    const newBalance = ethers.BigNumber.from('' + 100000e6) // 100000 USDC
    await setCustomBalanceFor(USDC.address, bob.address, newBalance)

    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(USDC.connect(bob).approve(cPool.address, '' + 100000e6))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await USDC.balanceOf(bob.address)))

    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    const balance = await strat.balanceOfPool() // more decimals

    await changeExchangeRate()

    await mine(100)

    const treasuryBalance = await USDC.balanceOf(owner.address)
    await expect(strat.harvest()).to.emit(strat, 'Harvested').to.emit(strat, 'PerformanceFee')
    expect(await USDC.balanceOf(owner.address)).to.be.above(treasuryBalance)

    expect(await strat.balanceOfPool()).to.be.above(balance)

    // withdraw 9500 USDC in shares
    const toWithdraw = (
      (await controller.totalSupply()).mul(95000e6 + '').div(
        await controller.balance()
      )
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await USDC.balanceOf(bob.address)).to.within(
      94900e6 + '', 95000e6 + '' // 9500 - 0.1% withdrawFee
    )
    expect(await USDC.balanceOf(strat.address)).to.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await cPool.setWhitelisted(bob.address, false)

    await expect(cPool.connect(bob).withdrawAll()).to.be.revertedWithCustomError(cPool, 'NotWhitelisted')

    expect(await USDC.balanceOf(bob.address)).to.within(
      94900e6 + '', 95000e6 + '' // 9500 - 0.1% withdrawFee
    )
    expect(await USDC.balanceOf(strat.address)).to.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await cPool.setWhitelisted(bob.address, true)

    await expect(cPool.connect(bob).withdrawAll()).to.emit(cPool, 'Withdraw')
    expect(await USDC.balanceOf(bob.address)).to.within(
      99800e6 + '', // between 0.1%
      100100e6 + ''
    )
  })
})

describe('mStable Strat with DAI', function () {
  let cPool
  let controller
  let strat
  let REWARD_TOKEN

  let stratCallback

  beforeEach(async function () {
    await resetHardhat(26121479); // https://polygonscan.com/tx/0x765753c4dad28a8ac51912cf3c9d8192fce86ed90ad3a056a982811d6b24af2a

    REWARD_TOKEN = await ethers.getContractAt('IERC20Metadata', '0xF501dd45a1198C2E1b5aEF5314A68B9006D842E0') // MTA (Meta)

    const deployed = await createCPool(DAI, 'MStableStrat')

    cPool = deployed.cPool
    controller = deployed.cToken
    strat = deployed.strategy;

    let tokensData = {
      [REWARD_TOKEN.address]: { price: 0.425 }
    }

    await createOracles(tokensData);

    stratCallback = async function (strategy) {
      await Promise.all([
        waitFor(strategy.setMaxPriceOffset(86400)),
        waitFor(strategy.setPoolSlippageRatio(50)), // 0.5%
        waitFor(strategy.setSwapSlippageRatio(150)), // 1.5%
        waitFor(strategy.setPriceFeed(DAI.address, daiFeed.address)),
        waitFor(strategy.setPriceFeed(REWARD_TOKEN.address, tokensData[REWARD_TOKEN.address].oracle.address)),
        waitFor(strategy.setRewardToWantRoute(REWARD_TOKEN.address, [REWARD_TOKEN.address, DAI.address])),
      ])
    }

    await Promise.all([
      setChainlinkRoundForNow(daiFeed),
      stratCallback(strat),
    ])
  })

  it('Full deposit + harvest strat + withdraw', async function () {
    const newBalance = ethers.BigNumber.from('' + 1e18).mul(10000) // 100000 DAI
    await setCustomBalanceFor(DAI.address, bob.address, newBalance)

    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(DAI.connect(bob).approve(cPool.address, newBalance))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await DAI.balanceOf(bob.address)))

    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    const balance = await strat.balanceOfPool() // more decimals

    await changeExchangeRate()

    await mine(100)

    const treasuryBalance = await DAI.balanceOf(owner.address)
    await expect(strat.harvest()).to.emit(strat, 'Harvested').to.emit(strat, 'PerformanceFee')
    expect(await DAI.balanceOf(owner.address)).to.be.above(treasuryBalance)

    expect(await strat.balanceOfPool()).to.be.above(balance)

    const n9500 = ethers.BigNumber.from('' + 1e18).mul(9500) // 100000 DAI
    // withdraw 9500 DAI in shares
    const toWithdraw = (
      (await controller.totalSupply()).mul(n9500).div(
        await controller.balance()
      )
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await DAI.balanceOf(bob.address)).to.within(
      n9500.mul(9990).div(10000), n9500 // 9500 - 0.1% withdrawFee
    )
    expect(await DAI.balanceOf(strat.address)).to.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await DAI.balanceOf(bob.address)).to.within(
      // between -0.2%~0.1%
      newBalance.mul(9900).div(10000),
      newBalance.mul(10100).div(10000),
    )
  })

  it('Full deposit with compensation + harvest strat + withdraw', async function () {
    const newBalance = ethers.BigNumber.from('' + 1e18).mul(10000) // 100000 DAI
    await setCustomBalanceFor(DAI.address, bob.address, newBalance)
    await setCustomBalanceFor(DAI.address, owner.address, newBalance)

    await waitFor(DAI.connect(owner).approve(strat.address, newBalance))
    await waitFor(strat.setOffsetRatio(2))

    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(DAI.connect(bob).approve(cPool.address, newBalance))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await DAI.balanceOf(bob.address)))

    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    const balance = await strat.balanceOfPool() // more decimals

    await changeExchangeRate()

    await mine(100)

    const treasuryBalance = await DAI.balanceOf(owner.address)
    await expect(strat.harvest()).to.emit(strat, 'Harvested').to.emit(strat, 'PerformanceFee')
    expect(await DAI.balanceOf(owner.address)).to.be.above(treasuryBalance)

    expect(await strat.balanceOfPool()).to.be.above(balance)

    const n9500 = ethers.BigNumber.from('' + 1e18).mul(9500) // 100000 DAI
    // withdraw 9500 DAI in shares
    const toWithdraw = (
      (await controller.totalSupply()).mul(n9500).div(
        await controller.balance()
      )
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await DAI.balanceOf(bob.address)).to.within(
      n9500.mul(9990).div(10000), n9500 // 9500 - 0.1% withdrawFee
    )
    expect(await DAI.balanceOf(strat.address)).to.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await DAI.balanceOf(bob.address)).to.within(
      // between 0.1%
      newBalance.mul(9900).div(10000),
      newBalance.mul(10100).div(10000),
    )
  })

  it('harvest with debtSettler', async function () {
    const newBalance = ethers.utils.parseUnits('100000', 18) // 100000 DAI
    await setCustomBalanceFor(DAI.address, bob.address, newBalance)

    const dueDate     = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const lPool       = await deploy('LiquidityPool', cPool.piGlobal(), DAI.address, dueDate)
    const debtSettler = await deploy('DebtSettler', lPool.address)

    await waitFor(strat.setDebtSettler(debtSettler.address))
    await waitFor(strat.setTreasury(treasury.address))

    expect(await DAI.balanceOf(treasury.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await DAI.balanceOf(debtSettler.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(DAI.connect(bob).approve(cPool.address, newBalance))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](newBalance))

    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    const balanceOfPool = await strat.balanceOfPool()
    const balance = await strat.balance()

    await changeExchangeRate()

    await mine(100)

    await expect(strat.harvest()
    ).to.emit(strat, 'PerformanceFee'
    ).to.emit(strat, 'DebtSettlerTransfer'
    ).to.emit(strat, 'Harvested')

    expect(await DAI.balanceOf(treasury.address)).to.be.above(0)
    expect(await DAI.balanceOf(debtSettler.address)).to.be.above(0)

    // Balance of pool shouldn't change
    expect(await strat.balanceOfPool()).to.be.equal(balanceOfPool)
    // Balance should keep "near"
    expect(await strat.balance()).to.be.within(
      balance, balance.mul(1000001).div(1000000)
    )

    // withdraw 9500 DAI in shares
    const toWithdraw = (
      (await controller.totalSupply()).mul(ethers.utils.parseUnits('95000', 18)).div(
        await controller.balance()
      )
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await DAI.balanceOf(bob.address)).to.within(
      ethers.utils.parseUnits('94900', 18), ethers.utils.parseUnits('95000', 18) // 9500 - 0.1% withdrawFee
    )
    expect(await DAI.balanceOf(strat.address)).to.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await DAI.balanceOf(bob.address)).to.within(
      ethers.utils.parseUnits('99800', 18), // between 0.1%
      ethers.utils.parseUnits('100100', 18)
    )
  })

  it('Controller.setStrategy works', async function () {
    const newBalance = ethers.BigNumber.from('' + 1e18).mul(100000) // 100000 DAI
    await setCustomBalanceFor(DAI.address, bob.address, newBalance)

    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(DAI.connect(bob).approve(cPool.address, newBalance))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await DAI.balanceOf(bob.address)))

    expect(await controller.balanceOf(bob.address)).to.be.equal(newBalance)
    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    const otherStrat = await deploy(
      'MStableStrat',
      DAI.address,
      controller.address,
      global.exchange.address,
      owner.address
    )

    await stratCallback(otherStrat)

    await mine(5)

    await expect(controller.setStrategy(otherStrat.address)).to.emit(
      controller, 'StrategyChanged'
    ).withArgs(strat.address, otherStrat.address)

    expect(await controller.balanceOf(bob.address)).to.be.equal(newBalance)
    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(strat.unpause())

    await expect(controller.setStrategy(strat.address)).to.emit(
      controller, 'StrategyChanged'
    ).withArgs(otherStrat.address, strat.address)

    expect(await controller.balanceOf(bob.address)).to.be.equal(newBalance)
    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await REWARD_TOKEN.balanceOf(strat.address)).to.be.equal(0)
  })

  describe('setDepositShareThreshold', async () => {
    it('should be reverted for non admin', async () => {
      await expect(controller.connect(bob).setDepositShareThreshold(10)).to.be.revertedWith(
        'Ownable: caller is not the owner'
      )
    })

    it('should change depositShareThreshold', async () => {
      expect(await controller.depositShareThreshold()).to.be.equal(0.99e18 + '')
      await controller.setDepositShareThreshold(10)
      expect(await controller.depositShareThreshold()).to.be.equal(10)
    })

    it('should revert for low depositShareThreshold', async () => {
      const newBalance = ethers.BigNumber.from('' + 1e18).mul(100000) // 100000 DAI
      await setCustomBalanceFor(DAI.address, bob.address, newBalance)

      await controller.setDepositShareThreshold(1.1e18 + '') // just to prove it

      await DAI.connect(bob).approve(cPool.address, newBalance)
      await expect(cPool.connect(bob)['deposit(uint256)'](newBalance)).to.be.revertedWithCustomError(controller, 'LowSharePrice')
    })

    it('should revert for low depositShareThreshold after deposit in strat', async () => {
      const newBalance = ethers.BigNumber.from('' + 1e18).mul(100000) // 100000 DAI
      await setCustomBalanceFor(DAI.address, bob.address, newBalance)

      await controller.setDepositShareThreshold(1.0e18 + '') // just to prove it

      await DAI.connect(bob).approve(cPool.address, newBalance)
      await expect(cPool.connect(bob)['deposit(uint256)'](newBalance)).to.be.revertedWithCustomError(controller, 'LowSharePrice')
    })
  })

  describe('setWithdrawShareThreshold', async () => {
    it('should be reverted for non admin', async () => {
      await expect(controller.connect(bob).setWithdrawShareThreshold(10)).to.be.revertedWith(
        'Ownable: caller is not the owner'
      )
    })

    it('should change withdrawShareThreshold', async () => {
      expect(await controller.withdrawShareThreshold()).to.be.equal(0.99e18 + '')
      await controller.setWithdrawShareThreshold(10)
      expect(await controller.withdrawShareThreshold()).to.be.equal(10)
    })

    it('should revert for low withdrawShareThreshold', async () => {
      const newBalance = ethers.BigNumber.from('' + 1e18).mul(100000) // 100000 DAI
      await setCustomBalanceFor(DAI.address, bob.address, newBalance)
      await controller.setWithdrawShareThreshold(1.1e18 + '') // just to prove it

      await DAI.connect(bob).approve(cPool.address, newBalance)
      await waitFor(cPool.connect(bob)['deposit(uint256)'](newBalance))
      await expect(cPool.connect(bob).withdrawAll()).to.be.revertedWithCustomError(controller, 'LowSharePrice')
    })
  })
})
