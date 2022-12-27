const { expect }       = require('chai')
const { loadFixture }  = require("@nomicfoundation/hardhat-network-helpers")
const { ZERO_ADDRESS } = require('./helpers')

describe('PiGlobal', async function () {
  const deploy = async function () {
    const [owner, bob] = await ethers.getSigners()
    const PiGlobal     = await ethers.getContractFactory('PiGlobal')
    const piGlobal     = await PiGlobal.deploy()
    const randomAddr   = ethers.Wallet.createRandom().address

    return { owner, bob, PiGlobal, piGlobal, randomAddr }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { owner, PiGlobal } = await loadFixture(deploy)

      const piGlobal = await PiGlobal.deploy()

      expect(piGlobal.address).to.not.be.equal(ZERO_ADDRESS)
      // Not-initialized pools
      expect(await piGlobal.collateralPools()).to.be.an('array').that.is.empty
      expect(await piGlobal.liquidityPools()).to.be.an('array').that.is.empty
      expect(await piGlobal.hasRole(await piGlobal.DEFAULT_ADMIN_ROLE(), owner.address))
    })
  })

  describe('Collateral Pools', async function () {
    it('Should not add pool for non-admin', async function () {
      const { bob, piGlobal } = await loadFixture(deploy)

      await expect(piGlobal.connect(bob).addCollateralPool('0x' + '1'.repeat(40))).to.be.revertedWithCustomError(
        piGlobal, 'NotAdmin'
      )
    })

    it('Should not add zero address pool', async function () {
      const { piGlobal } = await loadFixture(deploy)

      await expect(piGlobal.addCollateralPool(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        piGlobal,
        'ZeroAddress'
      )

      expect(await piGlobal.collateralPools()).to.be.an('array').that.is.empty
    })

    it('Should add new Pool', async function () {
      const { piGlobal, randomAddr } = await loadFixture(deploy)

      await expect(piGlobal.addCollateralPool(randomAddr)).to.emit(
        piGlobal, 'NewCollateralPool'
      ).withArgs(randomAddr)

      expect(await piGlobal.collateralPools()).to.be.deep.equal([randomAddr])
    })

    it('Should not add same pool', async function () {
      const { piGlobal, randomAddr } = await loadFixture(deploy)

      await expect(piGlobal.addCollateralPool(randomAddr)).to.emit(
        piGlobal, 'NewCollateralPool'
      ).withArgs(randomAddr)

      expect(await piGlobal.collateralPools()).to.be.deep.equal([randomAddr])

      await expect(piGlobal.addCollateralPool(randomAddr)).to.be.revertedWithCustomError(
        piGlobal,
        'AlreadyExists'
      )
    })

    it('Should remove Pool', async function () {
      const { piGlobal, randomAddr } = await loadFixture(deploy)

      await expect(piGlobal.addCollateralPool(randomAddr)).to.emit(
        piGlobal, 'NewCollateralPool'
      ).withArgs(randomAddr)

      expect(await piGlobal.collateralPools()).to.be.deep.equal([randomAddr])

      await expect(piGlobal.removeCollateralPool(randomAddr)).to.emit(
        piGlobal, 'CollateralPoolRemoved'
      ).withArgs(randomAddr)
    })
  })

  describe('Liquidity Pools', async function () {
    it('Should not add pool for non-admin', async function () {
      const { piGlobal, bob } = await loadFixture(deploy)

      await expect(piGlobal.connect(bob).addLiquidityPool('0x' + '1'.repeat(40))).to.be.revertedWithCustomError(
        piGlobal, 'NotAdmin'
      )
    })

    it('Should not add zero address pool', async function () {
      const { piGlobal } = await loadFixture(deploy)

      await expect(piGlobal.addLiquidityPool(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        piGlobal,
        'ZeroAddress'
      )

      expect(await piGlobal.liquidityPools()).to.be.an('array').that.is.empty
    })

    it('Should add new Pool', async function () {
      const { piGlobal, randomAddr } = await loadFixture(deploy)

      await expect(piGlobal.addLiquidityPool(randomAddr)).to.emit(
        piGlobal, 'NewLiquidityPool'
      ).withArgs(randomAddr)

      expect(await piGlobal.liquidityPools()).to.be.deep.equal([randomAddr])
    })

    it('Should not add same pool', async function () {
      const { piGlobal, randomAddr } = await loadFixture(deploy)

      await expect(piGlobal.addLiquidityPool(randomAddr)).to.emit(
        piGlobal, 'NewLiquidityPool'
      ).withArgs(randomAddr)

      expect(await piGlobal.liquidityPools()).to.be.deep.equal([randomAddr])

      await expect(piGlobal.addLiquidityPool(randomAddr)).to.be.revertedWithCustomError(
        piGlobal,
        'AlreadyExists'
      )
    })

    it('Should remove Pool', async function () {
      const { piGlobal, randomAddr } = await loadFixture(deploy)

      await expect(piGlobal.addLiquidityPool(randomAddr)).to.emit(
        piGlobal, 'NewLiquidityPool'
      ).withArgs(randomAddr)

      expect(await piGlobal.liquidityPools()).to.be.deep.equal([randomAddr])

      await expect(piGlobal.removeLiquidityPool(randomAddr)).to.emit(
        piGlobal, 'LiquidityPoolRemoved'
      ).withArgs(randomAddr)
    })
  })
})
