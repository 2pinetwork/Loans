// const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
// const { anyValue }    = require('@nomicfoundation/hardhat-chai-matchers/withArgs')
const { expect }      = require('chai')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('CToken', async function() {
  let bob, CToken, Token

  before(async function() {
    [, bob] = await ethers.getSigners()
    CToken  = await ethers.getContractFactory('CToken')
    Token   = await ethers.getContractFactory('ERC20')
  })

  describe('Deployment', async function() {
    it('Should work', async function() {
      const token = await Token.deploy('t', 't')
      const cToken = await CToken.deploy(token.address)

      expect(cToken.address).to.not.be.equal(ZERO_ADDRESS)
      expect(await cToken.name()).to.be.equal("2pi Collateral t")
      expect(await cToken.symbol()).to.be.equal("2pi-C-t")
      expect(await cToken.decimals()).to.be.equal(18)
    })
  })

  describe('Mint', async () => {
    it('Should work for `pool`', async () => {
      const token = await Token.deploy('t', 't')
      const cToken = await CToken.deploy(token.address)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)

      await cToken.mint(bob.address, 13)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(13)
    })

    it('Should not work for non-pool', async () => {
      const token = await Token.deploy('t', 't')
      const cToken = await CToken.deploy(token.address)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)

      await expect(cToken.connect(bob).mint(bob.address, 13)).to.be.revertedWith('!Pool')

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)
    })
  })

  describe('Burn', async () => {
    it('Should work for `pool`', async () => {
      const token = await Token.deploy('t', 't')
      const cToken = await CToken.deploy(token.address)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)

      await cToken.mint(bob.address, 13)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(13)

      await cToken.burn(bob.address, 13)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should not work for non-pool', async () => {
      const token = await Token.deploy('t', 't')
      const cToken = await CToken.deploy(token.address)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)

      await cToken.mint(bob.address, 13)

      expect(await cToken.balanceOf(bob.address)).to.be.equal(13)

      await expect(cToken.connect(bob).burn(bob.address, 13)).to.be.revertedWith('!Pool')

      expect(await cToken.balanceOf(bob.address)).to.be.equal(13)
    })
  })
})
