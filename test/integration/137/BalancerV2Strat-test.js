const {
  createCPool,
  resetHardhat,
  setChainlinkRoundForNow,
  setCustomBalanceFor,
  waitFor,
} = require('../helpers')

describe('BalancerV2 Strat USDC', function () {
  let cPool
  let controller
  let strat
  let qi
  let bal
  let qiFeed
  let balFeed

  before(async function () {
    await resetHardhat(28401104)
  })

  beforeEach(async function () {
    qi = await ethers.getContractAt('IERC20Metadata', '0x580a84c73811e1839f75d86d75d88cca0c241ff4')
    bal = await ethers.getContractAt('IERC20Metadata', '0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3')

    const poolId = '0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000012'
    const gauge  = '0x72843281394E68dE5d55BCF7072BB9B2eBc24150'

    const deployed = await createCPool(USDC, 'BalancerV2Strat', { poolId, gauge })

    cPool      = deployed.cPool
    controller = deployed.cToken
    strat      = deployed.strategy;

    [qiFeed, balFeed] = await Promise.all([
      ethers.getContractAt('IChainLink', '0xbaf9327b6564454F4a3364C33eFeEf032b4b4444'), // Doge less than qi
      ethers.getContractAt('IChainLink', '0xD106B538F2A868c28Ca1Ec7E298C3325E0251d66'),
    ])

    expect(await strat.identifier()).to.be.equal(`USDC@BalancerV2#1.0.0`)

    await Promise.all([
      setChainlinkRoundForNow(qiFeed),
      setChainlinkRoundForNow(balFeed),
      waitFor(strat.setMaxPriceOffset(86400)),
      waitFor(strat.setPriceFeed(USDC.address, usdcFeed.address)),
      waitFor(strat.setPriceFeed(qi.address, qiFeed.address)),
      waitFor(strat.setPriceFeed(bal.address, balFeed.address)),
      waitFor(strat.setRewardToWantRoute(qi.address, [qi.address, WMATIC.address, USDC.address])), // ETH route doesn't exist at this moment
      waitFor(strat.setRewardToWantRoute(bal.address, [bal.address, WETH.address, USDC.address])),
    ])
  })

  // Balancer distribute rewards 1 week after so we can't test the claim part
  it('Full deposit + harvest strat + withdraw', async function () {
    const newBalance = ethers.utils.parseUnits('100', 6)
    await setCustomBalanceFor(USDC.address, bob.address, newBalance)

    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await qi.balanceOf(strat.address)).to.be.equal(0)
    expect(await bal.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(USDC.connect(bob).approve(cPool.address, newBalance))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await USDC.balanceOf(bob.address)))

    expect(await USDC.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDC.balanceOf(strat.address)).to.be.equal(0)
    expect(await controller.balanceOf(bob.address)).to.be.equal(100e6)

    const balance = await strat.balanceOfPool() // more decimals

    // Simulate claim rewards
    const rewards = ethers.utils.parseUnits('100', 18)
    await setCustomBalanceFor(bal.address, strat.address, rewards)
    expect(await bal.balanceOf(strat.address)).to.be.equal(rewards)
    await setCustomBalanceFor(qi.address, strat.address, rewards)
    expect(await qi.balanceOf(strat.address)).to.be.equal(rewards)
    await strat.setSwapSlippageRatio(9999)
    await waitFor(strat.harvest())
    expect(await strat.balanceOfPool()).to.be.above(balance)

    await waitFor(strat.panic())
    await waitFor(strat.unpause())

    // withdraw 85% in shares
    const toWithdraw = (await cPool.balanceOf(bob.address)).mul(
      8500
    ).div(10000)
    let expectedOutput = toWithdraw.mul(await cPool.pricePerShare()).div(1e6)

    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))


    expect(await USDC.balanceOf(bob.address)).to.within(
      expectedOutput.mul(99).div(100),
      expectedOutput.mul(101).div(100)
    )
    expect(await USDC.balanceOf(strat.address)).to.equal(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await USDC.balanceOf(bob.address)).to.within(
      expectedOutput,
      expectedOutput.mul(130).div(100)
    )
  })
})

