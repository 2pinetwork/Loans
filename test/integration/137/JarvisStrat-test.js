const {
  createCPool,
  deploy,
  mine,
  mineUntil,
  waitFor,
  createOracles,
  resetHardhat,
  setChainlinkRoundForNow,
  setCustomBalanceFor,
} = require('../helpers')

describe('Jarvis Strat', function () {
  let cPool
  let controller
  let strat
  let ageur
  let agden
  let eurFeed
  let umaFeed
  let wmaticFeed
  let updatePrices

  beforeEach(async function () {
    await resetHardhat(25774000); // 2022-03-09 06: UTC

    agden = await ethers.getContractAt('IERC20Metadata', '0xbAbC2dE9cE26a5674F8da84381e2f06e1Ee017A1')
    ageur = await ethers.getContractAt('IERC20Metadata', '0xE0B52e49357Fd4DAf2c15e02058DCE6BC0057db4')

    const deployed = await createCPool(ageur, 'JarvisStrat')

    cPool = deployed.cPool
    controller = deployed.cToken
    strat = deployed.strategy;

    [eurFeed, umaFeed, wmaticFeed] = await Promise.all([
      ethers.getContractAt('IChainLink', '0x73366Fe0AA0Ded304479862808e02506FE556a98'), // EUR
      ethers.getContractAt('IChainLink', '0x33D9B1BAaDcF4b26ab6F8E83e9cb8a611B2B3956'), // UMA
      ethers.getContractAt('IChainLink', '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0'), // WMATIC
    ])

    const JRT = '0x596ebe76e2db4470966ea395b0d063ac6197a8c5' // JRT
    const UMA = '0x3066818837c5e6ed6601bd5a91b0762877a6b731' // UMA
    const ANGLE = '0x900F717EA076E1E7a484ad9DD2dB81CEEc60eBF1' // ANGLE
    const MIMO = '0xADAC33f543267c4D59a8c299cF804c303BC3e4aC' // MIMO

    const tokenData = {
      [JRT]:           { price: 0.04 },
      [ANGLE]:         { price: 0.185 },
      [MIMO]:          { price: 0.075 },
      [agden.address]: { price: 824.0 },
    }
    await createOracles(tokenData)

    const QUICKSWAP = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'

    updatePrices = async function () {
      await network.provider.send('hardhat_mine', ['0x2', '0x3f'])

      let proms = [
        setChainlinkRoundForNow(eurFeed),
        setChainlinkRoundForNow(umaFeed),
        setChainlinkRoundForNow(wmaticFeed),
        setChainlinkRoundForNow(usdcFeed),
      ]

      for (let token in tokenData) {
        proms.push(tokenData[token].oracle.update())
      }

      await Promise.all(proms)
    }

    await Promise.all([
      updatePrices(),
      waitFor(strat.setMaxPriceOffset(86400)), // Time
      waitFor(strat.setPoolSlippageRatio(100)), // price variation
      waitFor(strat.setSwapSlippageRatio(500)), // price variation
      waitFor(strat.setPriceFeed(WMATIC.address, wmaticFeed.address)),
      waitFor(strat.setPriceFeed(ageur.address, eurFeed.address)),
      waitFor(strat.setPriceFeed(UMA, umaFeed.address)),
      waitFor(strat.setPriceFeed(USDC.address, usdcFeed.address)),
      waitFor(strat.setPriceFeed(JRT, tokenData[JRT].oracle.address)),
      waitFor(strat.setPriceFeed(ANGLE, tokenData[ANGLE].oracle.address)),
      waitFor(strat.setPriceFeed(MIMO, tokenData[MIMO].oracle.address)),
      waitFor(strat.setPriceFeed(agden.address, tokenData[agden.address].oracle.address)),
      // Ideally set in this order, so we swap agDEN first for USDC and then USDC for agEUR
      waitFor(strat.setKyberRewardPathRoute(agden.address, ['0xBD0F10CE8F794f17499aEf6987dc8d21a59F46ad'])), // DMMPool
      waitFor(strat.setKyberRewardRoute(agden.address, [agden.address, USDC.address])), // DMMPool
      waitFor(strat.setRewardToTokenRoute(JRT, [JRT, WETH.address, USDC.address])),
      // waitFor(strat.setRewardExchange(JRT, sushi)),
      waitFor(strat.setRewardToTokenRoute(UMA, [UMA, WETH.address, USDC.address])),
      // waitFor(strat.setRewardExchange(UMA, sushi)),
      waitFor(strat.setRewardToWantRoute(ANGLE, [ANGLE, ageur.address])),
      waitFor(strat.setRewardExchange(ANGLE, QUICKSWAP)),

      // MIMO rewards are low and can't be swapped to usdc for the decimals
      waitFor(strat.setRewardToTokenRoute(MIMO, [MIMO, USDC.address, WMATIC.address])),
      waitFor(strat.setRewardToWantRoute(WMATIC.address, [WMATIC.address, USDC.address, ageur.address])),
      waitFor(strat.setRewardExchange(WMATIC.address, QUICKSWAP)),
    ])

    // USDC should always be the last
    await Promise.all([
      waitFor(strat.setRewardToWantRoute(USDC.address, [USDC.address, ageur.address])),
      waitFor(strat.setRewardExchange(USDC.address, QUICKSWAP)),
    ])
  })

  it('Full deposit + harvest strat + withdraw', async function () {
    await setCustomBalanceFor(ageur.address, bob.address, '100', 51)

    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(ageur.connect(bob).approve(cPool.address, '' + 100e18))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await ageur.balanceOf(bob.address)))

    expect(await ageur.balanceOf(controller.address)).to.be.equal(0)
    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)

    let balanceOfPool = await strat.balanceOfPool()
    let balance = await strat.balance()

    // Claim some rewards
    await mine(10)
    await expect(strat.harvest()).to.emit(strat, 'Harvested')
    expect(await strat.balanceOfPool()).to.be.above(balanceOfPool)
    expect(await strat.balance()).to.be.above(balance)

    balanceOfPool = await strat.balanceOfPool()
    balance = await strat.balance()

    await expect(strat.harvest()).to.emit(strat, 'Harvested')

    // Claim all rewards
    await mineUntil(26400000)
    await updatePrices()

    // just to test multi harvest
    await expect(strat.harvest()).to.emit(strat, 'Harvested')
    await expect(strat.harvest()).to.emit(strat, 'Harvested')
    await expect(strat.harvest()).to.emit(strat, 'Harvested')

    // balance Of pool shouldn't change after pool ends
    expect(await strat.balanceOfPool()).to.be.equal(balanceOfPool)
    expect(await strat.balance()).to.be.above(balance)

    // withdraw 95 ageur in shares
    const toWithdraw = (
      (await controller.totalSupply()).mul(95e18 + '').div(
        await controller.balance()
      )
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await ageur.balanceOf(bob.address)).to.within(
      94.9e18 + '', 95e18 + '' // 95 - 0.1% withdrawFee
    )
    // After pool is expired the agEUR should be kept in the strat
    expect(await ageur.balanceOf(strat.address)).to.above(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await ageur.balanceOf(bob.address)).to.above(
      99.8e18 + ''
    )

    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)
    expect(await agden.balanceOf(strat.address)).to.be.equal(0)

    const agcrv = await ethers.getContractAt('IERC20Metadata', '0x81212149b983602474fcD0943E202f38b38d7484')
    expect(await agcrv.balanceOf(strat.address)).to.be.equal(0)
  })

  it('Harvest with debtSettler', async function () {
    const newBalance = ethers.utils.parseUnits('100')
    await setCustomBalanceFor(ageur.address, bob.address, newBalance, 51)

    const dueDate     = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const lPool       = await deploy('LiquidityPool', cPool.piGlobal(), ageur.address, dueDate)
    const debtSettler = await deploy('DebtSettler', lPool.address)

    await waitFor(strat.setDebtSettler(debtSettler.address))
    await waitFor(strat.setTreasury(treasury.address))

    expect(await ageur.balanceOf(treasury.address)).to.be.equal(0)
    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)
    expect(await ageur.balanceOf(debtSettler.address)).to.be.equal(0)

    await waitFor(ageur.connect(bob).approve(cPool.address, '' + 100e18))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await ageur.balanceOf(bob.address)))

    expect(await ageur.balanceOf(treasury.address)).to.be.equal(0)
    expect(await ageur.balanceOf(debtSettler.address)).to.be.equal(0)
    expect(await ageur.balanceOf(controller.address)).to.be.equal(0)
    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)

    let balanceOfPool = await strat.balanceOfPool()
    let balance = await strat.balance()

    // Claim some rewards
    await mine(10)
    await expect(strat.harvest()).to.emit(strat, 'Harvested'
    ).to.emit(strat, 'PerformanceFee').to.emit(strat, 'DebtSettlerTransfer')


    let tBalance = await ageur.balanceOf(treasury.address)
    let dBalance = await ageur.balanceOf(debtSettler.address)

    expect(tBalance).to.be.above(0)
    expect(dBalance).to.be.above(0)

    expect(await strat.balanceOfPool()).to.be.equal(balanceOfPool)
    expect(await strat.balance()).to.be.equal(balance)

    balanceOfPool = await strat.balanceOfPool()
    balance = await strat.balance()

    await expect(strat.harvest()).to.emit(
      strat, 'Harvested'
    ).withArgs(
      ageur.address, 0
    ).to.not.emit(
      strat, 'PerformanceFee'
    ).to.not.emit(strat, 'DebtSettlerTransfer')

    expect(await ageur.balanceOf(treasury.address)).to.be.equal(tBalance)
    expect(await ageur.balanceOf(debtSettler.address)).to.be.equal(dBalance)

    // Claim all rewards
    await mineUntil(26400000)
    await updatePrices()

    // just to test multi harvest but the only one that should work is the first
    await expect(strat.harvest()).to.emit(strat, 'Harvested').to.emit(strat, 'PerformanceFee').to.emit(strat, 'DebtSettlerTransfer')

    expect(await ageur.balanceOf(treasury.address)).to.be.above(tBalance)
    expect(await ageur.balanceOf(debtSettler.address)).to.be.above(dBalance)

    await expect(strat.harvest()).to.emit(
      strat, 'Harvested'
    ).withArgs(
      ageur.address, 0
    ).to.not.emit(
      strat, 'PerformanceFee'
    ).to.not.emit(strat, 'DebtSettlerTransfer')

    await expect(strat.harvest()).to.emit(
      strat, 'Harvested'
    ).withArgs(
      ageur.address, 0
    ).to.not.emit(
      strat, 'PerformanceFee'
    ).to.not.emit(strat, 'DebtSettlerTransfer')

    // balance Of pool shouldn't change after pool ends
    expect(await strat.balanceOfPool()).to.be.equal(balanceOfPool)
    expect(await strat.balance()).to.be.equal(balance)

    // withdraw 95 ageur in shares
    const toWithdraw = (
      (await controller.totalSupply()).mul(95e18 + '').div(
        await controller.balance()
      )
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await ageur.balanceOf(bob.address)).to.within(
      94.9e18 + '', 95e18 + '' // 95 - 0.1% withdrawFee
    )
    // After pool is expired the agEUR should be kept in the strat
    expect(await ageur.balanceOf(strat.address)).to.above(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await ageur.balanceOf(bob.address)).to.above(
      99.8e18 + ''
    )

    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)
    expect(await agden.balanceOf(strat.address)).to.be.equal(0)

    const agcrv = await ethers.getContractAt('IERC20Metadata', '0x81212149b983602474fcD0943E202f38b38d7484')
    expect(await agcrv.balanceOf(strat.address)).to.be.equal(0)
  })

  it('Deposit and change strategy', async function () {
    await setCustomBalanceFor(ageur.address, bob.address, '100', 51)
    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(ageur.connect(bob).approve(cPool.address, '' + 100e18))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await ageur.balanceOf(bob.address)))

    expect(await ageur.balanceOf(controller.address)).to.be.equal(0)
    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)

    const otherStrat = await deploy(
      'JarvisStrat',
      controller.address,
      exchange.address,
      '0x546C79662E028B661dFB4767664d0273184E4dD1', // KyberSwap router
      owner.address
    )

    await Promise.all([
      waitFor(otherStrat.setMaxPriceOffset(86400)),
      waitFor(otherStrat.setPriceFeed(ageur.address, eurFeed.address)),
      waitFor(otherStrat.setPoolSlippageRatio(100)), // price variation
      waitFor(otherStrat.setSwapSlippageRatio(1000)), // price variation
      waitFor(strat.setSwapSlippageRatio(1000)), // price variation
    ])

    await mine(10) // increase the rewards to be swapped

    await expect(controller.setStrategy(otherStrat.address)).to.emit(controller, 'StrategyChanged').withArgs(
      strat.address, otherStrat.address
    )

    expect(await controller.balanceOf(bob.address)).to.be.equal(100e18 + '')
    expect(await ageur.balanceOf(controller.address)).to.be.equal(0)
    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)
    expect(await strat.balance()).to.be.equal(0)
    expect(await otherStrat.balance()).to.be.within(99.9e18 + '', 100e18 + '')

    await mine(10) // increase the rewards to be swapped
    await waitFor(strat.unpause())
    await expect(controller.setStrategy(strat.address)).to.emit(controller, 'StrategyChanged').withArgs(
      otherStrat.address, strat.address
    )

    expect(await controller.balanceOf(bob.address)).to.be.equal(100e18 + '')
    expect(await ageur.balanceOf(controller.address)).to.be.equal(0)
    expect(await ageur.balanceOf(strat.address)).to.be.equal(0)
    expect(await otherStrat.balance()).to.be.equal(0)
    expect(await strat.balance()).to.be.within(99.9e18 + '', 100e18 + '')
  })
})
