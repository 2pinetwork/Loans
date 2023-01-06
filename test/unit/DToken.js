const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

describe('DToken', async function () {
  const deploy = async function () {
    const [, bob] = await ethers.getSigners()

    const token  = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const DToken = await ethers.getContractFactory('DToken')
    const dToken = await DToken.deploy(token.address)

    return {
      bob,
      dToken,
      token,
      DToken,
    }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { dToken, token } = await loadFixture(deploy)

      await expect(await dToken.name()).to.equal(`2pi Debt ${await token.symbol()}`)
      await expect(await dToken.decimals()).to.equal(await token.decimals())
    })
  })

  describe('Validations', async function () {
    it('Should allow mint to owner', async function () {
      const { dToken, bob } = await loadFixture(deploy)

      await dToken.mint(bob.address, 1)
      await expect(await dToken.balanceOf(bob.address)).to.be.equal(1)
    })

    it('Should not allow mint to non-owner', async function () {
      const { dToken, bob } = await loadFixture(deploy)

      await expect(
        dToken.connect(bob).mint(bob.address, 1)
      ).to.be.revertedWithCustomError(dToken, 'NotPool')
    })

    it('Should allow burn from owner', async function () {
      const { dToken, bob } = await loadFixture(deploy)

      await dToken.mint(bob.address, 1)

      await expect(await dToken.balanceOf(bob.address)).to.be.equal(1)

      await dToken.burn(bob.address, 1)

      await expect(await dToken.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should not allow burn from non-owner', async function () {
      const { dToken, bob } = await loadFixture(deploy)

      await expect(
        dToken.connect(bob).burn(bob.address, 1)
      ).to.be.revertedWithCustomError(dToken, 'NotPool')
    })

    it('Should deny transfer', async function () {
      const { dToken, bob } = await loadFixture(deploy)

      await expect(
        dToken.transfer(bob.address, 1)
      ).to.be.revertedWithCustomError(dToken, 'TransferNotSupported')
    })

    it('Should deny transferFrom', async function () {
      const { dToken, bob } = await loadFixture(deploy)

      await expect(
        dToken.transferFrom(bob.address, bob.address, 1)
      ).to.be.revertedWithCustomError(dToken, 'TransferNotSupported')
    })
  })
})
