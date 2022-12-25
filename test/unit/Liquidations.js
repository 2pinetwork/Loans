const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers').constants

const toHex = (n) => {
  return ethers.utils.hexlify(n).replace(/^0x0/, '0x')
}

const mine = async function (n, time) {
  const args = [toHex(n)]

  if (time) args.push(toHex(time))

  await hre.network.provider.send("hardhat_mine", args);
}

const getPiFeeFor = async function (lPool, amount) {
  // 1% piFee
  // 1% per year => amount * 0.02(%) * (seconds) / SECONDS_PER_YEAR
  const [rate, piFee] = await Promise.all([lPool.interestRate(), lPool.piFee()]);

  return amount.mul(piFee).div(piFee.add(rate))
}

const getInterest = async function (lPool, base, seconds) {
  // 1% piFee
  // 1% per year => amount * 0.02(%) * (seconds) / SECONDS_PER_YEAR
  const [rate, piFee] = await Promise.all([lPool.interestRate(), lPool.piFee()]);
  const SECONDS_PER_YEAR = ethers.utils.parseUnits('31536000', 0)
  const PRECISION = ethers.utils.parseUnits('1', 18)

  return base.mul(rate.add(piFee)).mul(seconds).div(SECONDS_PER_YEAR).div(PRECISION)
}

const deployOracle = async function () {
  const GlobalC = await ethers.getContractFactory('Global')
  const Oracle  = await ethers.getContractFactory('Oracle')
  const globalC = await GlobalC.deploy()
  const oracle  = await Oracle.deploy(globalC.address)

  return { globalC, oracle }
}

const setupCollateral = async function (fixtures) {
  const {
    bob,
    cPool,
    globalC,
    oracle,
    token,
    tokenFeed
  } = fixtures

  await oracle.addPriceOracle(token.address, tokenFeed.address)
  await globalC.addCollateralPool(cPool.address)

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
    const { globalC, oracle }      = await deployOracle()

    const dueDate    = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const token      = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const LPool      = await ethers.getContractFactory('LiquidityPool')
    const CPool      = await ethers.getContractFactory('CollateralPool')
    const LToken     = await ethers.getContractFactory('LToken')
    const DToken     = await ethers.getContractFactory('DToken')
    const lPool      = await LPool.deploy(token.address, dueDate)
    const cPool      = await CPool.deploy(token.address)
    const lToken     = await LToken.attach(await lPool.lToken())
    const dToken     = await DToken.attach(await lPool.dToken())
    const iToken     = await DToken.attach(await lPool.iToken())
    const TokenFeed  = await ethers.getContractFactory('PriceFeedMock')
    const tokenFeed  = await TokenFeed.deploy(13e8)
    const CToken     = await ethers.getContractFactory('CToken')
    const cToken     = await CToken.attach(cPool.cToken())

    await Promise.all([
      lPool.setOracle(oracle.address),
      lPool.setTreasury(treasury.address),
      lPool.setPiFee(0.02e18 + ''),
      globalC.addLiquidityPool(lPool.address),
    ])

    return {
      alice,
      bob,
      cPool,
      cToken,
      dToken,
      globalC,
      iToken,
      lPool,
      lToken,
      oracle,
      token,
      tokenFeed,
      treasury,
      CToken,
      DToken,
      LToken,
      CPool,
      LPool,
      TokenFeed,
    }
  }

  describe('Liquidation', async function () {
    afterEach(async function () {
      await network.provider.send("evm_setAutomine", [true]);
    })

    it('should work for due pool with same token', async function () {
      const fixtures = await loadFixture(deploy)

      const { alice, bob, cPool, cToken, globalC, oracle, token, LPool } = fixtures

      const dueDate = (await ethers.provider.getBlock()).timestamp + 20
      const lPool   = await LPool.deploy(token.address, dueDate)

      await Promise.all([
        globalC.setOracle(oracle.address),
        token.mint(lPool.address, 10e18 + ''),
        lPool.setOracle(oracle.address),
        cPool.setPiGlobal(globalC.address),
        globalC.addLiquidityPool(lPool.address),
        setupCollateral({...fixtures, lPool}),
      ])
      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')

      const balance = await cToken.balanceOf(bob.address)
      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      // Skip low HF & LF...
      await lPool.connect(bob).borrow(depositAmount.div(10))

      await mine(20)

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

      const { alice, bob, cPool, cToken, globalC, oracle, token, LPool, TokenFeed } = fixtures

      const token2    = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t2', 't2')
      const tokenFeed = await TokenFeed.deploy(3e8)
      const dueDate   = (await ethers.provider.getBlock()).timestamp + 20
      const lPool     = await LPool.deploy(token2.address, dueDate)

      await Promise.all([
        cPool.setPiGlobal(globalC.address),
        globalC.addLiquidityPool(lPool.address),
        globalC.setOracle(oracle.address),
        lPool.setOracle(oracle.address),
        oracle.addPriceOracle(token2.address, tokenFeed.address),
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

      await mine(10)

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

      const { alice, bob, cPool, cToken, globalC, oracle, token, LPool, TokenFeed } = fixtures

      const token2     = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t2', 't2')
      const token2Feed = await TokenFeed.deploy(3e8)
      const dueDate    = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 3600 * 1000)
      const lPool      = await LPool.deploy(token2.address, dueDate)

      await Promise.all([
        cPool.setPiGlobal(globalC.address),
        globalC.addLiquidityPool(lPool.address),
        globalC.setOracle(oracle.address),
        lPool.setOracle(oracle.address),
        oracle.addPriceOracle(token2.address, token2Feed.address),
        oracle.setLiquidationThreshold(0.75e18 + '', 0.85e18 +''),
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

      const [hf] = await oracle.healthFactor(bob.address)
      const LT = await oracle.liquidationThreshold()

      expect(hf).to.be.above(LT)

      // get debt price to be liquidated
      let wantedPrice = (await token2Feed.price()).mul(hf).div(LT.mul(99).div(100))

      await token2Feed.setPrice(wantedPrice);

      expect((await oracle.healthFactor(bob.address))[0]).to.be.below(LT)

      const debt = await lPool['debt(address)'](bob.address)

      // Alice doesn't have any tokens before liquidation call
      expect(await token.balanceOf(alice.address)).to.be.equal(0)

      // should only liquidate max amount
      expect((await oracle.healthFactor(bob.address))[0]).to.be.below(0.75e18 + '')
      await expect(
        cPool.connect(alice).liquidationCall(bob.address, lPool.address, debt)
      ).to.emit(
        cPool, 'LiquidationCall'
      )

      // LiquidationTheshold
      expect((await oracle.healthFactor(bob.address))[0]).to.be.within(0.75e18 + '', 0.85e18 + '')
      expect(await cToken.balanceOf(bob.address)).to.be.within(depositAmount.mul(95).div(100), depositAmount)
      expect(await lPool['debt(address)'](bob.address)).to.be.within(debt.mul(85).div(100), debt.mul(95).div(100))
      expect(await token.balanceOf(alice.address)).to.be.within(0, depositAmount.mul(5).div(100))
    })
  })
})
