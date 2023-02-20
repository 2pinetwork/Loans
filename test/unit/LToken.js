const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('../helpers')

describe('LToken', async function () {
  const deploy = async function () {
    const [, bob] = await ethers.getSigners()
    const LToken  = await ethers.getContractFactory('LToken')
    const Token   = await ethers.getContractFactory('ERC20')
    const token   = await Token.deploy('t', 't')
    const lToken  = await LToken.deploy(token.address, 0)

    return { bob, lToken, token, LToken, Token }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { token, LToken } = await loadFixture(deploy)
      const lToken            = await LToken.deploy(token.address, 0)

      expect(lToken.address).to.not.be.equal(ZERO_ADDRESS)
      expect(await lToken.name()).to.be.equal('2pi Liquidity t - 0')
      expect(await lToken.symbol()).to.be.equal('2pi-L-t-0')
      expect(await lToken.decimals()).to.be.equal(18)
    })
  })

  describe('Mint', async function () {
    it('Should work for `pool`', async function () {
      const { bob, lToken } = await loadFixture(deploy)

      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)

      await lToken.mint(bob.address, 13)

      expect(await lToken.balanceOf(bob.address)).to.be.equal(13)
    })

    it('Should not work for non-pool', async function () {
      const { bob, lToken } = await loadFixture(deploy)

      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)

      await expect(lToken.connect(bob).mint(bob.address, 13)).to.be.revertedWithCustomError(lToken, 'NotPool')

      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)
    })
  })

  describe('Burn', async function () {
    it('Should work for `pool`', async function () {
      const { bob, lToken } = await loadFixture(deploy)

      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)

      await lToken.mint(bob.address, 13)

      expect(await lToken.balanceOf(bob.address)).to.be.equal(13)

      await lToken.burn(bob.address, 13)

      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should not work for non-pool', async function () {
      const { bob, lToken } = await loadFixture(deploy)

      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)

      await lToken.mint(bob.address, 13)

      expect(await lToken.balanceOf(bob.address)).to.be.equal(13)

      await expect(lToken.connect(bob).burn(bob.address, 13)).to.be.revertedWithCustomError(lToken, 'NotPool')

      expect(await lToken.balanceOf(bob.address)).to.be.equal(13)
    })
  })
})
