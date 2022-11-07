const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('Provider Pool', async function() {
  const deploy = async function() {
    const [, alice, bob] = await ethers.getSigners()
    const token          = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const Pool           = await ethers.getContractFactory('ProviderPool')
    const PToken         = await ethers.getContractFactory('PToken')
    const pool           = await Pool.deploy(token.address)
    const pToken         = await PToken.attach(await pool.pToken())

    return { alice, bob, pool, pToken, token, Pool, PToken }
  }

  describe('Deployment', async function() {
    it('Should work', async function() {
      const { token, Pool, PToken } = await loadFixture(deploy)
      const pool            = await Pool.deploy(token.address)
      const pToken          = await PToken.attach(await pool.pToken())

      expect(pool.address).to.not.be.equal(ZERO_ADDRESS)
      expect(pToken.address).to.not.be.equal(ZERO_ADDRESS)

      expect(await pToken.name()).to.be.equal("2pi Provider t")
      expect(await pToken.symbol()).to.be.equal("2pi-P-t")
      expect(await pToken.decimals()).to.be.equal(18)
    })
  })

  describe('Deposit', async function() {
    it('Should work', async function() {
      const { alice, bob, pool, pToken, token } = await loadFixture(deploy)

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

  describe('Withdraw', async function() {
    it('Should work', async function() {
      const { bob, pool, pToken, token } = await loadFixture(deploy)

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
