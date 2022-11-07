const { expect } = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('PToken', async function() {
  const deploy = async function() {
    const [, bob] = await ethers.getSigners()
    const PToken  = await ethers.getContractFactory('PToken')
    const Token   = await ethers.getContractFactory('ERC20')
    const token   = await Token.deploy('t', 't')
    const pToken  = await PToken.deploy(token.address)

    return { bob, pToken, token, PToken, Token }
  }

  describe('Deployment', async function() {
    it('Should work', async function() {
      const { token, PToken } = await loadFixture(deploy)
      const pToken = await PToken.deploy(token.address)

      expect(pToken.address).to.not.be.equal(ZERO_ADDRESS)
      expect(await pToken.name()).to.be.equal("2pi Provider t")
      expect(await pToken.symbol()).to.be.equal("2pi-P-t")
      expect(await pToken.decimals()).to.be.equal(18)
    })
  })

  describe('Mint', async function() {
    it('Should work for `pool`', async function() {
      const { bob, pToken } = await loadFixture(deploy)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)

      await pToken.mint(bob.address, 13)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(13)
    })

    it('Should not work for non-pool', async function() {
      const { bob, pToken } = await loadFixture(deploy)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)

      await expect(pToken.connect(bob).mint(bob.address, 13)).to.be.revertedWith('!Pool')

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)
    })
  })

  describe('Burn', async function() {
    it('Should work for `pool`', async function() {
      const { bob, pToken } = await loadFixture(deploy)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)

      await pToken.mint(bob.address, 13)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(13)

      await pToken.burn(bob.address, 13)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should not work for non-pool', async function() {
      const { bob, pToken } = await loadFixture(deploy)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)

      await pToken.mint(bob.address, 13)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(13)

      await expect(pToken.connect(bob).burn(bob.address, 13)).to.be.revertedWith('!Pool')

      expect(await pToken.balanceOf(bob.address)).to.be.equal(13)
    })
  })
})
