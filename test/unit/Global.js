const { expect }       = require('chai')
const { loadFixture }  = require("@nomicfoundation/hardhat-network-helpers")
const { ZERO_ADDRESS } = require('./helpers').constants

describe('Global', async function() {
  const deploy = async function() {
    const [owner, bob] = await ethers.getSigners()
    const Global       = await ethers.getContractFactory('Global')
    const globalC      = await Global.deploy()
    const randomAddr   = ethers.Wallet.createRandom().address

    return { owner, bob, Global, globalC, randomAddr }
  }

  describe('Deployment', async function() {
    it('Should work', async function() {
      const { owner, Global } = await loadFixture(deploy)

      const globalC = await Global.deploy()

      expect(globalC.address).to.not.be.equal(ZERO_ADDRESS)
      // Not-initialized pools
      expect(await globalC.collateralPools()).to.be.an('array').that.is.empty
      expect(await globalC.liquidityPools()).to.be.an('array').that.is.empty
      expect(await globalC.hasRole(await globalC.DEFAULT_ADMIN_ROLE(), owner.address))
    })
  })

  describe('Collateral Pools', async function() {
    it('Should not add pool for non-admin', async function() {
      const { bob, globalC } = await loadFixture(deploy)

      await expect(globalC.connect(bob).addCollateralPool('0x' + '1'.repeat(40))).to.be.revertedWithCustomError(
        globalC, 'NotAdmin'
      )
    })

    it('Should not add zero address pool', async function() {
      const { globalC } = await loadFixture(deploy)

      await expect(globalC.addCollateralPool(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        globalC,
        'ZeroAddress'
      )

      expect(await globalC.collateralPools()).to.be.an('array').that.is.empty
    })

    it('Should add new Pool', async function() {
      const { globalC, randomAddr } = await loadFixture(deploy)

      await expect(globalC.addCollateralPool(randomAddr)).to.emit(
        globalC, 'NewCollateralPool'
      ).withArgs(randomAddr)

      expect(await globalC.collateralPools()).to.be.deep.equal([randomAddr])
    })

    it('Should not add same pool', async function() {
      const { globalC, randomAddr } = await loadFixture(deploy)

      await expect(globalC.addCollateralPool(randomAddr)).to.emit(
        globalC, 'NewCollateralPool'
      ).withArgs(randomAddr)

      expect(await globalC.collateralPools()).to.be.deep.equal([randomAddr])

      await expect(globalC.addCollateralPool(randomAddr)).to.be.revertedWithCustomError(
        globalC,
        'AlreadyExists'
      )
    })

    it('Should remove Pool', async function() {
      const { globalC, randomAddr } = await loadFixture(deploy)

      await expect(globalC.addCollateralPool(randomAddr)).to.emit(
        globalC, 'NewCollateralPool'
      ).withArgs(randomAddr)

      expect(await globalC.collateralPools()).to.be.deep.equal([randomAddr])

      await expect(globalC.removeCollateralPool(randomAddr)).to.emit(
        globalC, 'CollateralPoolRemoved'
      ).withArgs(randomAddr)
    })
  })

  describe('Liquidity Pools', async function() {
    it('Should not add pool for non-admin', async function() {
      const { globalC, bob } = await loadFixture(deploy)

      await expect(globalC.connect(bob).addLiquidityPool('0x' + '1'.repeat(40))).to.be.revertedWithCustomError(
        globalC, 'NotAdmin'
      )
    })

    it('Should not add zero address pool', async function() {
      const { globalC } = await loadFixture(deploy)

      await expect(globalC.addLiquidityPool(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        globalC,
        'ZeroAddress'
      )

      expect(await globalC.liquidityPools()).to.be.an('array').that.is.empty
    })

    it('Should add new Pool', async function() {
      const { globalC, randomAddr } = await loadFixture(deploy)

      await expect(globalC.addLiquidityPool(randomAddr)).to.emit(
        globalC, 'NewLiquidityPool'
      ).withArgs(randomAddr)

      expect(await globalC.liquidityPools()).to.be.deep.equal([randomAddr])
    })

    it('Should not add same pool', async function() {
      const { globalC, randomAddr } = await loadFixture(deploy)

      await expect(globalC.addLiquidityPool(randomAddr)).to.emit(
        globalC, 'NewLiquidityPool'
      ).withArgs(randomAddr)

      expect(await globalC.liquidityPools()).to.be.deep.equal([randomAddr])

      await expect(globalC.addLiquidityPool(randomAddr)).to.be.revertedWithCustomError(
        globalC,
        'AlreadyExists'
      )
    })

    it('Should remove Pool', async function() {
      const { globalC, randomAddr } = await loadFixture(deploy)

      await expect(globalC.addLiquidityPool(randomAddr)).to.emit(
        globalC, 'NewLiquidityPool'
      ).withArgs(randomAddr)

      expect(await globalC.liquidityPools()).to.be.deep.equal([randomAddr])

      await expect(globalC.removeLiquidityPool(randomAddr)).to.emit(
        globalC, 'LiquidityPoolRemoved'
      ).withArgs(randomAddr)
    })
  })
})
