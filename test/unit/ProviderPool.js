// const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
// const { anyValue }    = require('@nomicfoundation/hardhat-chai-matchers/withArgs')
const { expect }      = require('chai')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('Provider Pool', async function() {
  let alice, bob, Pool, token, PToken

  before(async function() {
    [, alice, bob] = await ethers.getSigners()
    token          = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    Pool           = await ethers.getContractFactory('ProviderPool')
    PToken         = await ethers.getContractFactory('PToken')
  })

  describe('Deployment', async function() {
    it('Should work', async function() {
      const pool   = await Pool.deploy(token.address)
      const pToken = await PToken.attach(await pool.pToken())

      expect(pool.address).to.not.be.equal(ZERO_ADDRESS)
      expect(pToken.address).to.not.be.equal(ZERO_ADDRESS)

      expect(await pToken.name()).to.be.equal("2pi Provider t")
      expect(await pToken.symbol()).to.be.equal("2pi-P-t")
      expect(await pToken.decimals()).to.be.equal(18)
    })
  })

  describe('Deposit', async () => {
    it('Should work', async () => {
      const pool = await Pool.deploy(token.address)
      const pToken = await PToken.attach(await pool.pToken())

      await token.mint(alice.address, 1000)
      await token.mint(bob.address, 1000)
      await token.connect(alice).approve(pool.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await pToken.balanceOf(bob.address)).to.be.equal(1000)

      await token.mint(pool.address, 8) // just to change the shares proportion

      expect(await pool.connect(alice)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await pToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await pToken.balanceOf(alice.address)).to.be.within(990, 1000)
      expect(await pool.balance()).to.be.equal(2008)
    })
  })

  describe('Withdraw', async () => {
    it('Should work', async () => {
      const pool = await Pool.deploy(token.address)
      const pToken = await PToken.attach(await pool.pToken())

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await pToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)


      // Overloading Ethers-v6
      expect(await pool.connect(bob)['withdraw(uint256)'](10)).to.emit(pool, 'Withdraw')
      expect(await pToken.balanceOf(bob.address)).to.be.equal(990)
      expect(await token.balanceOf(bob.address)).to.be.equal(10)

      expect(await pool.connect(bob).withdrawAll()).to.emit(pool, 'Withdraw')
      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(bob.address)).to.be.equal(1000)
    })
  })
})
