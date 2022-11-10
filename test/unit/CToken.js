const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('CToken', async function () {
  const deploy = async function () {
    const [, bob] = await ethers.getSigners()
    const CToken  = await ethers.getContractFactory('CToken')
    const Token   = await ethers.getContractFactory('ERC20')
    const token   = await Token.deploy('t', 't')
    const cToken  = await CToken.deploy(token.address)

    return { bob, cToken, token, CToken, Token }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { token, CToken } = await loadFixture(deploy)
      const cToken            = await CToken.deploy(token.address)

      expect(cToken.address).to.not.be.equal(ZERO_ADDRESS)
      expect(await cToken.name()).to.be.equal("2pi Collateral t")
      expect(await cToken.symbol()).to.be.equal("2pi-C-t")
      expect(await cToken.decimals()).to.be.equal(18)
    })
  })

  describe('Mint', async function () {
    it('Should work for `pool`', async function () {
      const { bob, cToken } = await loadFixture(deploy)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)

      await cToken.mint(bob.address, 13)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(13)
    })

    it('Should not work for non-pool', async function () {
      const { bob, cToken } = await loadFixture(deploy)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)

      await expect(cToken.connect(bob).mint(bob.address, 13)).to.be.revertedWith('!Pool')

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)
    })
  })

  describe('Burn', async function () {
    it('Should work for `pool`', async function () {
      const { bob, cToken } = await loadFixture(deploy)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)

      await cToken.mint(bob.address, 13)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(13)

      await cToken.burn(bob.address, 13)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should not work for non-pool', async function () {
      const { bob, cToken } = await loadFixture(deploy)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)

      await cToken.mint(bob.address, 13)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(13)

      await expect(cToken.connect(bob).burn(bob.address, 13)).to.be.revertedWith('!Pool')

      expect(await cToken.balanceOf(bob.address)).to.be.equal(13)
    })
  })
})
