const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('Oracle', async function () {
  const deploy = async function () {
    const [, alice, bob] = await ethers.getSigners()
    const token          = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const CPool          = await ethers.getContractFactory('CollateralPool')
    const LPool          = await ethers.getContractFactory('LiquidityPool')
    const cPool          = await CPool.deploy(token.address)
    const lPool          = await LPool.deploy(token.address)
    const cToken         = await (await ethers.getContractFactory('CToken')).attach(await cPool.cToken())
    const lToken         = await (await ethers.getContractFactory('LToken')).attach(await lPool.lToken())
    const globalC        = await (await ethers.getContractFactory('Global')).deploy()
    const Oracle         = await ethers.getContractFactory('Oracle')
    const oracle         = await Oracle.deploy(globalC.address)
    const tokenFeed      = await (await ethers.getContractFactory('PriceFeedMock')).deploy(13e8)

    await Promise.all([
      globalC.addCollateralPool(cPool.address),
      globalC.addLiquidityPool(lPool.address),
    ])

    return { alice, bob, cPool, cToken, globalC, lPool, lToken, oracle, token, tokenFeed, Oracle, LPool }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { globalC, Oracle } = await loadFixture(deploy)

      const oracle = await Oracle.deploy(globalC.address)

      expect(oracle.address).to.not.be.equal(ZERO_ADDRESS)
      expect(await oracle.global()).to.be.equal(globalC.address)
      expect(await oracle.toleration()).to.be.equal(0)
      expect(await oracle.MAX_TOLERATION()).to.be.equal(24 * 3600)
      expect(await oracle.BASE_PRECISION()).to.be.equal(1e18 + '')
    })
  })

  describe('setToleration', async function () {
    it('Should work', async function () {
      const { oracle } = await loadFixture(deploy)

      expect(await oracle.toleration()).to.be.equal(0)

      await expect(oracle.setToleration(10)).to.emit(
        oracle, 'NewToleration'
      ).withArgs(0, 10)

      expect(await oracle.toleration()).to.be.equal(10)
    })

    it('Should revert for same quantity', async function () {
      const { oracle } = await loadFixture(deploy)

      await oracle.setToleration(10)

      await expect(oracle.setToleration(10)).to.be.revertedWithCustomError(
        oracle, 'SameToleration'
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

  describe('availableCollateral', async function () {
    it('Should return right amount for wallet', async function () {
      const { bob, oracle, cPool, token, tokenFeed } = await loadFixture(deploy)
      const amount = ethers.utils.parseUnits('2', 18)

      await oracle.addPriceOracle(token.address, tokenFeed.address),

      expect(await oracle.availableCollateral(bob.address)).to.be.equal(0)

      await token.mint(bob.address, amount)
      await token.connect(bob).approve(cPool.address, amount)

      expect(await cPool.connect(bob)['deposit(uint256)'](amount)).to.emit(cPool, 'Deposit')

      // Feed is 13.0
      expect(await oracle.availableCollateral(bob.address)).to.be.equal(amount.mul(13))
    })
  })

  describe('availableLiquidity', async function () {
    it('Should return right amount for wallet', async function () {
      const { alice, oracle, lPool, token, tokenFeed } = await loadFixture(deploy)
      const amount = ethers.utils.parseUnits('2', 18)

      await oracle.addPriceOracle(token.address, tokenFeed.address),

      expect(await oracle.availableLiquidity()).to.be.equal(0)

      await token.mint(alice.address, amount)
      await token.connect(alice).approve(lPool.address, amount)

      expect(await lPool.connect(alice)['deposit(uint256)'](amount)).to.emit(lPool, 'Deposit')

      // Feed is 13.0
      expect(await oracle.availableLiquidity()).to.be.equal(amount.mul(13))
    })
  })
})
