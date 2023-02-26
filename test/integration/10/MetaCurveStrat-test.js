/*global CurveRewardsGauge */

const {
  createCPool,
  deploy,
  mine,
  resetHardhat,
  setCustomBalanceFor,
  waitFor,
} = require('../helpers')


const addresses = {
  crvToken:     '0x061b87122Ed14b9526A813209C8a59a633257bAb',
  pool:         '0x167e42a1C7ab4Be03764A2222aAC57F5f6754411',
  metaPool:     '0x061b87122Ed14b9526A813209C8a59a633257bAb',
  gauge:        '0xc5aE4B5F86332e70f3205a8151Ee9eD9F71e0797',
  gaugeFactory: '0xabc000d88f23bb45525e447528dbf656a9d55bf5'
}

describe('Curve Strat DAI', function () {
  let cPool
  let controller
  let strat
  let poolSlipage

  before(async function () { await resetHardhat(22562704) })

  beforeEach(async function () {
    global.CurveRewardsGauge = await ethers.getContractAt('ICurveGauge', addresses.gauge)

    const deployed = await createCPool(DAI, 'MetaCurveStrat', {
      ...addresses,
      gaugeType: 1,
      poolSize: 4,
      tokenIndex: 1 // [sUSD, DAI, USDC, USDT]
    })

    cPool      = deployed.cPool
    controller = deployed.cToken
    strat      = deployed.strategy

    poolSlipage = 0.015

    await Promise.all([
      waitFor(strat.setMaxPriceOffset(86400)),
      waitFor(strat.setPriceFeed(OP.address, opFeed.address)),
      waitFor(strat.setPriceFeed(DAI.address, daiFeed.address)),
      waitFor(strat.setPriceFeed(CRV.address, crvFeed.address)),
      waitFor(strat.setPoolSlippageRatio(poolSlipage * 10000)),
      waitFor(strat.setSwapSlippageRatio(500)),
      waitFor(strat.setRewardToWantRoute(OP.address, [OP.address, DAI.address])),
      waitFor(strat.setRewardToWantRoute(CRV.address, [CRV.address, WETH.address, DAI.address])),
      waitFor(strat.setTokenToTokenSwapFee(OP.address, DAI.address, 3000)),
      waitFor(strat.setTokenToTokenSwapFee(CRV.address, WETH.address, 3000)),
      waitFor(strat.setTokenToTokenSwapFee(WETH.address, DAI.address, 3000)),
    ])
  })

  it('Full deposit + harvest strat + withdraw', async function () {
    await setCustomBalanceFor(DAI.address, bob.address, '100', 2)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.equal(0)

    const bobDeposit = await DAI.balanceOf(bob.address)

    await waitFor(DAI.connect(bob).approve(cPool.address, '' + 100e18))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](bobDeposit))

    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.within(
      (100e18 - (100e18 * poolSlipage)) + '', // production virtual price is ~1.0093.
      100e18 + ''
    )

    const balance = await strat.balanceOfPool() // more decimals

    // to ask for rewards (max 100 blocks)
    for (let i = 0; i < 20; i++) {
      await mine(5)

      expect(await strat.harvest()).to.emit(strat, 'Harvested')

      if (balance < (await strat.balanceOfPool())) { break }
      console.log('Mined 6 blocks...')
    }

    expect(await strat.balanceOfPool()).to.be.above(balance)

    // withdraw 95 DAI in shares
    const toWithdraw = (
      await cPool.convertToShares(bobDeposit.mul(95).div(100))
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await DAI.balanceOf(bob.address)).to.within(
      94.9e18 + '', 95e18 + '' // 95 - 0.1% withdrawFee
    )
    expect(await DAI.balanceOf(strat.address)).to.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.within(
      4.6e18 + '', // 99.6 - 95
      5e18 + ''
    )

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await DAI.balanceOf(bob.address)).to.be.above(99.8e18 + '').to.be.below(100e18 + '')
  })

  it('Deposit and change strategy', async function () {
    await setCustomBalanceFor(DAI.address, bob.address, '100', 2)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(DAI.connect(bob).approve(cPool.address, '' + 100e18))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await DAI.balanceOf(bob.address)))

    expect(await controller.balanceOf(bob.address)).to.be.within(
      99.9e18 + '', 100e18 + ''
    )

    const bobShares = await controller.balanceOf(bob.address)
    expect(await controller.convertToAssets(bobShares)).to.be.within(99.9e18 + '', 100e18 + '')

    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.within(
      98.0e18 + '', // production virtual price is ~1.0093.
      100e18 + ''
    )

    const otherStrat = await deploy(
      'DummyStrat',
      DAI.address,
      controller.address,
      global.exchange.address,
      owner.address
    )

    expect(await controller.setStrategy(otherStrat.address)).to.emit(controller, 'NewStrategy').withArgs(
      strat.address, otherStrat.address
    )

    expect(await controller.balanceOf(bob.address)).to.be.equal(bobShares)
    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await strat.balance()).to.be.equal(0)
    expect(await otherStrat.balance()).to.be.within(
      99e18 + '', 100e18 + ''
    )

    await waitFor(strat.unpause())
    expect(await controller.setStrategy(strat.address)).to.emit(controller, 'NewStrategy').withArgs(
      otherStrat.address, strat.address
    )

    expect(await controller.balanceOf(bob.address)).to.be.equal(bobShares)
    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await otherStrat.balance()).to.be.equal(0)
    expect(await strat.balance()).to.be.within(
      99e18 + '', 100e18 + ''
    )
  })
})

