const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { deployOracle, impersonateContract, mine } = require('./helpers')

const setupCollateral = async function (fixtures) {
  const {
    bob,
    cPool,
    piGlobal,
    oracle,
    token,
    tokenFeed
  } = fixtures

  await oracle.addPriceOracle(token.address, tokenFeed.address)
  await piGlobal.addCollateralPool(cPool.address)

  const depositAmount = ethers.utils.parseUnits('9.9', 18)

  await token.mint(bob.address, depositAmount)
  await token.connect(bob).approve(cPool.address, 10e18 + '')

  expect(await token.balanceOf(bob.address)).to.be.equal(depositAmount)

  await expect(cPool.connect(bob)['deposit(uint256)'](depositAmount)).to.emit(cPool, 'Deposit')

  // let's use 1:1 collateral-borrow
  await expect(cPool.setCollateralRatio(0.2e18 + '')).to.emit(cPool, 'NewCollateralRatio')

  expect(await token.balanceOf(bob.address)).to.be.equal(0)
}

describe('Liquidation', async function () {
  const deploy = async function () {
    const [, alice, bob, treasury] = await ethers.getSigners()
    const { piGlobal, oracle }     = await deployOracle()

    const dueDate     = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const token       = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const LPool       = await ethers.getContractFactory('LiquidityPool')
    const CPool       = await ethers.getContractFactory('CollateralPool')
    const LToken      = await ethers.getContractFactory('LToken')
    const DToken      = await ethers.getContractFactory('DToken')
    const DebtSettler = await ethers.getContractFactory('DebtSettler')
    const lPool       = await LPool.deploy(piGlobal.address, token.address, dueDate)
    const cPool       = await CPool.deploy(piGlobal.address, token.address)
    const lToken      = await LToken.attach(await lPool.lToken())
    const dToken      = await DToken.attach(await lPool.dToken())
    const iToken      = await DToken.attach(await lPool.iToken())
    const debtSettler = await DebtSettler.deploy(lPool.address)
    const TokenFeed   = await ethers.getContractFactory('PriceFeedMock')
    const tokenFeed   = await TokenFeed.deploy(13e8)
    const Controller  = await ethers.getContractFactory('Controller')
    const cToken      = await Controller.deploy(cPool.address)

    await Promise.all([
      cPool.setController(cToken.address),
      lPool.setTreasury(treasury.address),
      lPool.setDebtSettler(debtSettler.address),
      lPool.setPiFee(0.02e18 + ''),
      piGlobal.addLiquidityPool(lPool.address),
    ])

    return {
      alice,
      bob,
      cPool,
      cToken,
      dToken,
      piGlobal,
      iToken,
      lPool,
      lToken,
      oracle,
      token,
      tokenFeed,
      treasury,
      DToken,
      LToken,
      CPool,
      LPool,
      DebtSettler,
      TokenFeed,
    }
  }

  afterEach(async function () {
    await network.provider.send("evm_setAutomine", [true]);
  })

  it('should not work for nonPool', async function () {
    const { alice, bob, lPool } = await loadFixture(deploy)

    await expect(
      lPool.liquidate(alice.address, bob.address, 1)
    ).to.be.revertedWithCustomError(lPool, 'UnknownSender')

    await expect(
      lPool.connect(bob).liquidate(alice.address, bob.address, 1)
    ).to.be.revertedWithCustomError(lPool, 'UnknownSender')
  })

  it('should work for due pool with same token', async function () {
    const fixtures = await loadFixture(deploy)

    const {
      alice,
      bob,
      cPool,
      cToken,
      piGlobal,
      token,
      LPool,
      DebtSettler,
    } = fixtures

    const dueDate     = (await ethers.provider.getBlock()).timestamp + (6 * 24 * 60 * 60) // 6 days
    const lPool       = await LPool.deploy(piGlobal.address, token.address, dueDate)
    const debtSettler = await DebtSettler.deploy(lPool.address)

    await Promise.all([
      lPool.setDebtSettler(debtSettler.address),
      token.mint(lPool.address, 10e18 + ''),
      piGlobal.addLiquidityPool(lPool.address),
      setupCollateral({...fixtures, lPool}),
    ])
    // Add liquidity & Repayment
    await token.mint(lPool.address, 10e18 + '')
    await token.mint(bob.address, 10e18 + '')

    const balance = await cToken.balanceOf(bob.address)
    const depositAmount = ethers.utils.parseUnits('9.9', 18)

    // Skip low HF & LF...
    await lPool.connect(bob).borrow(depositAmount.div(10))

    await mine(6 * 24 * 60 * 60 + 20) // 6 days and 20 seconds

    const debt = await lPool['debt(address)'](bob.address)

    // Alice doesn't have any tokens before liquidation call
    expect(await token.balanceOf(alice.address)).to.be.equal(0)

    // Approve for repay
    await token.connect(alice).approve(lPool.address, 100e18 + '')
    await cPool.connect(alice).liquidationCall(bob.address, lPool.address, debt)

    expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
    expect(await token.balanceOf(alice.address)).to.be.equal(debt.div(100)) // 1% of bonus
    expect(await cToken.balanceOf(bob.address)).to.be.equal(
      balance.sub(debt.add(debt.div(100))) // 1% of bonus
    )
  })

  it('should work for due pool with diff token', async function () {
    const fixtures = await loadFixture(deploy)

    const {
      alice,
      bob,
      cPool,
      cToken,
      piGlobal,
      oracle,
      token,
      LPool,
      DebtSettler,
      TokenFeed,
    } = fixtures

    const token2      = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t2', 't2')
    const tokenFeed   = await TokenFeed.deploy(3e8)
    const dueDate     = (await ethers.provider.getBlock()).timestamp + (6 * 24 * 60 * 60) // 6 days
    const lPool       = await LPool.deploy(piGlobal.address, token2.address, dueDate)
    const debtSettler = await DebtSettler.deploy(lPool.address)

    await Promise.all([
      lPool.setDebtSettler(debtSettler.address),
      oracle.addPriceOracle(token2.address, tokenFeed.address),
      piGlobal.addLiquidityPool(lPool.address),
      token2.mint(alice.address, 100e18 + ''),
      token2.mint(lPool.address, 100e18 + ''),
      setupCollateral({...fixtures, lPool}),
    ])

    const cBalance = await cToken.balanceOf(bob.address)
    const tBalance = await token2.balanceOf(alice.address)
    const depositAmount = ethers.utils.parseUnits('9.9', 18)

    // Skip low HF & LF...
    // 13 tokenPrice, 3 token2Price, half borrow capacity
    const borrowAmount = depositAmount.mul(13).div(3).div(10)
    await lPool.connect(bob).borrow(borrowAmount)

    await mine(6 * 24 * 60 * 60 + 10) // 6 days and 10 seconds

    const debt = await lPool['debt(address)'](bob.address)

    // Alice doesn't have any tokens before liquidation call
    expect(await token.balanceOf(alice.address)).to.be.equal(0)

    // Approve for repay
    await token2.connect(alice).approve(lPool.address, 100e18 + '')
    await cPool.connect(alice).liquidationCall(bob.address, lPool.address, debt)

    // with 1% bonus in collateral amount
    const debtInCollateral = debt.mul(3).div(13)
    const liquidableCollateral = debtInCollateral.add(debtInCollateral.div(100))

    expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
    expect(await token.balanceOf(alice.address)).to.be.equal(liquidableCollateral) // 1% of bonus in collateral amount
    expect(await token2.balanceOf(alice.address)).to.be.equal(tBalance.sub(debt)) // Pay debt with own balance
    expect(await cToken.balanceOf(bob.address)).to.be.equal(
      cBalance.sub(liquidableCollateral)
    )
  })

  it('should work for low liquidation factor with diff token', async function () {
    const fixtures = await loadFixture(deploy)

    const {
      alice,
      bob,
      cPool,
      cToken,
      piGlobal,
      oracle,
      token,
      LPool,
      DebtSettler,
      TokenFeed,
    } = fixtures

    const token2      = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t2', 't2')
    const token2Feed  = await TokenFeed.deploy(3e8)
    const dueDate     = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 3600 * 1000)
    const lPool       = await LPool.deploy(piGlobal.address, token2.address, dueDate)
    const debtSettler = await DebtSettler.deploy(lPool.address)

    await Promise.all([
      lPool.setDebtSettler(debtSettler.address),
      oracle.addPriceOracle(token2.address, token2Feed.address),
      oracle.setLiquidationThreshold(0.75e18 + '', 0.85e18 +''),
      piGlobal.addLiquidityPool(lPool.address),
      token2.mint(alice.address, 100e18 + ''),
      token2.mint(lPool.address, 100e18 + ''),
      setupCollateral({...fixtures, lPool}),
    ])

    const depositAmount = ethers.utils.parseUnits('9.9', 18)

    // Skip low HF & LF...
    // 13 tokenPrice, 3 token2Price, total capacity (0.2 collateral ratio)
    const borrowAmount = depositAmount.mul(13).div(3).div(5)
    await lPool.connect(bob).borrow(borrowAmount)

    // Approve for repay
    await token2.connect(alice).approve(lPool.address, 100e18 + '')

    // Mine 10 blocks then freeze automining
    // await mine(10)
    // await network.provider.send("evm_setAutomine", [false]);

    const hf = await oracle.healthFactor(bob.address)
    const LT = await oracle.liquidationThreshold()

    expect(hf).to.be.above(LT)

    // get debt price to be liquidated
    let wantedPrice = (await token2Feed.price()).mul(hf).div(LT.mul(99).div(100))

    await token2Feed.setPrice(wantedPrice);

    expect(await oracle.healthFactor(bob.address)).to.be.below(LT)

    const debt = await lPool['debt(address)'](bob.address)

    // Alice doesn't have any tokens before liquidation call
    expect(await token.balanceOf(alice.address)).to.be.equal(0)

    // should only liquidate max amount
    expect(await oracle.healthFactor(bob.address)).to.be.below(0.75e18 + '')
    await expect(
      cPool.connect(alice).liquidationCall(bob.address, lPool.address, debt)
    ).to.emit(
      cPool, 'LiquidationCall'
    )

    // LiquidationTheshold
    expect(await oracle.healthFactor(bob.address)).to.be.within(0.75e18 + '', 0.85e18 + '')
    expect(await cToken.balanceOf(bob.address)).to.be.within(depositAmount.mul(95).div(100), depositAmount)
    expect(await lPool['debt(address)'](bob.address)).to.be.within(debt.mul(85).div(100), debt.mul(95).div(100))
    expect(await token.balanceOf(alice.address)).to.be.within(0, depositAmount.mul(5).div(100))
  })

  it('should not work for good HF', async function () {
    const fixtures = await loadFixture(deploy)

    const {
      treasury,
      alice,
      bob,
      cPool,
      cToken,
      piGlobal,
      oracle,
      token,
      LPool,
      DebtSettler,
      TokenFeed,
    } = fixtures

    const token2      = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t2', 't2')
    const token2Feed  = await TokenFeed.deploy(3e8)
    const dueDate     = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 3600 * 1000)
    const lPool       = await LPool.deploy(piGlobal.address, token2.address, dueDate)
    const debtSettler = await DebtSettler.deploy(lPool.address)

    await Promise.all([
      lPool.setDebtSettler(debtSettler.address),
      oracle.addPriceOracle(token2.address, token2Feed.address),
      oracle.setLiquidationThreshold('999999999999990000', 1.0e18 +''),
      piGlobal.addLiquidityPool(lPool.address),
      token2.connect(alice).approve(lPool.address, 100e18 + ''),
      token2.mint(alice.address, 100e18 + ''),
      token2.mint(lPool.address, 100e18 + ''),
      setupCollateral({...fixtures, lPool}),
      // prevent debt growth block by block
      // lPool.setInterestRate(0),
    ])

    await expect(
      cPool.connect(alice).liquidationCall(bob.address, lPool.address, 1)
    ).to.be.revertedWithCustomError(
      oracle, 'NothingToLiquidate'
    )

    const depositAmount = ethers.utils.parseUnits('9.9', 18)

    // Skip low HF & LF...
    // 13 tokenPrice, 3 token2Price, total capacity (0.2 collateral ratio)
    const borrowAmount = depositAmount.mul(13).div(3).div(5)
    await lPool.connect(bob).borrow(borrowAmount.sub(1e10))

    await expect(
      cPool.connect(alice).liquidationCall(bob.address, lPool.address, 1)
    ).to.be.revertedWithCustomError(
      oracle, 'NothingToLiquidate'
    )

    // Get HF below 1
    await mine(100)

    await expect(
      cPool.connect(alice).liquidationCall(bob.address, lPool.address, 0)
    ).to.be.revertedWithCustomError(
      cPool, 'CantLiquidate', 'Collateral unused'
    )

    expect(await token.balanceOf(alice.address)).to.be.equal(0)

    // trigger withdrawn != collateral to be used
    const ctroller = await impersonateContract(cToken.address)

    // trigger HF lower than before
    await token.connect(ctroller).transfer(treasury.address, depositAmount.mul(95).div(100))

    // Trigger HF with less than before liquidation
    await expect(
      cPool.connect(alice).liquidationCall(bob.address, lPool.address, 2e18 + '')
    ).to.be.revertedWithCustomError(
      cPool, 'CantLiquidate', 'HF is lower than before'
    )

    await token.connect(treasury).transfer(ctroller.address, depositAmount.mul(95).div(100))

    await expect(
      cPool.connect(alice).liquidationCall(bob.address, lPool.address, 1e18 + '')
    ).to.emit(cPool, 'LiquidationCall')
  })
})