describe('BalancerV2 Strat USDT', function () {
  let cPool
  let controller
  let strat
  let qi
  let bal
  let qiFeed
  let balFeed

  beforeEach(async function () {
    qi = await ethers.getContractAt('IERC20Metadata', '0x580a84c73811e1839f75d86d75d88cca0c241ff4')
    bal = await ethers.getContractAt('IERC20Metadata', '0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3')

    const poolId = '0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000012'
    const gauge  = '0x72843281394E68dE5d55BCF7072BB9B2eBc24150'

    const deployed = await createCPool(USDT, 'BalancerV2Strat', { poolId, gauge })

    cPool      = deployed.cPool
    controller = deployed.cToken
    strat      = deployed.strategy;

    [qiFeed, balFeed] = await Promise.all([
      ethers.getContractAt('IChainLink', '0xbaf9327b6564454F4a3364C33eFeEf032b4b4444'), // Doge less than qi
      ethers.getContractAt('IChainLink', '0xD106B538F2A868c28Ca1Ec7E298C3325E0251d66'),
    ])

    expect(await strat.identifier()).to.be.equal(`USDT@BalancerV2#1.0.0`)

    await Promise.all([
      setChainlinkRoundForNow(qiFeed),
      setChainlinkRoundForNow(balFeed),
      waitFor(strat.setMaxPriceOffset(86400)),
      waitFor(strat.setPriceFeed(USDT.address, usdtFeed.address)),
      waitFor(strat.setPriceFeed(qi.address, qiFeed.address)),
      waitFor(strat.setPriceFeed(bal.address, balFeed.address)),
      waitFor(strat.setRewardToWantRoute(qi.address, [qi.address, WMATIC.address, USDT.address])), // ETH route doesn't exist at this moment
      waitFor(strat.setRewardToWantRoute(bal.address, [bal.address, WETH.address, USDT.address])),
    ])
  })

  // Balancer distribute rewards 1 week after so we can't test the claim part
  it('Full deposit + harvest strat + withdraw', async function () {
    const newBalance = ethers.utils.parseUnits('100', 6)
    await setCustomBalanceFor(USDT.address, bob.address, newBalance)
    expect(await USDT.balanceOf(strat.address)).to.be.equal(0)
    expect(await qi.balanceOf(strat.address)).to.be.equal(0)
    expect(await bal.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(USDT.connect(bob).approve(cPool.address, newBalance))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await USDT.balanceOf(bob.address)))

    expect(await USDT.balanceOf(controller.address)).to.be.equal(0)
    expect(await USDT.balanceOf(strat.address)).to.be.equal(0)
    expect(await controller.balanceOf(bob.address)).to.be.equal(100e6)

    const balance = await strat.balanceOfPool() // more decimals

    // Simulate claim rewards
    const rewards = ethers.utils.parseUnits('100', 18)
    await setCustomBalanceFor(bal.address, strat.address, rewards)
    expect(await bal.balanceOf(strat.address)).to.be.equal(rewards)
    await setCustomBalanceFor(qi.address, strat.address, rewards)
    expect(await qi.balanceOf(strat.address)).to.be.equal(rewards)
    await strat.setSwapSlippageRatio(9999)
    await waitFor(strat.harvest())
    expect(await strat.balanceOfPool()).to.be.above(balance)

    await waitFor(strat.panic())
    await waitFor(strat.unpause())
    // withdraw 95% in shares
    const toWithdraw = (await cPool.balanceOf(bob.address)).mul(
      8000
    ).div(10000)
    let expectedOutput = toWithdraw.mul(await cPool.pricePerShare()).div(1e6)

    await strat.setPoolSlippageRatio(150)
    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))

    expect(await USDT.balanceOf(bob.address)).to.within(
      expectedOutput.mul(98).div(100),
      expectedOutput.mul(102).div(100)
    )
    expect(await USDT.balanceOf(strat.address)).to.equal(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await USDT.balanceOf(bob.address)).to.within(
      expectedOutput,
      expectedOutput.mul(130).div(100)
    )
  })
})

