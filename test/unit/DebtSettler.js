const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { deployOracle, mine, ZERO_ADDRESS } = require('./helpers')

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
  await expect(cPool.setCollateralRatio(1.0e18 + '')).to.emit(cPool, 'NewCollateralRatio')

  expect(await token.balanceOf(bob.address)).to.be.equal(0)
}

const getInterest = async function (lPool, base, seconds) {
  // 1% piFee
  // 1% per year => amount * 0.02(%) * (seconds) / SECONDS_PER_YEAR
  const [rate, piFee] = await Promise.all([lPool.interestRate(), lPool.piFee()]);
  const SECONDS_PER_YEAR = ethers.utils.parseUnits('31536000', 0)
  const PRECISION = ethers.utils.parseUnits('1', 18)

  return base.mul(rate.add(piFee)).mul(seconds).div(SECONDS_PER_YEAR).div(PRECISION)
}

describe('Debt settler', async function () {
  const deploy = async function () {
    const [, alice, bob, treasury] = await ethers.getSigners()
    const { piGlobal, oracle }     = await deployOracle()

    const dueDate     = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const token       = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const LPool       = await ethers.getContractFactory('LiquidityPool')
    const CPool       = await ethers.getContractFactory('CollateralPool')
    const DToken      = await ethers.getContractFactory('DToken')
    const DebtSettler = await ethers.getContractFactory('DebtSettler')
    const lPool       = await LPool.deploy(piGlobal.address, token.address, dueDate)
    const cPool       = await CPool.deploy(piGlobal.address, token.address)
    const dToken      = await DToken.attach(await lPool.dToken())
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
      dToken,
      piGlobal,
      lPool,
      oracle,
      debtSettler,
      token,
      tokenFeed,
      treasury,
      DToken,
      CPool,
      LPool,
      DebtSettler,
      TokenFeed,
    }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { lPool, DebtSettler } = await loadFixture(deploy)
      const debtSettler            = await DebtSettler.deploy(lPool.address)

      await expect(debtSettler.address).to.not.be.equal(ZERO_ADDRESS)
    })

    it('Should fail when zero address', async function () {
      const { DebtSettler } = await loadFixture(deploy)

      await expect(DebtSettler.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        DebtSettler,
        'ZeroAddress'
      )
    })

    it('Should fail when liquidity pool is expired', async function () {
      const { piGlobal, token, DebtSettler, LPool } = await loadFixture(deploy)

      const dueDate = (await ethers.provider.getBlock()).timestamp + 10
      const lPool   = await LPool.deploy(piGlobal.address, token.address, dueDate)

      mine(100)

      await expect(DebtSettler.deploy(lPool.address)).to.be.revertedWithCustomError(
        DebtSettler,
        'InvalidPool'
      )
    })

    it('Should fail when address is not a liquidity pool', async function () {
      const { dToken, DebtSettler } = await loadFixture(deploy)

      await expect(DebtSettler.deploy(dToken.address)).to.be.revertedWithoutReason()
    })
  })

  describe('Validations', async function () {
    it('Should fail when not called by the liquidity pool', async function () {
      const { alice, bob, debtSettler } = await loadFixture(deploy)

      await expect(debtSettler.build(1e18 + '')).to.be.revertedWithCustomError(
        debtSettler,
        'UnknownSender'
      )
    })

    it('Should fail when addBorrower is called from a non liquidity pool', async function () {
      const { alice, debtSettler } = await loadFixture(deploy)

      await expect(debtSettler.addBorrower(alice.address)).to.be.revertedWithCustomError(
        debtSettler,
        'UnknownSender'
      )
    })

    it('Should fail when removeBorrower is called from a non liquidity pool', async function () {
      const { alice, debtSettler } = await loadFixture(deploy)

      await expect(debtSettler.removeBorrower(alice.address)).to.be.revertedWithCustomError(
        debtSettler,
        'UnknownSender'
      )
    })
  })

  describe('Build and pay', async function () {
    it('Should work even when liquidity pool is fresh', async function () {
      const dueDate = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)

      const { piGlobal, token, DebtSettler, LPool } = await loadFixture(deploy)

      const lPool       = await LPool.deploy(piGlobal.address, token.address, dueDate)
      const debtSettler = await DebtSettler.deploy(lPool.address)

      await expect(debtSettler.build('100')).to.be.reverted
    })

    it('Should work for debt settling when amount >= debt', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        alice,
        bob,
        dToken,
        cPool,
        lPool,
        debtSettler,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 40e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.mint(alice.address, 20e18 + '')

      // Alice collateral
      await token.connect(alice).approve(cPool.address, 20e18 + '')
      await expect(cPool.connect(alice)['deposit(uint256)'](20e18 + '')).to.emit(cPool, 'Deposit')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp
      await lPool.connect(bob).borrow(depositAmount)
      await lPool.connect(alice).borrow(depositAmount.mul(2))

      // Since it already compute some interests
      expect(await lPool['debt(address)'](bob.address)).to.be.within(
        depositAmount, depositAmount.add(ethers.utils.parseUnits('0.00001', 18))
      )

      expect(await lPool['debt(address)'](alice.address)).to.be.equal(
        depositAmount.mul(2)
      )

      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await dToken.balanceOf(alice.address)).to.be.equal(depositAmount.mul(2))

      await token.mint(treasury.address, 40e18 + '')
      await token.connect(treasury).approve(lPool.address, 100e18 + '')

      const seconds        = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interestAmount = await getInterest(lPool, depositAmount, seconds)
      const repayAmount    = depositAmount.add(interestAmount).mul(3)

      await lPool.connect(treasury).buildMassiveRepay(repayAmount)
      await debtSettler.connect(treasury).pay()

      // Since debt is calculated before payment, next block we have _some_
      let oneBlockInterestAmount = await getInterest(lPool, depositAmount, 1)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(oneBlockInterestAmount)
      // Alice has double amount deposited, hence twice the interest of bob
      expect(await lPool['debt(address)'](alice.address)).to.be.equal(oneBlockInterestAmount.mul(2))


      // This should have no effect since we already paid the debt
      // and borrowers have been set to zero balance
      await debtSettler.connect(treasury).pay()

      // This should be increased by one block since previous check
      // And a little bit more =)
      expect(await lPool['debt(address)'](bob.address)).to.be.greaterThan(oneBlockInterestAmount)
      // Alice has double amount deposited, hence twice the interest of bob
      expect(await lPool['debt(address)'](alice.address)).to.be.greaterThan(oneBlockInterestAmount.mul(2))

      // Now we check that clean method works
      expect(await debtSettler.recordsLength()).to.be.equal(2)
      await debtSettler.clean()
      expect(await debtSettler.recordsLength()).to.be.equal(0)
    })

    it('Should work for debt settling when amount < debt', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        alice,
        bob,
        dToken,
        cPool,
        lPool,
        debtSettler,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 40e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.mint(alice.address, 20e18 + '')

      // Alice collateral
      await token.connect(alice).approve(cPool.address, 20e18 + '')
      await expect(cPool.connect(alice)['deposit(uint256)'](20e18 + '')).to.emit(cPool, 'Deposit')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      await lPool.connect(bob).borrow(depositAmount)
      await lPool.connect(alice).borrow(depositAmount.mul(2))

      // Since it already compute some interests
      expect(await lPool['debt(address)'](bob.address)).to.be.within(
        depositAmount, depositAmount.add(ethers.utils.parseUnits('0.00001', 18))
      )

      expect(await lPool['debt(address)'](alice.address)).to.be.equal(
        depositAmount.mul(2)
      )

      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await dToken.balanceOf(alice.address)).to.be.equal(depositAmount.mul(2))

      await token.mint(treasury.address, 20e18 + '')
      await token.connect(treasury).approve(lPool.address, 100e18 + '')

      const repayAmount = ethers.utils.parseUnits('20', 18)
      const bobDebt     = await lPool['debt(address)'](bob.address)
      const aliceDebt   = await lPool['debt(address)'](alice.address)
      const totalDebt   = bobDebt.add(aliceDebt)

      await lPool.connect(treasury).buildMassiveRepay(repayAmount)
      await debtSettler.connect(treasury).pay()

      const bobDebtAfter   = await lPool['debt(address)'](bob.address)
      const aliceDebtAfter = await lPool['debt(address)'](alice.address)
      const totalDebtAfter = bobDebtAfter.add(aliceDebtAfter)
      const precision      = ethers.utils.parseUnits('1', 18)
      const totalDebtRatio = totalDebtAfter.mul(precision).div(totalDebt)

      expect(bobDebtAfter).to.be.within(
        bobDebt.mul(totalDebtRatio).mul(1000).div(precision).div(1001),
        bobDebt.mul(totalDebtRatio).mul(1000).div(precision).div(999)
      )
      expect(aliceDebtAfter).to.be.within(
        aliceDebt.mul(totalDebtRatio).mul(1000).div(precision).div(1001),
        aliceDebt.mul(totalDebtRatio).mul(1000).div(precision).div(999)
      )
      expect(totalDebtAfter).to.be.within(
        totalDebt.sub(repayAmount).mul(1000).div(1001),
        totalDebt.sub(repayAmount).mul(1000).div(999)
      )
    })

    it('Should recover _stuck_ founds', async function () {
      const fixtures = await loadFixture(deploy)

      const { debtSettler, token, treasury } = fixtures

      await token.mint(treasury.address, 20e18 + '')
      // We send some _extra_ founds to the contract
      await token.connect(treasury).transfer(debtSettler.address, 20e18 + '')

      expect(await token.balanceOf(debtSettler.address)).to.be.equal(20e18 + '')

      await debtSettler.rescueFounds()

      expect(await token.balanceOf(debtSettler.address)).to.be.equal(0)
      expect(await token.balanceOf(treasury.address)).to.be.equal(20e18 + '')
    })

    it('Should recover no founds when none', async function () {
      const fixtures = await loadFixture(deploy)

      const { debtSettler, token, treasury } = fixtures

      expect(await token.balanceOf(debtSettler.address)).to.be.equal(0)

      await debtSettler.rescueFounds()

      expect(await token.balanceOf(treasury.address)).to.be.equal(0)
    })
  })
})
