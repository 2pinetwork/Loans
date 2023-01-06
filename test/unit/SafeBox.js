const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

describe('SafeBox', async function () {
  const deploy = async function () {
    const [, bob] = await ethers.getSigners()

    const token  = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const SafeBox = await ethers.getContractFactory('SafeBox')
    const safeBox = await SafeBox.deploy(token.address)

    return {
      bob,
      token,
      safeBox
    }
  }

  describe('Validations', async function () {
    it('Should revert when transfer is called as non owner', async function () {
      const { bob, safeBox } = await loadFixture(deploy)

      await expect(
        safeBox.connect(bob).transfer(1)
      ).to.be.revertedWithCustomError(safeBox, 'NotOwner')
    })
  })
})