describe('BalancerV2 Strat DAI', function () {
  let cPool
  let controller
  let strat
  let qi
  let bal
  let qiFeed
  let balFeed

  beforeEach(async function () {
    qi = await ethers.getContractAt('IERC20Metadata', '0x580a84c73811e1839f75d86d75d88cca0c241ff4')
    bal = await ethers.getContractAt('IERC20Metadata', '0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3')

    const poolId = '0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000012'
    const gauge  = '0x72843281394E68dE5d55BCF7072BB9B2eBc24150'

    const deployed = await createCPool(DAI, 'BalancerV2Strat', { poolId, gauge })

    cPool      = deployed.cPool
    controller = deployed.cToken
    strat      = deployed.strategy;

    [qiFeed, balFeed] = await Promise.all([
      ethers.getContractAt('IChainLink', '0xbaf9327b6564454F4a3364C33eFeEf032b4b4444'), // Doge less than qi
      ethers.getContractAt('IChainLink', '0xD106B538F2A868c28Ca1Ec7E298C3325E0251d66'),
    ])

    expect(await strat.identifier()).to.be.equal(`DAI@BalancerV2#1.0.0`)

    await Promise.all([
      setChainlinkRoundForNow(qiFeed),
      setChainlinkRoundForNow(balFeed),
      waitFor(strat.setMaxPriceOffset(86400)),
      waitFor(strat.setPriceFeed(DAI.address, daiFeed.address)),
      waitFor(strat.setPriceFeed(qi.address, qiFeed.address)),
      waitFor(strat.setPriceFeed(bal.address, balFeed.address)),
      waitFor(strat.setRewardToWantRoute(qi.address, [qi.address, WMATIC.address, DAI.address])), // ETH route doesn't exist at this moment
      waitFor(strat.setRewardToWantRoute(bal.address, [bal.address, WETH.address, DAI.address])),
    ])
  })

  // Balancer distribute rewards 1 week after so we can't test the claim part
  it('Full deposit + harvest strat + withdraw', async function () {
    const newBalance = ethers.utils.parseUnits('100', 18)
    await setCustomBalanceFor(DAI.address, bob.address, newBalance)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await qi.balanceOf(strat.address)).to.be.equal(0)
    expect(await bal.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(DAI.connect(bob).approve(cPool.address, newBalance))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await DAI.balanceOf(bob.address)))

    expect(await DAI.balanceOf(controller.address)).to.be.equal(0)
    expect(await DAI.balanceOf(strat.address)).to.be.equal(0)
    expect(await controller.balanceOf(bob.address)).to.be.equal(100e18 + '')

    const balance = await strat.balanceOfPool() // more decimals

    // Simulate claim rewards
    const rewards = ethers.utils.parseUnits('100', 18)
    await setCustomBalanceFor(bal.address, strat.address, rewards)
    expect(await bal.balanceOf(strat.address)).to.be.equal(rewards)
    await setCustomBalanceFor(qi.address, strat.address, rewards)
    expect(await qi.balanceOf(strat.address)).to.be.equal(rewards)
    await strat.setSwapSlippageRatio(9999)
    await waitFor(strat.harvest())
    expect(await strat.balanceOfPool()).to.be.above(balance)

    await waitFor(strat.panic())
    await waitFor(strat.unpause())
    // withdraw 95% in shares
    const toWithdraw = (await cPool.balanceOf(bob.address)).mul(
      8000
    ).div(10000)
    let expectedOutput = toWithdraw.mul(await cPool.pricePerShare()).div(1e18 + '')

    await strat.setPoolSlippageRatio(150)
    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))


    expect(await DAI.balanceOf(bob.address)).to.within(
      expectedOutput.mul(98).div(100),
      expectedOutput.mul(102).div(100)
    )
    expect(await DAI.balanceOf(strat.address)).to.equal(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await DAI.balanceOf(bob.address)).to.within(
      expectedOutput,
      expectedOutput.mul(130).div(100)
    )
  })
})