describe('Curve Strat USDC', function () {
  let poolSlipage, strat, cPool, controller

  before(async function () { await resetHardhat(22562704) })

  beforeEach(async function () {
    global.CurveRewardsGauge = await ethers.getContractAt('ICurveGauge', addresses.gauge)

    const deployed = await createCPool(USDC, 'MetaCurveStrat', {
      ...addresses,
      gaugeType: 1,
      poolSize: 4,
      tokenIndex: 2 // [sUSD, DAI, USDC, USDT]
    })

    cPool      = deployed.cPool
    controller = deployed.cToken
    strat      = deployed.strategy

    poolSlipage = 0.015

    await Promise.all([
      waitFor(strat.setMaxPriceOffset(86400)),
      waitFor(strat.setPriceFeed(OP.address, opFeed.address)),
      waitFor(strat.setPriceFeed(USDC.address, usdcFeed.address)),
      waitFor(strat.setPriceFeed(CRV.address, crvFeed.address)),
      waitFor(strat.setPoolSlippageRatio(poolSlipage * 10000)),
      waitFor(strat.setSwapSlippageRatio(500)),
      waitFor(strat.setRewardToWantRoute(OP.address, [OP.address, USDC.address])),
      waitFor(strat.setRewardToWantRoute(CRV.address, [CRV.address, WETH.address, USDC.address])),
      waitFor(strat.setTokenToTokenSwapFee(OP.address, USDC.address, 3000)),
      waitFor(strat.setTokenToTokenSwapFee(CRV.address, WETH.address, 3000)),
      waitFor(strat.setTokenToTokenSwapFee(WETH.address, USDC.address, 3000)),
    ])
  })

  it('Full deposit + harvest strat + withdraw', async function () {
    await setCustomBalanceFor(USDC.address, bob.address, ethers.utils.parseUnits('100', 6))
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.equal(0)

    const bobDeposit =  await USDC.balanceOf(bob.address)

    await waitFor(USDC.connect(bob).approve(cPool.address, '' + 100e6))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](bobDeposit))

    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.within(
      (100e18 - (100e18 * poolSlipage)) + '', // production virtual price is ~1.0093.
      100e18 + ''
    )

    const balance = await strat.balanceOfPool() // more decimals

    // to ask for rewards (max 100 blocks)
    for (let i = 0; i < 20; i++) {
      await mine(5)

      expect(await strat.harvest()).to.emit(strat, 'Harvested')

      if (balance < (await strat.balanceOfPool())) { break }
      console.log('Mined 6 blocks...')
    }

    expect(await strat.balanceOfPool()).to.be.above(balance)

    // withdraw 95 USDC in shares
    const toWithdraw = (
      await cPool.convertToShares(bobDeposit.mul(95).div(100))
    )

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await USDC.balanceOf(bob.address)).to.within(
      94.9e6 + '', 95e6 + '' // 95 - 0.1% withdrawFee
    )
    expect(await USDC.balanceOf(strat.address)).to.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.within(
      4.6e18 + '', // 99.6 - 95
      5e18 + ''
    )

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await USDC.balanceOf(bob.address)).to.be.above(99.8e6 + '').to.be.below(100e6 + '')
  })

  it('Deposit and change strategy', async function () {
    await setCustomBalanceFor(USDC.address, bob.address, ethers.utils.parseUnits('100', 6))
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(USDC.connect(bob).approve(cPool.address, '' + 100e6))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await USDC.balanceOf(bob.address)))

    const bobShares = await controller.balanceOf(bob.address)

    expect(bobShares).to.be.within(99.9e6 + '', 100e6 + '')
    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await CurveRewardsGauge.balanceOf(strat.address)).to.be.within(
      98.0e18 + '', // production virtual price is ~1.0093.
      100e18 + ''
    )

    const otherStrat = await deploy(
      'DummyStrat',
      USDC.address,
      controller.address,
      global.exchange.address,
      owner.address
    )

    expect(await controller.setStrategy(otherStrat.address)).to.emit(controller, 'NewStrategy').withArgs(
      strat.address, otherStrat.address
    )

    expect(await controller.balanceOf(bob.address)).to.be.equal(bobShares)
    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await strat.balance()).to.be.equal(0)
    expect(await otherStrat.balance()).to.be.within(
      99e6 + '', 100e6 + ''
    )

    await waitFor(strat.unpause())
    expect(await controller.setStrategy(strat.address)).to.emit(controller, 'NewStrategy').withArgs(
      otherStrat.address, strat.address
    )

    expect(await controller.balanceOf(bob.address)).to.be.equal(bobShares)
    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await otherStrat.balance()).to.be.equal(0)
    expect(await strat.balance()).to.be.above(99.8e6 + '').to.be.below(100e6 + '')
  })
})
