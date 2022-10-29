// const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
// const { anyValue }    = require('@nomicfoundation/hardhat-chai-matchers/withArgs')
const { expect }      = require('chai')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('Collateral Pool', async function() {
  let alice, bob, Pool, token, CToken

  before(async function() {
    [, alice, bob] = await ethers.getSigners()
    token          = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    Pool           = await ethers.getContractFactory('CollateralPool')
    CToken         = await ethers.getContractFactory('CToken')
  })

  describe('Deployment', async function() {
    it('Should work', async function() {
      const pool   = await Pool.deploy(token.address)
      const cToken = await CToken.attach(await pool.cToken())

      expect(pool.address).to.not.be.equal(ZERO_ADDRESS)
      expect(cToken.address).to.not.be.equal(ZERO_ADDRESS)

      expect(await cToken.name()).to.be.equal("2pi Collateral t")
      expect(await cToken.symbol()).to.be.equal("2pi-C-t")
      expect(await cToken.decimals()).to.be.equal(18)
    })
  })

  describe('Deposit', async () => {
    it('Should work', async () => {
      const pool = await Pool.deploy(token.address)
      const cToken = await CToken.attach(await pool.cToken())

      await token.mint(alice.address, 1000)
      await token.mint(bob.address, 1000)
      await token.connect(alice).approve(pool.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)

      await token.mint(pool.address, 8) // just to change the shares proportion

      expect(await pool.connect(alice)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await cToken.balanceOf(alice.address)).to.be.within(990, 1000)
      expect(await pool.balance()).to.be.equal(2008)
    })
  })

  describe('Withdraw', async () => {
    it('Should work', async () => {
      const pool = await Pool.deploy(token.address)
      const cToken = await CToken.attach(await pool.cToken())

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
