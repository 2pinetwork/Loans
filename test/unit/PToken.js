// const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
// const { anyValue }    = require('@nomicfoundation/hardhat-chai-matchers/withArgs')

const { ZERO_ADDRESS } = require('./helpers').constants

describe('PToken', async function() {
  let bob, PToken, Token

  before(async function() {
    [, bob] = await ethers.getSigners()
    PToken  = await ethers.getContractFactory('PToken')
    Token   = await ethers.getContractFactory('ERC20')
  })

  describe('Deployment', async function() {
    it('Should work', async function() {
      const token = await Token.deploy('t', 't')
      const pToken = await PToken.deploy(token.address)

      expect(pToken.address).to.not.be.equal(ZERO_ADDRESS)
      expect(await pToken.name()).to.be.equal("2pi Provider t")
      expect(await pToken.symbol()).to.be.equal("2pi-P-t")
      expect(await pToken.decimals()).to.be.equal(18)
    })
  })

  describe('Mint', async () => {
    it('Should work for `pool`', async () => {
      const token = await Token.deploy('t', 't')
      const pToken = await PToken.deploy(token.address)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)

      await pToken.mint(bob.address, 13)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(13)
    })

    it('Should not work for non-pool', async () => {
      const token = await Token.deploy('t', 't')
      const pToken = await PToken.deploy(token.address)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)

      await expect(pToken.connect(bob).mint(bob.address, 13)).to.be.revertedWith('!Pool')

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)
    })
  })

  describe('Burn', async () => {
    it('Should work for `pool`', async () => {
      const token = await Token.deploy('t', 't')
      const pToken = await PToken.deploy(token.address)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)

      await pToken.mint(bob.address, 13)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(13)

      await pToken.burn(bob.address, 13)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should not work for non-pool', async () => {
      const token = await Token.deploy('t', 't')
      const pToken = await PToken.deploy(token.address)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(0)

      await pToken.mint(bob.address, 13)

      expect(await pToken.balanceOf(bob.address)).to.be.equal(13)

      await expect(pToken.connect(bob).burn(bob.address, 13)).to.be.revertedWith('!Pool')

      expect(await pToken.balanceOf(bob.address)).to.be.equal(13)
    })
  })
})
