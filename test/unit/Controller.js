const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { deployOracle, impersonateContract, ZERO_ADDRESS } = require('../helpers')

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

describe('Controller', async function () {
  const deploy = async function () {
    const [, alice, bob, treasury] = await ethers.getSigners()
    const { piGlobal, oracle }     = await deployOracle()

    const dueDate     = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const Token       = await ethers.getContractFactory('ERC20Mintable')
    const token       = await Token.deploy('t', 't')
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
    const Strat       = await ethers.getContractFactory('MockStrat')

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
      CPool,
      DToken,
      LPool,
      LToken,
      DebtSettler,
      Strat,
      Token,
      TokenFeed,
    }
  }

  describe('Token transfer', async function () {
    it('should work without debt', async function () {
      const fixtures = await loadFixture(deploy)

      const { alice, bob, cToken, oracle } = fixtures

      await setupCollateral(fixtures)

      const balance = await cToken.balanceOf(bob.address)

      expect(await oracle.healthFactor(bob.address)).to.be.equal(ethers.constants.MaxUint256)

      await expect(cToken.connect(bob).transfer(alice.address, balance)).to.emit(cToken, 'Transfer').withArgs(
        bob.address, alice.address, balance
      )
    })

    it('should work with debt for HF > 1.0', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        alice,
        bob,
        cToken,
        piGlobal,
        oracle,
        DebtSettler,
        LPool,
        TokenFeed
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
        lPool.togglePause(),
        setupCollateral({...fixtures, lPool}),
      ])

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      // Skip low HF & LF...
      // 13 tokenPrice, 3 token2Price, half borrow capacity
      const borrowAmount = depositAmount.mul(13).div(3).div(10)
      await expect(lPool.connect(bob).borrow(borrowAmount)).to.emit(lPool, 'Borrow')

      const balance = await cToken.balanceOf(bob.address)

      const hf = await oracle.healthFactor(bob.address)
      expect(hf).to.be.above(1.0e18 + '')

      // Get max collateral transfer for 1.0 HF
      // Has to be more than 1.0 for the interest
      const diffHealthy = balance.mul(ethers.utils.parseUnits('1.00001', 18)).div(hf)
      const diffCritical = balance.mul(ethers.utils.parseUnits('1.0', 18)).div(hf)

      // Test to transfer a little more than HF allows
      await expect(
        cToken.connect(bob).transfer(alice.address, balance.sub(diffCritical))
      ).to.be.revertedWithCustomError(oracle, 'LowHealthFactor')

      await expect(
        cToken.connect(bob).transfer(alice.address, balance.sub(diffHealthy))
      ).to.emit(cToken, 'Transfer').withArgs(bob.address, alice.address, balance.sub(diffHealthy))

      // Check still HF > 1.0 and less than before transfer
      expect(await oracle.healthFactor(bob.address)).to.be.above(1.0e18 + '').to.be.below(hf)
    })
  })

  describe('setTreasury', async function () {
    it('should work', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      const treasury = await cToken.treasury()

      await expect(cToken.connect(bob).setTreasury(bob.address)).to.be.revertedWith('Ownable: caller is not the owner')

      expect(await cToken.treasury()).to.be.equal(treasury)

      await expect(cToken.setTreasury(bob.address)).to.emit(cToken, 'NewTreasury').withArgs(treasury, bob.address)
    })

    it('should not work', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      const treasury = await cToken.treasury()

      await expect(cToken.setTreasury(bob.address)).to.emit(cToken, 'NewTreasury').withArgs(treasury, bob.address)

      await expect(cToken.setTreasury(bob.address)).to.be.revertedWithCustomError(cToken, 'SameValue')

      await expect(cToken.setTreasury(ZERO_ADDRESS)).to.be.revertedWithCustomError(cToken, 'ZeroAddress')
    })
  })

  describe('setWithdrawFee', async function () {
    it('should work', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      await expect(cToken.connect(bob).setWithdrawFee(1)).to.be.revertedWith('Ownable: caller is not the owner')

      await expect(cToken.setWithdrawFee(1)).to.emit(cToken, 'NewWithdrawFee').withArgs(0, 1)
    })

    it('should not work', async function () {
      const fixtures = await loadFixture(deploy)

      const { cToken } = fixtures

      await expect(cToken.setWithdrawFee(0)).to.be.revertedWithCustomError(cToken, 'SameValue')

      await expect(cToken.setWithdrawFee(101)).to.be.revertedWithCustomError(cToken, 'GreaterThan', 'MAX_WITHDRAW_FEE')
    })
  })

  describe('Deposit limit', async function () {
    it('setDepositLimit should work', async function () {
      const fixtures = await loadFixture(deploy)

      const { cToken } = fixtures

      expect(await cToken.availableDeposit()).to.be.equal(ethers.constants.MaxUint256)

      await expect(cToken.setDepositLimit(1)).to.emit(cToken, 'NewDepositLimit').withArgs(0, 1)

      expect(await cToken.availableDeposit()).to.be.equal(1)
    })

    it('setDepositLimit should not work if not owner', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      await expect(
        cToken.connect(bob).setDepositLimit(1)
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('setDepositLimit should not work', async function () {
      const fixtures = await loadFixture(deploy)

      const { cToken } = fixtures

      await expect(cToken.setDepositLimit(0)).to.be.revertedWithCustomError(cToken, 'SameValue')
    })

    it('setUserDepositLimit should work', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      expect(await cToken.availableUserDeposit(bob.address)).to.be.equal(ethers.constants.MaxUint256)

      await expect(cToken.setUserDepositLimit(1)).to.emit(cToken, 'NewUserDepositLimit').withArgs(0, 1)

      expect(await cToken.availableUserDeposit(bob.address)).to.be.equal(1)
    })

    it('setUserDepositLimit should not work if not owner', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      await expect(
        cToken.connect(bob).setUserDepositLimit(1)
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('setUserDepositLimit should not work', async function () {
      const fixtures = await loadFixture(deploy)

      const { cToken } = fixtures

      await expect(cToken.setUserDepositLimit(0)).to.be.revertedWithCustomError(cToken, 'SameValue')
    })
  })

  describe('setMinStrategyDepositAmount', async function () {
    it('should work', async function () {
      const fixtures = await loadFixture(deploy)

      const { cToken } = fixtures

      await expect(
        cToken.setMinStrategyDepositAmount(1)
      ).to.emit(cToken, 'NewMinStrategyDepositAmount').withArgs(0.1e18 + '', 1)
    })

    it('should not work if not owner', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      await expect(
        cToken.connect(bob).setMinStrategyDepositAmount(1)
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('should revert if same value', async function () {
      const fixtures = await loadFixture(deploy)

      const { cToken } = fixtures

      await expect(
        cToken.setMinStrategyDepositAmount(0.1e18 + '')
      ).to.be.revertedWithCustomError(cToken, 'SameValue')
    })

    it('should not deposit on strategy when lower than min strategy deposit amount', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cPool, cToken, token, Strat } = fixtures

      const strategy = await Strat.deploy(cToken.asset())

      await cToken.setStrategy(strategy.address)

      await token.mint(bob.address, 1)
      await token.connect(bob).approve(cPool.address, 1)

      expect(await token.balanceOf(cToken.address)).to.be.equal(0)
      await expect(cPool.connect(bob)['deposit(uint256)'](1)).to.revertedWithCustomError(cToken, 'MinDepositAmountNotReached')
    })
  })

  describe('Strategy', async function () {
    it('setStrategy should work', async function () {
      const { cToken, Strat } = await loadFixture(deploy)

      const strategy = await Strat.deploy(cToken.asset())

      await expect(cToken.setStrategy(strategy.address)).to.emit(cToken, 'StrategyChanged').withArgs(ZERO_ADDRESS, strategy.address)
    })

    it('setStrategy should not work if not owner', async function () {
      const { cToken, Strat, bob } = await loadFixture(deploy)

      const strategy = await Strat.deploy(cToken.asset())

      await expect(
        cToken.connect(bob).setStrategy(strategy.address)
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('setStrategy should not work', async function () {
      const { cToken, token, Strat } = await loadFixture(deploy)

      const strategy = await Strat.deploy(cToken.asset())

      await expect(cToken.setStrategy(strategy.address)).to.emit(cToken, 'StrategyChanged').withArgs(ZERO_ADDRESS, strategy.address)

      await expect(cToken.setStrategy(strategy.address)).to.be.revertedWithCustomError(cToken, 'SameValue')

      await token.mint(strategy.address, 1)
      await strategy.breakRetire(true)

      // retire not return the entire balance
      await expect(cToken.setStrategy(ZERO_ADDRESS)).to.be.revertedWithCustomError(cToken, 'StrategyStillHasDeposits')
    })

    it('setStrategy should work for multiple strats', async function () {
      const { cToken, Strat } = await loadFixture(deploy)

      const strategy  = await Strat.deploy(cToken.asset())
      const strategy2 = await Strat.deploy(cToken.asset())

      await expect(cToken.setStrategy(strategy.address)).to.emit(cToken, 'StrategyChanged').withArgs(ZERO_ADDRESS, strategy.address)

      await expect(cToken.setStrategy(strategy2.address)).to.emit(
        cToken, 'StrategyChanged'
      ).withArgs(
        strategy.address, strategy2.address
      )

      await expect(cToken.setStrategy(ZERO_ADDRESS)).to.emit(
        cToken, 'StrategyChanged'
      ).withArgs(
        strategy2.address, ZERO_ADDRESS
      )
    })

    it('setStrategy should not work for other token', async function () {
      const { cToken, Strat, Token } = await loadFixture(deploy)

      const t        = await Token.deploy('T2', 'T2')
      const strategy = await Strat.deploy(t.address)

      await expect(cToken.setStrategy(strategy.address)).to.be.revertedWithCustomError(cToken, 'NotSameAsset')
    })

    it('deposit & withdraw should work with strategy & wFee', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cPool, cToken, token, treasury, Strat } = fixtures

      const strategy = await Strat.deploy(await cToken.asset())

      await cToken.setWithdrawFee(10)
      await cToken.setTreasury(treasury.address)

      await expect(cToken.setStrategy(strategy.address)).to.be.emit(cToken, 'StrategyChanged').withArgs(ZERO_ADDRESS, strategy.address)

      // test deposit
      await setupCollateral(fixtures)

      // Run the afterWithdraw deposit
      await token.mint(cToken.address, 1)

      await expect(await cPool.connect(bob)['withdraw(uint256)'](1000)).to.emit(cPool, 'Withdraw').to.emit(cToken, 'WithdrawalFee')

      await strategy.pause(true)

      await expect(await cPool.connect(bob)['withdraw(uint256)'](1000)).to.emit(cPool, 'Withdraw').to.emit(cToken, 'WithdrawalFee')
    })

    it('deposit & withdraw should revert with CouldNotWithdrawFromStrategy', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cPool, cToken, treasury, Strat } = fixtures

      const strategy = await Strat.deploy(await cToken.asset())

      await cToken.setWithdrawFee(10)
      await cToken.setTreasury(treasury.address)

      await expect(cToken.setStrategy(strategy.address)).to.be.emit(cToken, 'StrategyChanged').withArgs(ZERO_ADDRESS, strategy.address)

      await setupCollateral(fixtures)
      // Just for testing purposes
      await strategy.breakRetire(true)

      await expect(cPool.connect(bob)['withdraw(uint256)'](1)).to.be.revertedWithCustomError(cToken, 'CouldNotWithdrawFromStrategy')
    })

    it('deposit & withdraw should revert when called by non pool', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      await expect(
        cToken.connect(bob).withdraw(bob.address, bob.address, 1)
      ).to.be.revertedWithCustomError(cToken, 'NotPool')

      await expect(
        cToken.connect(bob).deposit(bob.address, 1)
      ).to.be.revertedWithCustomError(cToken, 'NotPool')
    })

    it('deposit should revert when zero amount', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken, cPool } = fixtures

      const impersonatedPool = await impersonateContract(cPool.address)

      await expect(
        cToken.connect(impersonatedPool).deposit(bob.address, 0)
      ).to.be.revertedWithCustomError(cToken, 'ZeroAmount')
    })

    it('withdraw should revert when zero amount', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken, cPool } = fixtures

      const impersonatedPool = await impersonateContract(cPool.address)

      await expect(
        cToken.connect(impersonatedPool).withdraw(bob.address, bob.address, 0)
      ).to.be.revertedWithCustomError(cToken, 'ZeroShares')
    })

    it('withdrawForLiquidation should revert when zero amount', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken, cPool } = fixtures

      const impersonatedPool = await impersonateContract(cPool.address)

      await expect(
        cToken.connect(impersonatedPool).withdrawForLiquidation(bob.address, 0)
      ).to.be.revertedWithCustomError(cToken, 'ZeroAmount')
    })
  })

  describe('User deposits', function () {
    it('available user deposit should work', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      await setupCollateral(fixtures)
      await cToken.setUserDepositLimit(10e18 + '')

      // Since we deposit 9.9e18, we should be able to deposit 0.1e18 more
      await expect(await cToken.availableUserDeposit(bob.address)).to.be.equal(1e17 + '')
    })

    it('available user deposit should return 0 when limit is exceeded', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, cToken } = fixtures

      await setupCollateral(fixtures)
      await cToken.setUserDepositLimit(1e18 + '')

      // Since we deposit 9.9e18, we should have 0 available
      await expect(await cToken.availableUserDeposit(bob.address)).to.be.equal(0)
    })
  })
})
