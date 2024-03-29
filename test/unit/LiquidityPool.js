const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { anyValue }    = require('@nomicfoundation/hardhat-chai-matchers/withArgs')

const {
  deployOracle,
  getInterest,
  impersonateContract,
  mine,
  ZERO_ADDRESS
} = require('../helpers')

const getPiFeeFor = async function (lPool, amount) {
  // 1% piFee
  // 1% per year => amount * 0.02(%) * (seconds) / SECONDS_PER_YEAR
  const [rate, piFee] = await Promise.all([lPool.interestRate(), lPool.piFee()]);

  return amount.mul(piFee).div(piFee.add(rate))
}

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

describe('Liquidity Pool', async function () {
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
      lPool.setPiFee(0.02e18 + ''),
      piGlobal.addLiquidityPool(lPool.address),
      lPool.togglePause(),
    ])

    return {
      alice,
      bob,
      cPool,
      dToken,
      piGlobal,
      iToken,
      lPool,
      lToken,
      oracle,
      debtSettler,
      token,
      tokenFeed,
      treasury,
      Controller,
      DToken,
      LToken,
      CPool,
      LPool,
      DebtSettler,
      TokenFeed,
    }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { piGlobal, token, LPool, LToken } = await loadFixture(deploy)

      const dueDate = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
      const lPool   = await LPool.deploy(piGlobal.address, token.address, dueDate)
      const lToken  = await LToken.attach(await lPool.lToken())

      expect(lPool.address).to.not.be.equal(ZERO_ADDRESS)
      expect(lToken.address).to.not.be.equal(ZERO_ADDRESS)

      expect(await lPool.paused()).to.be.equal(true)
      expect(await lToken.name()).to.be.equal(`2pi Liquidity t - ${dueDate}`)
      expect(await lToken.symbol()).to.be.equal(`2pi-L-t-${dueDate}`)
      expect(await lToken.decimals()).to.be.equal(18)
    })

    it('Should not work', async function () {
      const { piGlobal, token, LPool, lPool } = await loadFixture(deploy)

      const PiGlobal    = await ethers.getContractFactory('PiGlobal')
      const minDuration = await lPool.MIN_DURATION()
      const ts          = (await ethers.provider.getBlock()).timestamp
      const dueDate     = ts + (365 * 24 * 60 * 60)

      await expect(
        LPool.deploy(piGlobal.address, token.address, minDuration.add(ts))
      ).to.be.revertedWithCustomError(LPool, 'DueDateTooSoon')

      await expect(
        LPool.deploy(ZERO_ADDRESS, token.address, dueDate)
      ).to.be.revertedWithCustomError(LPool, 'ZeroAddress')

      const piGlobal2 = await PiGlobal.deploy()

      // ZeroAddress for oracle
      await expect(
        LPool.deploy(piGlobal2.address, token.address, dueDate)
      ).to.be.revertedWithCustomError(LPool, 'ZeroAddress')
    })
  })

  describe('Validations', async function () {
    it('Should not allow pause when non admin', async function () {
      const { lPool, alice } = await loadFixture(deploy)

      await expect(
        lPool.connect(alice).togglePause()
      ).to.be.revertedWithCustomError(lPool, 'NotPauser')
    })

    it('Should toggle pause', async function () {
      const { lPool } = await loadFixture(deploy)

      expect(await lPool.paused()).to.be.equal(false)

      await lPool.togglePause()

      expect(await lPool.paused()).to.be.equal(true)

      await lPool.togglePause()

      expect(await lPool.paused()).to.be.equal(false)
    })

    it('Should not allow set safebox when non admin', async function () {
      const { lPool, alice } = await loadFixture(deploy)

      await expect(
        lPool.connect(alice).setSafeBoxEnabled(true)
      ).to.be.revertedWithCustomError(lPool, 'NotAdmin')
    })

    it('Should revert when deposit zero amount', async function() {
      const { bob, lPool } = await loadFixture(deploy)

      await expect(
        lPool.connect(bob)['deposit(uint256)'](0)
      ).to.be.revertedWithCustomError(lPool, 'ZeroShares')
    })

    it('Should revert when deposit is less than min', async function() {
      const { bob, lPool, token } = await loadFixture(deploy)
      const minSupply             = await lPool.MINIMUM_SUPPLY()

      token.mint(bob.address, minSupply.sub(1))
      token.connect(bob).approve(lPool.address, minSupply.sub(1))

      await expect(
        lPool.connect(bob)['deposit(uint256)'](minSupply.sub(1))
      ).to.be.revertedWithCustomError(lPool, 'LowSupply')
    })

    it('Should revert when withdraw zero shares', async function () {
      const { bob, lPool } = await loadFixture(deploy)

      await expect(
        lPool.connect(bob)['withdraw(uint256)'](0)
      ).to.be.revertedWithCustomError(lPool, 'ZeroShares')
    })
  })

  describe('setOriginatorFee', async function () {
    it('Should not work', async function () {
      const { alice, dToken, lPool } = await loadFixture(deploy)

      await expect(
        lPool.connect(alice).setOriginatorFee(0.01e18 + '')
      ).to.be.revertedWithCustomError(lPool, 'NotAdmin')

      await expect(
        lPool.setOriginatorFee(1.01e18 + '')
      ).to.be.revertedWithCustomError(lPool, 'GreaterThan', 'MAX_RATE')

      const lPoolS = await impersonateContract(lPool.address)

      await dToken.connect(lPoolS).mint(alice.address, 1)

      await expect(
        lPool.setOriginatorFee(0.01e18 + '')
      ).to.be.revertedWithCustomError(lPool, 'AlreadyInitialized')
    })
  })

  describe('setPiFee', async function () {
    it('Should not work', async function () {
      const { alice, dToken, lPool } = await loadFixture(deploy)

      await expect(
        lPool.connect(alice).setPiFee(0.01e18 + '')
      ).to.be.revertedWithCustomError(lPool, 'NotAdmin')

      await expect(
        lPool.setPiFee(1.01e18 + '')
      ).to.be.revertedWithCustomError(lPool, 'GreaterThan', 'MAX_RATE')

      const lPoolS = await impersonateContract(lPool.address)

      await dToken.connect(lPoolS).mint(alice.address, 1)

      await expect(
        lPool.setPiFee(0.01e18 + '')
      ).to.be.revertedWithCustomError(lPool, 'AlreadyInitialized')
    })
  })

  describe('setInterestRate', async function () {
    it('Should work', async function () {
      const { lPool } = await loadFixture(deploy)

      await expect(
        lPool.setInterestRate(0.02e18 + '')
      ).to.emit(lPool, 'NewInterestRate').withArgs(
        0.01e18 + '', 0.02e18 + ''
      )
    })

    it('Should not work', async function () {
      const { alice, dToken, lPool } = await loadFixture(deploy)

      await expect(
        lPool.connect(alice).setInterestRate(0.01e18 + '')
      ).to.be.revertedWithCustomError(lPool, 'NotAdmin')

      await expect(
        lPool.setInterestRate(1.01e18 + '')
      ).to.be.revertedWithCustomError(lPool, 'GreaterThan', 'MAX_RATE')

      const lPoolS = await impersonateContract(lPool.address)

      await dToken.connect(lPoolS).mint(alice.address, 1)

      await expect(
        lPool.setInterestRate(0.01e18 + '')
      ).to.be.revertedWithCustomError(lPool, 'AlreadyInitialized')
    })
  })


  describe('Debt', async function () {
    it('Should work for timestamp = 0', async function () {
      const { bob, dToken, lPool } = await loadFixture(deploy)

      const lPoolS = await impersonateContract(lPool.address)

      // trigger the _timestamp[bob] 0
      await dToken.connect(lPoolS).mint(bob.address, 1)

      expect(await lPool.connect(bob)['debt()']()).to.be.equal(1)
    })
  })

  describe('setTreasury', async function () {
    it('Should not work', async function () {
      const { alice, lPool } = await loadFixture(deploy)

      await expect(
        lPool.connect(alice).setTreasury(alice.address)
      ).to.be.revertedWithCustomError(lPool, 'NotAdmin')

      await expect(
        lPool.setTreasury(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(lPool, 'ZeroAddress')

      await expect(
        lPool.setTreasury(await lPool.treasury())
      ).to.be.revertedWithCustomError(lPool, 'SameValue')
    })
  })

  describe('setDebtSettler', async function () {
    it('Should not work', async function () {
      const { alice, debtSettler, lPool } = await loadFixture(deploy)

      await expect(lPool.setDebtSettler(ZERO_ADDRESS)).to.be.revertedWithCustomError(lPool, 'ZeroAddress')

      await expect(lPool.connect(alice).setDebtSettler(alice.address)).to.be.revertedWithCustomError(lPool, 'NotAdmin')

      await expect(lPool.setDebtSettler(debtSettler.address)).to.emit(
        lPool, 'NewDebtSettler'
      )

      await expect(lPool.setDebtSettler(debtSettler.address)).to.be.revertedWithCustomError(lPool, 'SameValue')
    })
  })

  describe('setSafeBoxEnabled', async function () {
    it('Should not work', async function () {
      const { lPool } = await loadFixture(deploy)

      await expect(lPool.setSafeBoxEnabled(true)).to.emit(lPool, 'SafeBoxChanged')

      await expect(lPool.setSafeBoxEnabled(true)).to.revertedWithCustomError(lPool, 'SameValue')
    })
  })


  describe('Deposit', async function () {
    it('Should work', async function () {
      const { alice, bob, lPool, lToken, token } = await loadFixture(deploy)

      await token.mint(alice.address, 1000)
      await token.mint(bob.address, 1000)
      await token.connect(alice).approve(lPool.address, 1000)
      await token.connect(bob).approve(lPool.address, 1000)

      // Check "expected shares" calculation before deposit
      expect(await lPool.convertToShares(1000)).to.be.equal(1000)
      // Check "expected amount" calculation before deposit
      expect(await lPool.convertToAssets(1000)).to.be.equal(1000)

      // Overloading Ethers-v6
      await expect(lPool.connect(bob)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)

      // Check "expected shares" calculation after deposit
      expect(await lPool.convertToShares(1000)).to.be.equal(1000)
      // Check "expected amount" calculation after deposit
      expect(await lPool.convertToAssets(1000)).to.be.equal(1000)

      await token.mint(lPool.address, 8) // just to change the shares proportion

      await expect(lPool.connect(alice)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await lToken.balanceOf(alice.address)).to.be.within(990, 1000)
      expect(await lPool.balance()).to.be.equal(2008)
    })

    it('Should work with safeBox', async function () {
      const { alice, bob, lPool, lToken, token } = await loadFixture(deploy)

      await expect(lPool.setSafeBoxEnabled(true)).to.emit(lPool, 'SafeBoxChanged')

      await token.mint(alice.address, 1000)
      await token.mint(bob.address, 1000)
      await token.connect(alice).approve(lPool.address, 1000)
      await token.connect(bob).approve(lPool.address, 1000)

      // Overloading Ethers-v6
      await expect(lPool.connect(bob)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)

      await token.mint(lPool.address, 8) // just to change the shares proportion

      await expect(lPool.connect(alice)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await lToken.balanceOf(alice.address)).to.be.within(990, 1000)
      expect(await lPool.balance()).to.be.equal(2008)
    })

    it('Should work on behalf of', async function () {
      const { alice, bob, lPool, lToken, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(lPool.address, 1000)

      expect(await lToken.balanceOf(alice.address)).to.be.equal(0)

      // Overloading Ethers-v6
      await expect(lPool.connect(bob)['deposit(uint256,address)'](1000, alice.address)).to.emit(lPool, 'Deposit')
      expect(await lPool.balanceOf(alice.address)).to.be.equal(1000)
      expect(await lToken.balanceOf(alice.address)).to.be.equal(1000)
      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should not work for expired pool', async function () {
      const { piGlobal, token, LPool, lPool } = await loadFixture(deploy)

      const minDuration = await lPool.MIN_DURATION()
      const dueDate     = minDuration.add((await ethers.provider.getBlock()).timestamp + 10)
      const _lPool      = await LPool.deploy(piGlobal.address, token.address, dueDate)

      await mine(minDuration.add(10))

      await expect(_lPool['deposit(uint256)'](1)).to.be.revertedWithCustomError(_lPool, 'ExpiredPool')
    })

    it('Should not work for non-whitelisted', async function () {
      const { lPool } = await loadFixture(deploy)

      await lPool.setWhitelistEnabled(true)

      await expect(lPool['deposit(uint256)'](1)).to.be.revertedWithCustomError(lPool, 'NotWhitelisted')
    })

    it('Should work for whitelisted', async function () {
      const { alice, bob, lPool, lToken, token } = await loadFixture(deploy)


      await Promise.all([
        lPool.setWhitelistEnabled(true),
        lPool.setWhitelisted(bob.address, true),
        token.mint(alice.address, 1000),
        token.mint(bob.address, 1000),
        token.connect(alice).approve(lPool.address, 1000),
        token.connect(bob).approve(lPool.address, 1000)
      ])

      // Check "expected shares" calculation before deposit
      expect(await lPool.convertToShares(1000)).to.be.equal(1000)
      // Check "expected amount" calculation before deposit
      expect(await lPool.convertToAssets(1000)).to.be.equal(1000)

      // Overloading Ethers-v6
      await expect(lPool.connect(bob)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      // Check "expected shares" calculation after deposit
      expect(await lPool.convertToShares(1000)).to.be.equal(1000)
      // Check "expected amount" calculation after deposit
      expect(await lPool.convertToAssets(1000)).to.be.equal(1000)

      await token.mint(lPool.address, 8) // just to change the shares proportion

      await expect(lPool.connect(alice)['deposit(uint256)'](1000)).to.revertedWithCustomError(
        lPool, 'NotWhitelisted'
      )

      await lPool.setWhitelisted(alice.address, true)

      await expect(lPool.connect(alice)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await lToken.balanceOf(alice.address)).to.be.within(990, 1000)
      expect(await lPool.balance()).to.be.equal(2008)
    })
  })

  describe('Withdraw', async function () {
    it('Should work', async function () {
      const { alice, bob, lPool, lToken, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(lPool.address, 1000)

      // Overloading Ethers-v6
      await expect(lPool.connect(bob)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)


      // Overloading Ethers-v6
      await expect(lPool.connect(bob)['withdraw(uint256)'](10)).to.emit(lPool, 'Withdraw')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(990)
      expect(await token.balanceOf(bob.address)).to.be.equal(10)
      expect(await token.balanceOf(alice.address)).to.be.equal(0)

      await expect(lPool.connect(bob)['withdraw(uint256,address)'](10, alice.address)).to.emit(lPool, 'Withdraw')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(980)
      expect(await token.balanceOf(bob.address)).to.be.equal(10)
      expect(await token.balanceOf(alice.address)).to.be.equal(10)


      await expect(lPool.connect(bob).withdrawAll()).to.emit(lPool, 'Withdraw')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(bob.address)).to.be.equal(990)
    })

    it('Should work when borrowed', async function () {
      const fixtures = await loadFixture(deploy)

      const { alice, bob, lPool, lToken, token } = fixtures

      await setupCollateral(fixtures)

      await token.mint(alice.address, 1001)
      await token.connect(alice).approve(lPool.address, 1001)

      // Overloading Ethers-v6
      await expect(lPool.connect(alice)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(alice.address)).to.be.equal(1000)
      expect(await token.balanceOf(alice.address)).to.be.equal(1)

      await expect(lPool.connect(bob).borrow(900)).to.emit(lPool, 'Borrow').withArgs(bob.address, 900)

      // Check that shares keep tracking
      // Overloading Ethers-v6
      await expect(lPool.connect(alice)['deposit(uint256)'](1)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(alice.address)).to.be.equal(1001)
      expect(await token.balanceOf(alice.address)).to.be.equal(0)

      // Overloading Ethers-v6
      await expect(lPool.connect(alice)['withdraw(uint256)'](102)).to.be.revertedWithCustomError(lPool, 'InsufficientLiquidity')
      expect(await token.balanceOf(alice.address)).to.be.equal(0)

      await expect(lPool.connect(alice)['withdraw(uint256)'](101)).to.emit(lPool, 'Withdraw')

      expect(await lToken.balanceOf(alice.address)).to.be.equal(900)
      expect(await token.balanceOf(alice.address)).to.be.equal(101)
    })

    it('Should work when borrowed with interests', async function () {
      const fixtures = await loadFixture(deploy)

      const { alice, bob, lPool, lToken, token } = fixtures

      await setupCollateral(fixtures)

      await token.mint(alice.address, 1100)
      await token.connect(alice).approve(lPool.address, 1100)

      // Overloading Ethers-v6
      await expect(lPool.connect(alice)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(alice.address)).to.be.equal(1000)
      expect(await token.balanceOf(alice.address)).to.be.equal(100)

      await expect(lPool.connect(bob).borrow(900)).to.emit(lPool, 'Borrow').withArgs(bob.address, 900)

      // Simulate interests
      await token.mint(lPool.address, 50)

      // Check that shares keep tracking (100 * 1000 / 1050 = 95.238)
      // Overloading Ethers-v6
      await expect(lPool.connect(alice)['deposit(uint256)'](100)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(alice.address)).to.be.equal(1095)
      expect(await token.balanceOf(alice.address)).to.be.equal(0)

      expect(await token.balanceOf(lPool.address)).to.be.equal(250)

      // 239 shares == 251 tokens
      // Overloading Ethers-v6
      await expect(lPool.connect(alice)['withdraw(uint256)'](239)).to.be.revertedWithCustomError(lPool, 'InsufficientLiquidity')
      expect(await token.balanceOf(lPool.address)).to.be.equal(250)
      expect(await token.balanceOf(alice.address)).to.be.equal(0)

      await expect(lPool.connect(alice)['withdraw(uint256)'](238)).to.emit(lPool, 'Withdraw')

      expect(await lToken.balanceOf(alice.address)).to.be.equal(1095 - 238)
      expect(await token.balanceOf(alice.address)).to.be.equal(249)
      expect(await token.balanceOf(lPool.address)).to.be.equal(1)
    })
  })

  describe('Borrow', async function () {
    it('Should not work for zero amount', async function () {
      const { bob, lPool } = await loadFixture(deploy)

      await expect(lPool.connect(bob).borrow(0)).to.be.revertedWithCustomError(
        lPool, 'ZeroAmount'
      )
    })

    it('Should not work when paused', async function () {
      const { bob, lPool } = await loadFixture(deploy)

      await lPool.togglePause()

      await expect(
        lPool.connect(bob).borrow(1)
      ).to.be.revertedWith('Pausable: paused')
    })

    it('Should not work without liquidity', async function () {
      const { bob, lPool, token } = await loadFixture(deploy)

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(lPool.connect(bob).borrow(1)).to.be.revertedWithCustomError(
        lPool, 'InsufficientLiquidity'
      )

      await token.mint(lPool.address, 100)

      await expect(lPool.connect(bob).borrow(101)).to.be.revertedWithCustomError(
        lPool, 'InsufficientLiquidity'
      )
    })

    it('Should be reverted without collateral', async function () {
      const {
        bob,
        cPool,
        piGlobal,
        lPool,
        oracle,
        token,
        tokenFeed
      } = await loadFixture(deploy)

      await oracle.addPriceOracle(token.address, tokenFeed.address)
      await piGlobal.addCollateralPool(cPool.address)

      const amount = ethers.utils.parseUnits('9.9', 18)

      await token.mint(lPool.address, amount)
      await token.mint(bob.address, amount)

      expect(await token.balanceOf(bob.address)).to.be.equal(amount)

      // Just to check the case
      await expect(lPool.connect(bob).borrow(amount)).to.be.revertedWithCustomError(lPool, 'InsufficientFunds')
    })

    it('Should work', async function () {
      const fixtures      = await loadFixture(deploy)
      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const { bob, dToken, iToken, lPool, token } = fixtures

      await token.mint(lPool.address, 10e18 + '')

      await setupCollateral(fixtures)

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(lPool.connect(bob).borrow(depositAmount)).to.emit(lPool, 'Borrow').withArgs(bob.address, depositAmount)

      expect(await token.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount)
      expect(await lPool.connect(bob)['debt()']()).to.be.equal(depositAmount)
      expect(await lPool.totalDebt()).to.be.equal(depositAmount)
      expect(await token.balanceOf(lPool.address)).to.be.equal(0.1e18 + '')

      // 100 blocks per 1 second => 100 seconds of interest
      // 1% per year => amount * 0.01(%) * 100(seconds) / SECONDS_PER_YEAR
      await mine(100, 1)
      const expectedDebt = depositAmount.add(
        await getInterest(lPool, depositAmount, 100)
      )

      // Token amount doesn't change, just the debt until the user
      // interacts again with the protocol
      expect(await token.balanceOf(bob.address)).to.be.equal(depositAmount)

      // JS calcs are not the same than solidity
      expect(await lPool['debt(address)'](bob.address)).to.be.within(
        expectedDebt.mul(999).div(1000),
        expectedDebt.mul(1001).div(1000)
      )
    })

    it('Should work for multiple collaterals with different prices', async function () {
      // This test should test the entire flow from collateral with different tokens and
      // different prices, and then borrow with different token and different price
      const fixtures      = await loadFixture(deploy)
      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const {
        bob,
        cPool,
        piGlobal,
        lPool,
        oracle,
        token,
        tokenFeed,
        Controller,
        CPool,
        TokenFeed
      } = fixtures

      // deploy 2 different tokens with Token factory
      const token2     = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t2', 't2')
      const token3     = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t3', 't3')
      const cPool2     = await CPool.deploy(piGlobal.address, token2.address)
      const cPool3     = await CPool.deploy(piGlobal.address, token3.address)
      const tokenFeed2 = await TokenFeed.deploy(0.2e8)
      const tokenFeed3 = await TokenFeed.deploy(1.0e8)
      const controller2 = await Controller.deploy(cPool2.address)
      const controller3 = await Controller.deploy(cPool3.address)

      await Promise.all([
        cPool2.setCollateralRatio(ethers.utils.parseUnits('0.5', 18)),
        cPool3.setCollateralRatio(ethers.utils.parseUnits('0.3', 18)),
        cPool2.setController(controller2.address),
        cPool3.setController(controller3.address),
        piGlobal.addCollateralPool(cPool.address),
        piGlobal.addCollateralPool(cPool2.address),
        piGlobal.addCollateralPool(cPool3.address),
        oracle.addPriceOracle(token.address, tokenFeed.address),
        oracle.addPriceOracle(token2.address, tokenFeed2.address),
        oracle.addPriceOracle(token3.address, tokenFeed3.address),
        token.mint(lPool.address, depositAmount),
        token2.mint(bob.address, depositAmount),
        token3.mint(bob.address, depositAmount),
        token2.connect(bob).approve(cPool2.address, depositAmount),
        token3.connect(bob).approve(cPool3.address, depositAmount),
      ])

      await Promise.all([
        cPool2.connect(bob)['deposit(uint256)'](depositAmount),
        cPool3.connect(bob)['deposit(uint256)'](depositAmount),
      ])

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      // Div(2) == 0.5 collateralRatio // div(5) == 0.2 tokenFeed
      // mul(3).div(10) == 0.3 collateralRatio // 1.0 tokenFeed
      // 13 token price
      const expectedAvailable = (depositAmount.div(2).div(5)).add(
        depositAmount.mul(3e18 + '').div(10e18 + '')
      ).div(13)

      expect(await oracle.availableCollateralForAsset(bob.address, token.address)).to.be.equal(
        expectedAvailable
      )

      await expect(lPool.connect(bob).borrow(expectedAvailable.add(1))).to.be.revertedWithCustomError(
        lPool, 'InsufficientFunds'
      )

      await expect(lPool.connect(bob).borrow(expectedAvailable)).to.emit(lPool, 'Borrow').withArgs(bob.address, expectedAvailable)
    })

    it('Should not work for expired pool', async function () {
      const { piGlobal, token, LPool, lPool } = await loadFixture(deploy)

      const minDuration = await lPool.MIN_DURATION()
      const dueDate     = minDuration.add((await ethers.provider.getBlock()).timestamp + 10)
      const _lPool      = await LPool.deploy(piGlobal.address, token.address, dueDate)

      await _lPool.togglePause()
      await mine(minDuration.add(10))

      await expect(_lPool.borrow(1)).to.be.revertedWithCustomError(_lPool, 'ExpiredPool')

      await expect(
        _lPool['deposit(uint256)'](1)
      ).to.be.revertedWithCustomError(_lPool, 'ExpiredPool')

      await expect(
        _lPool['deposit(uint256,address)'](1, token.address)
      ).to.be.revertedWithCustomError(_lPool, 'ExpiredPool')
    })

    it('Should work with originatorFee', async function () {
      const fixtures     = await loadFixture(deploy)
      const borrowAmount = ethers.utils.parseUnits('9.9', 18)

      const { bob, lPool, dToken, iToken, token, } = fixtures

      await Promise.all([
        lPool.setOriginatorFee(0.01e18 + ''),
        token.mint(lPool.address, 10e18 + ''),
        setupCollateral({...fixtures, lPool})
      ])

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(lPool.connect(bob).borrow(borrowAmount)).to.emit(lPool, 'Borrow').withArgs(bob.address, borrowAmount)

      const originatorFee = borrowAmount.mul(0.01e18 + '').div(1e18 + '')

      // originator fee is minted as interest directly
      expect(await token.balanceOf(bob.address)).to.be.equal(borrowAmount)
      expect(await dToken.balanceOf(bob.address)).to.be.equal(borrowAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(originatorFee)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(borrowAmount.add(originatorFee))
    })
  })

  describe('Repay', async function () {
    it('Should not work for zero amount', async function () {
      const fixtures              = await loadFixture(deploy)
      const { bob, lPool, token } = fixtures

      await setupCollateral(fixtures)

      await token.mint(lPool.address, 100)

      await lPool.connect(bob).borrow(100)

      await expect(lPool.connect(bob).repay(0)).to.be.revertedWithCustomError(lPool, 'ZeroAmount')
    })

    it('Should not work for zero debt', async function () {
      const { bob, lPool } = await loadFixture(deploy)

      await expect(lPool.connect(bob).repay(1)).to.be.revertedWithCustomError(lPool, 'NoDebt')
    })

    it('Should work for expired pool', async function () {
      const fixtures = await loadFixture(deploy)

      const { bob, piGlobal, token, LPool, lPool, DebtSettler } = fixtures

      const minDuration = await lPool.MIN_DURATION()
      const dueDate     = minDuration.add((await ethers.provider.getBlock()).timestamp + 20)
      const _lPool      = await LPool.deploy(piGlobal.address, token.address, dueDate)
      const debtSettler = await DebtSettler.deploy(_lPool.address)

      await Promise.all([
        _lPool.setDebtSettler(debtSettler.address),
        token.mint(_lPool.address, 10e18 + ''),
        piGlobal.addLiquidityPool(_lPool.address),
        setupCollateral({...fixtures, lPool: _lPool}),
        _lPool.togglePause(),
      ])

      // Add tokens for Repayment
      await token.mint(bob.address, 10e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      await _lPool.connect(bob).borrow(depositAmount)

      expect(await _lPool['debt(address)'](bob.address)).to.be.equal(depositAmount)

      await mine(minDuration.add(20))

      await token.connect(bob).approve(_lPool.address, 100e18 + '')

      expect(await _lPool.expired()).to.be.equal(true)

      // Should repay with expired pool
      await expect(_lPool.connect(bob).repay(depositAmount)).to.emit(
        _lPool, 'Repay'
      ).withArgs(
        bob.address, depositAmount
      )
    })
  })

  describe('Repay >= debt', async function () {
    it('Should work for repay == debt', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        bob,
        iToken,
        dToken,
        lPool,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp
      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

      await token.connect(bob).approve(lPool.address, 100e18 + '')

      const seconds        = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interestAmount = await getInterest(lPool, depositAmount, seconds)
      const repayAmount    = depositAmount.add(interestAmount)
      const piFee          = await getPiFeeFor(lPool, interestAmount)

      // Full repay without iTokens minted or burned
      await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
        lPool, 'Repay'
      ).withArgs(
        bob.address, repayAmount
      ).to.emit(
        dToken, 'Transfer' // TMP: Will change for Burn event
      ).withArgs(
        bob.address, ZERO_ADDRESS, depositAmount
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFee
      ).to.not.emit(iToken, 'Transfer') // TMP: Will change for Burn event

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
    })

    it('Should work for repay > debt', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        bob,
        iToken,
        dToken,
        lPool,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp
      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

      await token.connect(bob).approve(lPool.address, 100e18 + '')

      const seconds        = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interestAmount = await getInterest(lPool, depositAmount, seconds)
      const repayAmount    = depositAmount.add(interestAmount)
      const piFee          = await getPiFeeFor(lPool, interestAmount)

      // Extra repay without iTokens minted or burned
      await expect(lPool.connect(bob).repay(repayAmount.add(100))).to.emit(
        lPool, 'Repay'
      ).withArgs(
        bob.address, repayAmount
      ).to.emit(
        dToken, 'Transfer' // TMP: Will change for Burn event
      ).withArgs(
        bob.address, ZERO_ADDRESS, depositAmount
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFee
      ).to.not.emit(iToken, 'Transfer') // TMP: Will change for Burn event

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
    })
  })

  describe('Repay < Debt', async function () {
    it('Should work repay == not-minted-interest', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        bob,
        dToken,
        iToken,
        lPool,
        token
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.connect(bob).approve(lPool.address, 100e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp

      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      await mine(100, 1)

      const seconds  = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interest = await getInterest(lPool, depositAmount, seconds)

      expect(interest).to.be.below(depositAmount)

      // Interest are calculated and minted/burned with each interaction
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

      // Check repay event and "drop" the acumulated interest with no-mint tokens
      await expect(lPool.connect(bob).repay(interest)).to.emit(
        lPool, 'Repay'
      ).withArgs(bob.address, interest).to.not.emit(
        iToken, 'Transfer'// TMP: will change for Mint
      ).to.not.emit(
        dToken, 'Transfer' // TMP: will change for Mint
      )

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )
    })

    it('Should work repay != not-minted-interest', async function () {
      const fixtures = await loadFixture(deploy)
      const {
        bob,
        dToken,
        iToken,
        lPool,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.connect(bob).approve(lPool.address, 100e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp

      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      await mine(100, 1)

      const seconds  = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interest = await getInterest(lPool, depositAmount, seconds)

      expect(interest).to.not.be.equal(depositAmount)

      // Interest are calculated and minted/burned with each interaction
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

      let   repayment    = interest.div(2)
      const interestRest = interest.sub(repayment)
      let   piFee        = await getPiFeeFor(lPool, repayment)

      // Repay < _diff
      await expect(lPool.connect(bob).repay(repayment)).to.emit(
        lPool, 'Repay'
      ).withArgs(bob.address, repayment).to.emit(
        iToken, 'Transfer'// TMP: will change for Mint
      ).withArgs(
        ZERO_ADDRESS, bob.address, interestRest
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFee
      ).to.not.emit(
        dToken, 'Transfer' // TMP: will change for Mint
      )

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount.add(interestRest)
      )

      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(interestRest)

      // 1 block for diff
      repayment = interestRest.div(2).add(await getInterest(lPool, depositAmount, 1))
      piFee     = await getPiFeeFor(lPool, repayment)

      // Repay > _diff
      await expect(lPool.connect(bob).repay(repayment)).to.emit(
        lPool, 'Repay'
      ).withArgs(bob.address, repayment).to.emit(
        iToken, 'Transfer'// TMP: will change for Burn
      ).withArgs(
        bob.address, ZERO_ADDRESS, interestRest.div(2)
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFee
      ).to.not.emit(
        dToken, 'Transfer' // TMP: will change for Mint
      )
    })

    it('Should work repay == not-minted-interest + iTokens (iToken.burn)', async function () {
      const fixtures = await loadFixture(deploy)
      const {
        bob,
        dToken,
        iToken,
        lPool,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.connect(bob).approve(lPool.address, 100e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp

      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      await mine(100, 1)

      const seconds  = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interest = await getInterest(lPool, depositAmount, seconds)

      expect(interest).to.not.be.equal(depositAmount)

      // Interest are calculated and minted/burned with each interaction
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

      let   repayment    = interest.div(2)
      const interestRest = interest.sub(repayment)
      let   piFee        = await getPiFeeFor(lPool, repayment)

      // Repay < _diff
      await expect(lPool.connect(bob).repay(repayment)).to.emit(
        lPool, 'Repay'
      ).withArgs(bob.address, repayment).to.emit(
        iToken, 'Transfer'// TMP: will change for Mint
      ).withArgs(
        ZERO_ADDRESS, bob.address, interestRest
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFee
      ).to.not.emit(
        dToken, 'Transfer' // TMP: will change for Mint
      )

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount.add(interest.sub(repayment))
      )
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(interestRest)

      repayment = interestRest.add(await getInterest(lPool, depositAmount, 1))
      piFee     = await getPiFeeFor(lPool, repayment)

      // Repay == _diff + iTokens
      await expect(lPool.connect(bob).repay(repayment)).to.emit(
        lPool, 'Repay', 'RepayEvent'
      ).withArgs(bob.address, repayment).to.emit(
        iToken, 'Transfer', 'iToken.MintEvent' // TMP: will change for Mint
      ).withArgs(
        bob.address, ZERO_ADDRESS, interestRest
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFee
      ).to.not.emit(
        dToken, 'Transfer', 'dToken.BurnEvent' // TMP: will change for Mint
      )

      // All iTokens burned
      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should work repay > not-minted-interest + iTokens (dToken.burn)', async function () {
      const fixtures = await loadFixture(deploy)
      const {
        bob,
        dToken,
        iToken,
        lPool,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.connect(bob).approve(lPool.address, 100e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp

      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      await mine(100, 1)

      const seconds  = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interest = await getInterest(lPool, depositAmount, seconds)

      expect(interest).to.not.be.equal(depositAmount)

      // Interest are calculated and minted/burned with each interaction
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

      let repayment    = interest.div(2)
      let interestRest = interest.sub(repayment)
      let piFee        = await getPiFeeFor(lPool, repayment)

      // Repay < _diff
      await expect(lPool.connect(bob).repay(repayment)).to.emit(
        lPool, 'Repay'
      ).withArgs(
        bob.address, repayment
      ).to.emit(
        iToken, 'Transfer'// TMP: will change for Mint
      ).withArgs(
        ZERO_ADDRESS, bob.address, interestRest
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFee
      ).to.not.emit(
        dToken, 'Transfer' // TMP: will change for Mint
      )

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount.add(interest.sub(repayment))
      )
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(interestRest)

      // Pay 5 more than all interests
      const totalInterest = interestRest.add(await getInterest(lPool, depositAmount, 1))

      repayment = totalInterest.add(5)
      piFee     = await getPiFeeFor(lPool, totalInterest)

      // Repay == _diff + iTokens
      await expect(lPool.connect(bob).repay(repayment)).to.emit(
        lPool, 'Repay'
      ).withArgs(bob.address, repayment).to.emit(
        iToken, 'Transfer'// TMP: will change for Mint
      ).withArgs(
        bob.address, ZERO_ADDRESS, interestRest
      ).to.emit(
        dToken, 'Transfer' // TMP: will change for Mint
      ).withArgs(
        bob.address, ZERO_ADDRESS, 5
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address,  piFee
      )

      // All iTokens burned
      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount.sub(5)
      )
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount.sub(5))
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)
    })
  })

  describe('Repay with originator Fee', async function () {
    it('Should work for repay == debt', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        bob,
        dToken,
        iToken,
        lPool,
        token,
        treasury,
      } = fixtures

      await Promise.all([
        lPool.setOriginatorFee(0.01e18 + ''),
        token.mint(lPool.address, 10e18 + ''),
        setupCollateral(fixtures),
      ])

      // Add tokens for Repayment
      await token.mint(bob.address, 10e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp
      await lPool.connect(bob).borrow(depositAmount)

      const originatorFee = depositAmount.div(100) // 1% fee

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount.add(originatorFee))

      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(originatorFee)

      await token.connect(bob).approve(lPool.address, 100e18 + '')

      const seconds        = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interestAmount = await getInterest(lPool, depositAmount, seconds)
      const repayAmount    = depositAmount.add(interestAmount).add(originatorFee)
      const piFeeAmount    = (await getPiFeeFor(lPool, interestAmount)).add(originatorFee)

      // Full repay without iTokens minted or burned
      await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
        lPool, 'Repay'
      ).withArgs(
        bob.address, repayAmount
      ).to.emit(
        dToken, 'Transfer' // TMP: Will change for Burn event
      ).withArgs(
        bob.address, ZERO_ADDRESS, depositAmount
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFeeAmount
      ).to.emit(
        iToken, 'Transfer' // TMP: Will change for Burn event
      ).withArgs(
        bob.address, ZERO_ADDRESS, originatorFee
      ).to.emit(
        lPool, 'CollectedFee'
      ).withArgs(piFeeAmount).to.emit(
        lPool, 'CollectedOriginatorFee' // PiFee
      ).withArgs(originatorFee)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
    })

    it('Should work for repay (paying originator fee and keep debt token)', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        bob,
        dToken,
        iToken,
        lPool,
        token,
        treasury,
      } = fixtures

      await Promise.all([
        lPool.setOriginatorFee(0.01e18 + ''),
        token.mint(lPool.address, 10e18 + ''),
        setupCollateral({...fixtures, lPool}),
      ])

      // Add tokens for Repayment
      await token.mint(bob.address, 10e18 + '')


      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp
      await lPool.connect(bob).borrow(depositAmount)

      const originatorFee = depositAmount.div(100) // 1% fee

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount.add(originatorFee))

      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(originatorFee)

      await token.connect(bob).approve(lPool.address, 100e18 + '')

      const seconds        = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interestAmount = await getInterest(lPool, depositAmount, seconds)
      const repayAmount    = depositAmount.add(interestAmount).add(originatorFee.div(2))
      const piFeeAmount    = (await getPiFeeFor(lPool, interestAmount)).add(originatorFee)

      await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
        lPool, 'Repay'
      ).withArgs(
        bob.address, repayAmount
      ).to.emit(
        dToken, 'Transfer' // TMP: Will change for Burn event
      ).withArgs(
        bob.address, ZERO_ADDRESS, depositAmount.sub(originatorFee.div(2))
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFeeAmount
      ).to.emit(
        iToken, 'Transfer' // TMP: Will change for Burn event
      ).withArgs(
        bob.address, ZERO_ADDRESS, originatorFee
      ).to.emit(
        lPool, 'CollectedFee'
      ).withArgs(piFeeAmount).to.emit(
        lPool, 'CollectedOriginatorFee' // PiFee
      ).withArgs(originatorFee)

      expect(await lPool.remainingOriginatorFee(bob.address)).to.be.equal(0)
      expect(await lPool['debt(address)'](bob.address)).to.be.equal(originatorFee.div(2))
    })

    it('Should work for repay < originatorFee', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        bob,
        dToken,
        iToken,
        lPool,
        token,
        treasury,
      } = fixtures

      await Promise.all([
        lPool.setOriginatorFee(0.01e18 + ''),
        token.mint(lPool.address, 10e18 + ''),
        setupCollateral({...fixtures, lPool}),
      ])

      // Add tokens for Repayment
      await token.mint(bob.address, 10e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      await lPool.connect(bob).borrow(depositAmount)

      const originatorFee = depositAmount.div(100) // 1% fee

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount.add(originatorFee))

      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(originatorFee)

      await token.connect(bob).approve(lPool.address, 100e18 + '')

      const repayAmount = originatorFee.div(2)

      // Should send the entire payment to treasury
      await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
        lPool, 'Repay'
      ).withArgs(
        bob.address, repayAmount
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, repayAmount
      ).to.emit(
        lPool, 'CollectedFee'
      ).withArgs(repayAmount).to.emit(
        lPool, 'CollectedOriginatorFee' // PiFee
      ).withArgs(repayAmount)

      expect(await lPool.remainingOriginatorFee(bob.address)).to.be.equal(repayAmount)
    })
  })

  describe('Repay with safeBox enabled', async function () {
    it('Should work repay != not-minted-interest', async function () {
      const fixtures = await loadFixture(deploy)
      const {
        alice,
        bob,
        dToken,
        iToken,
        lPool,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await Promise.all([
        token.mint(alice.address, 10e18 + ''),
        token.mint(bob.address, 10e18 + ''),
        token.connect(bob).approve(lPool.address, 100e18 + ''),
        token.connect(alice).approve(lPool.address, 10e18 + ''),
      ])

      await lPool.connect(alice)['deposit(uint256)'](10e18 + '')




      await expect(lPool.setSafeBoxEnabled(true)).to.emit(lPool, 'SafeBoxChanged')

      const safeBox = await ethers.getContractAt('SafeBox', await lPool.safeBox())

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp


      await lPool.connect(bob).borrow(depositAmount)


      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      await mine(100, 1)

      const seconds  = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interest = await getInterest(lPool, depositAmount, seconds)

      expect(interest).to.not.be.equal(depositAmount)

      // Interest are calculated and minted/burned with each interaction
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(safeBox.address)).to.be.equal(0)

      let   repayment    = interest.div(2)
      const interestRest = interest.sub(repayment)
      let   piFee        = await getPiFeeFor(lPool, repayment)
      let   lPoolBal     = await token.balanceOf(lPool.address)

      // Repay < _diff
      await expect(lPool.connect(bob).repay(repayment)).to.emit(
        lPool, 'Repay'
      ).withArgs(bob.address, repayment).to.emit(
        iToken, 'Transfer'// TMP: will change for Mint
      ).withArgs(
        ZERO_ADDRESS, bob.address, interestRest
      ).to.emit(
        token, 'Transfer' // PiFee
      ).withArgs(
        lPool.address, treasury.address, piFee
      ).to.emit(
        token, 'Transfer' // Payment to safe
      ).withArgs(
        lPool.address, safeBox.address, repayment.sub(piFee)
      ).to.not.emit(
        dToken, 'Transfer' // TMP: will change for Mint
      )

      // lPool shouldn't change
      expect(await token.balanceOf(lPool.address)).to.be.equal(lPoolBal)
      expect(await token.balanceOf(safeBox.address)).to.be.equal(repayment.sub(piFee)).to.be.above(0)

      const safeBoxBal = await token.balanceOf(safeBox.address)

      // lPoolBal should be 0.1e18 after borrow 9.9e18
      // if we add at least 1 token, it should take it from safeBox
      await expect(lPool.connect(alice)['withdraw(uint256)'](lPoolBal.add(1))).to.emit(
        lPool, 'Withdraw'
      ).to.emit(
        token, 'Transfer'
      ).withArgs(safeBox.address, lPool.address, anyValue)

      const diffFromSafe = safeBoxBal.sub(await token.balanceOf(safeBox.address))

      // After withdraw more than lPool has, it only has safeBox balance
      expect(await token.balanceOf(lPool.address)).to.be.equal(0)
      expect(await token.balanceOf(safeBox.address)).to.be.equal(
        repayment.sub(piFee).sub(diffFromSafe)
      )

      // Disable safeBox
      await expect(lPool.setSafeBoxEnabled(false)).to.emit(lPool, 'SafeBoxChanged').withArgs(
        safeBox.address, false
      ).to.emit(
        token, 'Transfer' // safe balance
      ).withArgs(
        safeBox.address, lPool.address, repayment.sub(piFee).sub(diffFromSafe)
      )

      // Just to cover the case enable & disable again
      await expect(lPool.setSafeBoxEnabled(true)).to.emit(lPool, 'SafeBoxChanged').withArgs(
        safeBox.address, true
      ).to.not.emit(
        token, 'Transfer' // safe balance
      )

      await expect(lPool.setSafeBoxEnabled(false)).to.emit(lPool, 'SafeBoxChanged').withArgs(
        safeBox.address, false
      ).to.not.emit(
        token, 'Transfer' // previous safe balance was 0
      )

      // lPool only has repayment amount after LP.withdraw
      expect(await token.balanceOf(lPool.address)).to.be.equal(repayment.sub(piFee).sub(diffFromSafe))
      expect(await token.balanceOf(safeBox.address)).to.be.equal(0)

      lPoolBal = await token.balanceOf(lPool.address)

      // Just check the repay keeps the amount
      await expect(lPool.connect(bob).repay(repayment)).to.emit(lPool, 'Repay')

      expect(await token.balanceOf(lPool.address)).to.be.equal(
        lPoolBal.add(repayment.sub(piFee))
      )
      expect(await token.balanceOf(safeBox.address)).to.be.equal(0) // still without use
    })
  })

  describe('Oracle.HealthFactor', async function () {
    it('Should return valid ratio', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        bob,
        cPool,
        oracle,
        lPool,
        token,
      } = fixtures

      await Promise.all([
        token.mint(lPool.address, 10e18 + ''),
        setupCollateral({...fixtures, lPool}),
      ])

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount)

      let hf = await oracle.healthFactor(bob.address);

      expect(hf).to.be.within(0.99e18 + '', 1.01e18 + '')

      await cPool.setCollateralRatio(0.5e18 + '');

      hf = await oracle.healthFactor(bob.address);

      expect(hf).to.be.within(0.49e18 + '', 0.5e18 + '')

      await cPool.setCollateralRatio(0.3e18 + '');

      hf = await oracle.healthFactor(bob.address);

      expect(hf).to.be.within(0.29e18 + '', 0.3e18 + '')
    })
  })
})
