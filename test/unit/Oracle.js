const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('Oracle', async function () {
  const deploy = async function () {
    const dueDate        = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const [, alice, bob] = await ethers.getSigners()
    const Token          = await ethers.getContractFactory('ERC20Mintable')
    const token          = await Token.deploy('t', 't')
    const CPool          = await ethers.getContractFactory('CollateralPool')
    const LPool          = await ethers.getContractFactory('LiquidityPool')
    const cPool          = await CPool.deploy(token.address)
    const lPool          = await LPool.deploy(token.address, dueDate)
    const cToken         = await (await ethers.getContractFactory('CToken')).attach(await cPool.cToken())
    const lToken         = await (await ethers.getContractFactory('LToken')).attach(await lPool.lToken())
    const globalC        = await (await ethers.getContractFactory('Global')).deploy()
    const Oracle         = await ethers.getContractFactory('Oracle')
    const oracle         = await Oracle.deploy(globalC.address)
    const TokenFeed      = await ethers.getContractFactory('PriceFeedMock')
    const tokenFeed      = await TokenFeed.deploy(13e8)

    await Promise.all([
      globalC.addCollateralPool(cPool.address),
      globalC.addLiquidityPool(lPool.address),
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
      cToken,
      globalC,
      lPool,
      lToken,
      oracle,
      token,
      tokenFeed,
    }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { globalC, Oracle } = await loadFixture(deploy)

      const oracle = await Oracle.deploy(globalC.address)

      expect(oracle.address).to.not.be.equal(ZERO_ADDRESS)
      expect(await oracle.piGlobal()).to.be.equal(globalC.address)
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

    it('Should revert for same quantity', async function () {
      const { oracle } = await loadFixture(deploy)

      await oracle.setPriceTimeToleration(10)

      await expect(oracle.setPriceTimeToleration(10)).to.be.revertedWithCustomError(
        oracle, 'SamePriceTimeToleration'
      )
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
  })
})
