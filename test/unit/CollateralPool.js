const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers')

describe('Collateral Pool', async function () {
  const deploy = async function () {
    const [, alice, bob] = await ethers.getSigners()
    const PiGlobal       = await ethers.getContractFactory('PiGlobal')
    const Oracle         = await ethers.getContractFactory('Oracle')
    const piGlobal       = await PiGlobal.deploy()
    const oracle         = await Oracle.deploy(piGlobal.address)

    await piGlobal.setOracle(oracle.address)

    const token  = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const Pool   = await ethers.getContractFactory('CollateralPool')
    const Controller = await ethers.getContractFactory('Controller')
    const pool   = await Pool.deploy(piGlobal.address, token.address)
    const cToken = await Controller.deploy(pool.address)

    await pool.setController(cToken.address)

    return { alice, bob, cToken, piGlobal, oracle, pool, token, Controller, Pool }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { pool, cToken } = await loadFixture(deploy)

      expect(pool.address).to.not.be.equal(ZERO_ADDRESS)
      expect(cToken.address).to.not.be.equal(ZERO_ADDRESS)

      expect(await cToken.name()).to.be.equal("2pi Collateral t")
      expect(await cToken.symbol()).to.be.equal("2pi-C-t")
      expect(await cToken.decimals()).to.be.equal(18)
    })
  })

  describe('Deposit', async function () {
    it('Should work', async function () {
      const { alice, bob, cToken, pool, token } = await loadFixture(deploy)

      await token.mint(alice.address, 1000)
      await token.mint(bob.address, 1000)
      await token.connect(alice).approve(pool.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)

      await token.mint(cToken.address, 8) // just to change the shares proportion

      expect(await pool.connect(alice)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await cToken.balanceOf(alice.address)).to.be.equal(992)
      expect(await pool.balance()).to.be.equal(2008)
    })
  })

  describe('Withdraw', async function () {
    it('Should work', async function () {
      const { bob, cToken, pool, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)


      // Overloading Ethers-v6
      expect(await pool.connect(bob)['withdraw(uint256)'](10)).to.emit(pool, 'Withdraw')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(990)
      expect(await token.balanceOf(bob.address)).to.be.equal(10)

      expect(await pool.connect(bob).withdrawAll()).to.emit(pool, 'Withdraw')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(bob.address)).to.be.equal(1000)
    })
  })
})