describe('Controller BalancerV2 Strat BTC', function () {
  let cPool
  let controller
  let strat
  let bal
  let btcFeed
  let balFeed

  before(async function () { await resetHardhat(28401104) })

  beforeEach(async function () {
    bal = await ethers.getContractAt('IERC20Metadata', '0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3')

    const poolId = '0xfeadd389a5c427952d8fdb8057d6c8ba1156cc5600020000000000000000001e'
    const gauge  = '0xba46106A5FDb350372C17ba31Bc0A6b71a148221'

    const deployed = await createCPool(BTC, 'BalancerV2Strat', { poolId, gauge })

    cPool      = deployed.cPool
    controller = deployed.cToken
    strat      = deployed.strategy;

    [btcFeed, balFeed] = await Promise.all([
      ethers.getContractAt('IChainLink', '0xc907E116054Ad103354f2D350FD2514433D57F6f'),
      ethers.getContractAt('IChainLink', '0xD106B538F2A868c28Ca1Ec7E298C3325E0251d66')
    ])

    expect(await strat.identifier()).to.be.equal(`WBTC@BalancerV2#1.0.0`)

    await Promise.all([
      waitFor(strat.setMaxPriceOffset(86400)),
      setChainlinkRoundForNow(btcFeed),
      setChainlinkRoundForNow(balFeed),
      waitFor(strat.setPriceFeed(BTC.address, btcFeed.address)),
      waitFor(strat.setPriceFeed(bal.address, balFeed.address)),
      waitFor(strat.setRewardToWantRoute(bal.address, [bal.address, WETH.address, BTC.address]))
    ])
  })

  // Balancer distribute rewards 1 week after so we can't test the claim part
  it('Full deposit + harvest strat + withdraw', async function () {
    const newBalance = ethers.utils.parseUnits('100', 8)

    await setCustomBalanceFor(BTC.address, bob.address, newBalance)
    expect(await BTC.balanceOf(strat.address)).to.be.equal(0)
    expect(await bal.balanceOf(strat.address)).to.be.equal(0)

    await waitFor(BTC.connect(bob).approve(cPool.address, newBalance))
    await waitFor(cPool.connect(bob)['deposit(uint256)'](await BTC.balanceOf(bob.address)))

    expect(await BTC.balanceOf(controller.address)).to.be.equal(0)
    expect(await BTC.balanceOf(strat.address)).to.be.equal(0)
    expect(await controller.balanceOf(bob.address)).to.be.equal(100e8)

    const balance = await strat.balanceOfPool() // more decimals

    // Simulate claim rewards
    const rewards = ethers.utils.parseUnits('100', 18)

    await setCustomBalanceFor(bal.address, strat.address, rewards)
    expect(await bal.balanceOf(strat.address)).to.be.equal(rewards)
    await strat.setSwapSlippageRatio(9999)
    await waitFor(strat.harvest())
    expect(await strat.balanceOfPool()).to.be.above(balance)

    // withdraw 95% in shares
    const toWithdraw = (await cPool.balanceOf(bob.address)).mul(
      8000
    ).div(10000)
    const expectedOutput = toWithdraw.mul(await cPool.pricePerShare()).div(1e8)

    await strat.setPoolSlippageRatio(150)
    await waitFor(cPool.connect(bob)['withdraw(uint256)'](toWithdraw))


    expect(await BTC.balanceOf(bob.address)).to.within(
      expectedOutput.mul(98).div(100),
      expectedOutput.mul(101).div(100)
    )
    expect(await BTC.balanceOf(strat.address)).to.equal(0)

    await waitFor(cPool.connect(bob).withdrawAll())
    expect(await BTC.balanceOf(bob.address)).to.within(
      expectedOutput,
      expectedOutput.mul(130).div(100)
    )
  })
})
