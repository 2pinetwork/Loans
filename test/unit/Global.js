const { expect }       = require('chai')
const { ZERO_ADDRESS } = require('./helpers').constants

describe('Global', async function() {
  let owner, bob, Global

  before(async function() {
    [owner, bob] = await ethers.getSigners()
    Global  = await ethers.getContractFactory('Global')
  })

  describe('Deployment', async function() {
    it('Should work', async function() {
      const globalC = await Global.deploy()

      expect(globalC.address).to.not.be.equal(ZERO_ADDRESS)
      // Not-initialized pools
      await expect(globalC.collateralPools(0)).to.be.revertedWithoutReason()
      await expect(globalC.liquidityPools(0)).to.be.revertedWithoutReason()
      expect(await globalC.hasRole(await globalC.DEFAULT_ADMIN_ROLE(), owner.address))
    })
  })

  describe('Collateral Pools', async function() {
    let globalC;

    beforeEach(async function() {
      globalC = await Global.deploy()
    })

    it('Should not add pool for non-admin', async () => {
      await expect(globalC.connect(bob).addCollateralPool('0x' + '1'.repeat(40))).to.be.revertedWithCustomError(
        globalC, 'NotAdmin'
      )
    })

    it('Should not add zero address pool', async function() {
      const addr = '0x' + '0'.repeat(40)

      await expect(globalC.addCollateralPool(addr)).to.be.revertedWithCustomError(
        globalC,
        'ZeroAddress'
      )

      await expect(globalC.collateralPools(0)).to.be.revertedWithoutReason()
    })

    it('Should add new Pool', async function() {
      const addr = '0x' + '1'.repeat(40)

      await expect(globalC.addCollateralPool(addr)).to.emit(
        globalC, 'NewCollateralPool'
      ).withArgs(addr)

      expect(await globalC.collateralPools(0)).to.be.equal(addr)
    })

    it('Should not add same pool', async function() {
      const addr = '0x' + '1'.repeat(40)

      await expect(globalC.addCollateralPool(addr)).to.emit(
        globalC, 'NewCollateralPool'
      ).withArgs(addr)

      expect(await globalC.collateralPools(0)).to.be.equal(addr)

      await expect(globalC.addCollateralPool(addr)).to.be.revertedWithCustomError(
        globalC,
        'AlreadyExists'
      )
    })
  })

  describe('Liquidity Pools', async function() {
    let globalC;

    beforeEach(async function() {
      globalC = await Global.deploy()
    })

    it('Should not add pool for non-admin', async () => {
      await expect(globalC.connect(bob).addLiquidityPool('0x' + '1'.repeat(40))).to.be.revertedWithCustomError(
        globalC, 'NotAdmin'
      )
    })

    it('Should not add zero address pool', async function() {
      const addr = '0x' + '0'.repeat(40)

      await expect(globalC.addLiquidityPool(addr)).to.be.revertedWithCustomError(
        globalC,
        'ZeroAddress'
      )

      await expect(globalC.liquidityPools(0)).to.be.revertedWithoutReason()
    })

    it('Should add new Pool', async function() {
      const addr = '0x' + '1'.repeat(40)

      await expect(globalC.addLiquidityPool(addr)).to.emit(
        globalC, 'NewLiquidityPool'
      ).withArgs(addr)

      expect(await globalC.liquidityPools(0)).to.be.equal(addr)
    })

    it('Should not add same pool', async function() {
      const addr = '0x' + '1'.repeat(40)

      await expect(globalC.addLiquidityPool(addr)).to.emit(
        globalC, 'NewLiquidityPool'
      ).withArgs(addr)

      expect(await globalC.liquidityPools(0)).to.be.equal(addr)

      await expect(globalC.addLiquidityPool(addr)).to.be.revertedWithCustomError(
        globalC,
        'AlreadyExists'
      )
    })
  })
})
