const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('Liquidity Pool', async function () {
  const deploy = async function () {
    const [, alice, bob] = await ethers.getSigners()
    const token          = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const Pool           = await ethers.getContractFactory('LiquidityPool')
    const LToken         = await ethers.getContractFactory('LToken')
    const pool           = await Pool.deploy(token.address)
    const lToken         = await LToken.attach(await pool.lToken())

    return { alice, bob, pool, lToken, token, Pool, LToken }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { token, Pool, LToken } = await loadFixture(deploy)
      const pool                    = await Pool.deploy(token.address)
      const lToken                  = await LToken.attach(await pool.lToken())

      expect(pool.address).to.not.be.equal(ZERO_ADDRESS)
      expect(lToken.address).to.not.be.equal(ZERO_ADDRESS)

      expect(await lToken.name()).to.be.equal('2pi Liquidity t')
      expect(await lToken.symbol()).to.be.equal('2pi-L-t')
      expect(await lToken.decimals()).to.be.equal(18)
    })
  })

  describe('Deposit', async function () {
    it('Should work', async function () {
      const { alice, bob, pool, lToken, token } = await loadFixture(deploy)

      await token.mint(alice.address, 1000)
      await token.mint(bob.address, 1000)
      await token.connect(alice).approve(pool.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)

      await token.mint(pool.address, 8) // just to change the shares proportion

      expect(await pool.connect(alice)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await lToken.balanceOf(alice.address)).to.be.within(990, 1000)
      expect(await pool.balance()).to.be.equal(2008)
    })
  })

  describe('Withdraw', async function () {
    it('Should work', async function () {
      const { bob, pool, lToken, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)


      // Overloading Ethers-v6
      expect(await pool.connect(bob)['withdraw(uint256)'](10)).to.emit(pool, 'Withdraw')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(990)
      expect(await token.balanceOf(bob.address)).to.be.equal(10)

      expect(await pool.connect(bob).withdrawAll()).to.emit(pool, 'Withdraw')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(bob.address)).to.be.equal(1000)
    })
  })
})
