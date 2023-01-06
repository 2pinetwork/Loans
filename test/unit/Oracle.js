const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers')

describe('Oracle', async function () {
  const deploy = async function () {
    const dueDate        = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const piGlobal       = await (await ethers.getContractFactory('PiGlobal')).deploy()
    const [, alice, bob] = await ethers.getSigners()
    const Token          = await ethers.getContractFactory('ERC20Mintable')
    const token          = await Token.deploy('t', 't')
    const CPool          = await ethers.getContractFactory('CollateralPool')
    const LPool          = await ethers.getContractFactory('LiquidityPool')
    const Oracle         = await ethers.getContractFactory('Oracle')
    const oracle         = await Oracle.deploy(piGlobal.address)

    await piGlobal.setOracle(oracle.address)

    const cPool      = await CPool.deploy(piGlobal.address, token.address)
    const lPool      = await LPool.deploy(piGlobal.address, token.address, dueDate)
    const Controller = await ethers.getContractFactory('Controller')
    const cToken     = await Controller.deploy(cPool.address)
    const TokenFeed  = await ethers.getContractFactory('PriceFeedMock')
    const tokenFeed  = await TokenFeed.deploy(13e8)

    await Promise.all([
      cPool.setController(cToken.address),
      piGlobal.addCollateralPool(cPool.address),
      piGlobal.addLiquidityPool(lPool.address),
      // let's use 1:1 collateral-borrow
      cPool.setCollateralRatio(1.0e18 + ''),
    ])

    return {
      LPool,
      Oracle,
      Token,
      TokenFeed,
      alice,
      bob,
      cPool,
      piGlobal,
      lPool,
      oracle,
      token,
      tokenFeed,
    }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { piGlobal, Oracle } = await loadFixture(deploy)

      const oracle = await Oracle.deploy(piGlobal.address)

      expect(oracle.address).to.not.be.equal(ZERO_ADDRESS)
      expect(await oracle.piGlobal()).to.be.equal(piGlobal.address)
      expect(await oracle.priceTimeToleration()).to.be.equal(0)
      expect(await oracle.MAX_PRICE_TIME_TOLERATION()).to.be.equal(24 * 3600)
      expect(await oracle.BASE_PRECISION()).to.be.equal(1e18 + '')
    })
  })

  describe('setPriceTimeToleration', async function () {
    it('Should work', async function () {
      const { oracle } = await loadFixture(deploy)

      expect(await oracle.priceTimeToleration()).to.be.equal(0)

      await expect(oracle.setPriceTimeToleration(10)).to.emit(
        oracle, 'NewPriceTimeToleration'
      ).withArgs(0, 10)

      expect(await oracle.priceTimeToleration()).to.be.equal(10)
    })

    it('Should revert when called by no admin', async function () {
      const { oracle, bob } = await loadFixture(deploy)

      await expect(
        oracle.connect(bob).setPriceTimeToleration(10)
      ).to.be.revertedWithCustomError(oracle, 'NotAdmin')
    })

    it('Should revert for same quantity', async function () {
      const { oracle } = await loadFixture(deploy)

      await oracle.setPriceTimeToleration(10)

      await expect(oracle.setPriceTimeToleration(10)).to.be.revertedWithCustomError(
        oracle, 'SameValue'
      )
    })

    it('Should revert for exceeding max', async function () {
      const { oracle } = await loadFixture(deploy)
      const MAX        = await oracle.MAX_PRICE_TIME_TOLERATION()

      await expect(
        oracle.setPriceTimeToleration(MAX.add(1))
      ).to.be.revertedWithCustomError(oracle, 'MaxPriceTimeToleration')
    })
  })

  describe('setLiquidationThreshold', async function () {
    it('Should work', async function () {
      const { oracle } = await loadFixture(deploy)

      expect(await oracle.liquidationThreshold()).to.be.equal(0.5e18 + '')
      expect(await oracle.liquidationExpectedHF()).to.be.equal(0.6e18 + '')

      await expect(oracle.setLiquidationThreshold(0.65e18 + '', 0.75e18 + '')).to.emit(
        oracle, 'NewLiquidationThreshold'
      ).withArgs(0.5e18 + '', 0.65e18 + '', 0.6e18 + '', 0.75e18 + '')

      expect(await oracle.liquidationThreshold()).to.be.equal(0.65e18 + '')
      expect(await oracle.liquidationExpectedHF()).to.be.equal(0.75e18 + '')
    })

    it('Should revert when not called by admin', async function () {
      const { oracle, alice } = await loadFixture(deploy)

      await expect(
        oracle.connect(alice).setLiquidationThreshold(0.5e18 + '', 0.6e18 + '')
      ).to.be.revertedWithCustomError(oracle, 'NotAdmin')
    })

    it('Should revert for same quantity', async function () {
      const { oracle } = await loadFixture(deploy)

      await expect(
        oracle.setLiquidationThreshold(0.5e18 + '', 0.6e18 + '')
      ).to.be.revertedWithCustomError(oracle, 'SameValue')
    })

    it('Should revert for exceeding max', async function () {
      const { oracle } = await loadFixture(deploy)

      await expect(
        oracle.setLiquidationThreshold(1.1e18 + '', 1e18 + '')
      ).to.be.revertedWithCustomError(oracle, 'GreaterThan').withArgs('LT > MAX_THRESHOLD')
    })

    it('Should revert for threshold below min', async function () {
      const { oracle } = await loadFixture(deploy)

      await expect(
        oracle.setLiquidationThreshold(0.1e18 + '', 0.2e18 + '')
      ).to.be.revertedWithCustomError(oracle, 'LessThan').withArgs('LT < MIN_THRESHOLD')
    })

    it('Should revert for HF exceeding max', async function () {
      const { oracle } = await loadFixture(deploy)

      await expect(
        oracle.setLiquidationThreshold(0.5e18 + '', 1.1e18 + '')
      ).to.be.revertedWithCustomError(oracle, 'GreaterThan').withArgs('LExpectedHF > MAX_THRESHOLD')
    })

    it('Should revert for expected HF below min', async function () {
      const { oracle } = await loadFixture(deploy)

      await expect(
        oracle.setLiquidationThreshold(0.5e18 + '', 0.1e18 + '')
      ).to.be.revertedWithCustomError(oracle, 'LessThan').withArgs('LExpectedHF < LT')
    })
  })

  describe('setLiquidationBonus', async function () {
    it('Should work', async function () {
      const { oracle } = await loadFixture(deploy)

      expect(await oracle.liquidationBonus()).to.be.equal(0.01e18 + '')

      await expect(oracle.setLiquidationBonus(0.02e18 + '')).to.emit(
        oracle, 'NewLiquidationBonus'
      ).withArgs(0.01e18 + '', 0.02e18 + '')

      expect(await oracle.liquidationBonus()).to.be.equal(0.02e18 + '')
    })

    it('Should revert when not called by admin', async function () {
      const { oracle, alice } = await loadFixture(deploy)

      await expect(
        oracle.connect(alice).setLiquidationBonus(0.02e18 + '')
      ).to.be.revertedWithCustomError(oracle, 'NotAdmin')
    })

    it('Should revert for same quantity', async function () {
      const { oracle } = await loadFixture(deploy)

      await expect(
        oracle.setLiquidationBonus(0.01e18 + '')
      ).to.be.revertedWithCustomError(oracle, 'SameValue')
    })

    it('Should revert for exceeding max', async function () {
      const { oracle } = await loadFixture(deploy)

      await expect(
        oracle.setLiquidationBonus(0.3e18 + '')
      ).to.be.revertedWithCustomError(oracle, 'GreaterThan').withArgs('MAX_LIQUIDATION_BONUS')
    })
  })

  describe('addPriceOracle', async function () {
    it('Should work', async function () {
      const { oracle, token, tokenFeed } = await loadFixture(deploy)

      await expect(oracle.addPriceOracle(token.address, tokenFeed.address)).to.emit(
        oracle, 'NewPriceFeed'
      ).withArgs(token.address, tokenFeed.address)

      expect(await oracle.priceFeeds(token.address)).to.be.equal(tokenFeed.address)
    })

    it('Should revert when not called by admin', async function () {
      const { oracle, alice, token, tokenFeed } = await loadFixture(deploy)

      await expect(
        oracle.connect(alice).addPriceOracle(token.address, tokenFeed.address)
      ).to.be.revertedWithCustomError(oracle, 'NotAdmin')
    })

    it('Should revert for same oracle', async function () {
      const { oracle, token, tokenFeed } = await loadFixture(deploy)

      await oracle.addPriceOracle(token.address, tokenFeed.address)

      await expect(
        oracle.addPriceOracle(token.address, tokenFeed.address)
      ).to.be.revertedWithCustomError(oracle, 'SameValue')
    })

    it('Should revert for zero address', async function () {
      const { oracle, tokenFeed } = await loadFixture(deploy)

      await expect(
        oracle.addPriceOracle(ZERO_ADDRESS, tokenFeed.address)
      ).to.be.revertedWithCustomError(oracle, 'ZeroAddress')
    })

    it('Should revert for zero price feed', async function () {
      const { oracle, token, tokenFeed } = await loadFixture(deploy)

      await tokenFeed.setPrice(0)

      await expect(
        oracle.addPriceOracle(token.address, tokenFeed.address)
      ).to.be.revertedWithCustomError(oracle, 'InvalidFeed').withArgs(token.address)
    })
  })

  describe('healthFactor', async function () {
    it('Should work', async function () {
      const MAX_INT                             = ethers.constants.MaxUint256
      const { oracle, token, tokenFeed, alice } = await loadFixture(deploy)

      await oracle.addPriceOracle(token.address, tokenFeed.address)

      await expect(await oracle.healthFactor(alice.address)).to.be.equal(MAX_INT)
    })

    it('Should revert for price zero', async function () {
      const { oracle, token, tokenFeed, alice } = await loadFixture(deploy)

      await oracle.addPriceOracle(token.address, tokenFeed.address)

      await tokenFeed.setPrice(0)

      await expect(
        oracle.healthFactor(alice.address)
      ).to.be.revertedWithCustomError(oracle, 'InvalidFeed').withArgs(token.address)
    })
  })

  describe('availableCollateralForAsset', async function () {
    it('Should return right amount for wallet (and same token)', async function () {
      const { bob, oracle, cPool, token, tokenFeed } = await loadFixture(deploy)
      const amount = ethers.utils.parseUnits('2', 18)

      await oracle.addPriceOracle(token.address, tokenFeed.address),

      expect(await oracle.availableCollateralForAsset(bob.address, token.address)).to.be.equal(0)

      await token.mint(bob.address, amount)
      await token.connect(bob).approve(cPool.address, amount)

      expect(await cPool.connect(bob)['deposit(uint256)'](amount)).to.emit(cPool, 'Deposit')

      // Feed is 13.0 in both cases so 1:1
      expect(await oracle.availableCollateralForAsset(bob.address, token.address)).to.be.equal(amount)
    })

    it('Should return right amount for wallet with different tokens', async function () {
      const { bob, oracle, cPool, token, tokenFeed, Token, TokenFeed } = await loadFixture(deploy)
      const amount = ethers.utils.parseUnits('2', 18)

      const newToken = await Token.deploy('n', 'n')
      const newFeed  = await TokenFeed.deploy(0.3e8) // 30c per token

      await oracle.addPriceOracle(token.address, tokenFeed.address),
      await oracle.addPriceOracle(newToken.address, newFeed.address),

      // No deposits
      expect(await oracle.availableCollateralForAsset(bob.address, newToken.address)).to.be.equal(0)

      await token.mint(bob.address, amount)
      await token.connect(bob).approve(cPool.address, amount)

      expect(await cPool.connect(bob)['deposit(uint256)'](amount)).to.emit(cPool, 'Deposit')

      // Feed is 13.0 in both cases so 1:1
      expect(await oracle.availableCollateralForAsset(bob.address, newToken.address)).to.be.equal(
        amount.mul(13e18 + '').div(0.3e18 + '')
      ).to.be.equal(86666666666666666666n) // just to be sure =D
    })

    it('Should return right amount for wallet with 50% of collateral ratio (and same token)', async function () {
      const { bob, oracle, cPool, token, tokenFeed } = await loadFixture(deploy)
      const amount = ethers.utils.parseUnits('2', 18)

      await cPool.setCollateralRatio(0.5e18 + '')

      await oracle.addPriceOracle(token.address, tokenFeed.address),

      expect(await oracle.availableCollateralForAsset(bob.address, token.address)).to.be.equal(0)

      await token.mint(bob.address, amount)
      await token.connect(bob).approve(cPool.address, amount)

      expect(await cPool.connect(bob)['deposit(uint256)'](amount)).to.emit(cPool, 'Deposit')

      // Feed is 13.0 in both cases so 1:1
      expect(await oracle.availableCollateralForAsset(bob.address, token.address)).to.be.equal(amount.div(2))
    })

    it('Should revert for price zero', async function () {
      const { bob, oracle, cPool, token, tokenFeed } = await loadFixture(deploy)
      const amount = ethers.utils.parseUnits('2', 18)

      await oracle.addPriceOracle(token.address, tokenFeed.address),

      expect(await oracle.availableCollateralForAsset(bob.address, token.address)).to.be.equal(0)

      await token.mint(bob.address, amount)
      await token.connect(bob).approve(cPool.address, amount)

      expect(await cPool.connect(bob)['deposit(uint256)'](amount)).to.emit(cPool, 'Deposit')

      await tokenFeed.setPrice(0)

      await expect(
        oracle.availableCollateralForAsset(bob.address, token.address)
      ).to.be.revertedWithCustomError(oracle, 'InvalidFeed').withArgs(token.address)
    })
  })
})
