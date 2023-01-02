const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const deployOracle = async function () {
  const PiGlobal = await ethers.getContractFactory('PiGlobal')
  const Oracle   = await ethers.getContractFactory('Oracle')
  const piGlobal = await PiGlobal.deploy()
  const oracle   = await Oracle.deploy(piGlobal.address)

  await piGlobal.setOracle(oracle.address)

  return { piGlobal, oracle }
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
  await expect(cPool.setCollateralRatio(0.2e18 + '')).to.emit(cPool, 'NewCollateralRatio')

  expect(await token.balanceOf(bob.address)).to.be.equal(0)
}

describe('Controller', async function () {
  const deploy = async function () {
    const [, alice, bob, treasury] = await ethers.getSigners()
    const { piGlobal, oracle }     = await deployOracle()

    const dueDate    = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const token      = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const LPool      = await ethers.getContractFactory('LiquidityPool')
    const CPool      = await ethers.getContractFactory('CollateralPool')
    const LToken     = await ethers.getContractFactory('LToken')
    const DToken     = await ethers.getContractFactory('DToken')
    const lPool      = await LPool.deploy(piGlobal.address, token.address, dueDate)
    const cPool      = await CPool.deploy(piGlobal.address, token.address)
    const lToken     = await LToken.attach(await lPool.lToken())
    const dToken     = await DToken.attach(await lPool.dToken())
    const iToken     = await DToken.attach(await lPool.iToken())
    const TokenFeed  = await ethers.getContractFactory('PriceFeedMock')
    const tokenFeed  = await TokenFeed.deploy(13e8)
    const Controller = await ethers.getContractFactory('Controller')
    const cToken     = await Controller.deploy(cPool.address)

    await Promise.all([
      cPool.setController(cToken.address),
      lPool.setTreasury(treasury.address),
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
      DToken,
      LToken,
      CPool,
      LPool,
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

      const { alice, bob, cToken, piGlobal, oracle, LPool, TokenFeed } = fixtures

      const token2    = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t2', 't2')
      const tokenFeed = await TokenFeed.deploy(3e8)
      const dueDate   = (await ethers.provider.getBlock()).timestamp + 20
      const lPool     = await LPool.deploy(piGlobal.address, token2.address, dueDate)

      await Promise.all([
        oracle.addPriceOracle(token2.address, tokenFeed.address),
        piGlobal.addLiquidityPool(lPool.address),
        token2.mint(alice.address, 100e18 + ''),
        token2.mint(lPool.address, 100e18 + ''),
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
})
