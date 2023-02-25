const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { impersonateContract, ZERO_ADDRESS } = require('../helpers')

describe('Collateral Pool', async function () {
  const deploy = async function () {
    const [, alice, bob] = await ethers.getSigners()
    const PiGlobal       = await ethers.getContractFactory('PiGlobal')
    const Oracle         = await ethers.getContractFactory('Oracle')
    const piGlobal       = await PiGlobal.deploy()
    const oracle         = await Oracle.deploy(piGlobal.address)

    await piGlobal.setOracle(oracle.address)

    const token      = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const Pool       = await ethers.getContractFactory('CollateralPool')
    const Controller = await ethers.getContractFactory('Controller')
    const pool       = await Pool.deploy(piGlobal.address, token.address)
    const cToken     = await Controller.deploy(pool.address)

    await pool.setController(cToken.address)

    return { alice, bob, cToken, piGlobal, oracle, pool, token, Controller, Pool }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { pool, cToken } = await loadFixture(deploy)

      expect(pool.address).to.not.be.equal(ZERO_ADDRESS)
      expect(cToken.address).to.not.be.equal(ZERO_ADDRESS)

      expect(await cToken.name()).to.be.equal('2pi Collateral t')
      expect(await cToken.symbol()).to.be.equal('2pi-C-t')
      expect(await cToken.decimals()).to.be.equal(18)
    })

    it('Should not allow to deploy with zero address as piGlobal', async function () {
      const Pool   = await ethers.getContractFactory('CollateralPool')
      const token  = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')

      await expect(Pool.deploy(ZERO_ADDRESS, token.address)).to.be.revertedWithCustomError(
        Pool, 'ZeroAddress'
      )
    })
  })

  describe('Validations', async function () {
    it('Should toggle pause', async function () {
      const { pool } = await loadFixture(deploy)

      expect(await pool.paused()).to.be.equal(false)

      await pool.togglePause()

      expect(await pool.paused()).to.be.equal(true)

      await pool.togglePause()

      expect(await pool.paused()).to.be.equal(false)
    })

    it('Should not allow to pause by non pauser', async function () {
      const { pool, alice } = await loadFixture(deploy)

      await expect(pool.connect(alice).togglePause()).to.be.revertedWithCustomError(
        pool, 'NotPauser'
      )
    })

    it('Should toggle only EOA', async function () {
      const { pool } = await loadFixture(deploy)

      expect(await pool.onlyEOA()).to.be.equal(false)

      await pool.toggleOnlyEOA()

      expect(await pool.onlyEOA()).to.be.equal(true)

      await pool.toggleOnlyEOA()

      expect(await pool.onlyEOA()).to.be.equal(false)
    })

    it('Should not allow to toggle only EOA by non admin', async function () {
      const { pool, alice } = await loadFixture(deploy)

      await expect(pool.connect(alice).toggleOnlyEOA()).to.be.revertedWithCustomError(
        pool, 'NotAdmin'
      )
    })
  })

  describe('Controller', async function () {
    it('setController should not work with non-admin', async function () {
      const { bob, pool } = await loadFixture(deploy)

      await expect(pool.connect(bob).setController(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        pool, 'NotAdmin'
      )
    })

    it('setController with ZeroAddress', async function () {
      const { piGlobal, token, Pool, Controller } = await loadFixture(deploy)

      const pool       = await Pool.deploy(piGlobal.address, token.address)
      const controller = await Controller.deploy(pool.address)

      await expect(pool.setController(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        pool, 'ZeroAddress'
      )

      const otherPool       = await Pool.deploy(piGlobal.address, token.address)
      const otherController = await Controller.deploy(otherPool.address)

      await expect(pool.setController(otherController.address)).to.be.revertedWithCustomError(
        pool, 'InvalidController'
      )

      await expect(pool.setController(controller.address)).to.emit(pool, 'ControllerSet').withArgs(controller.address)

      // setController only works once
      await expect(pool.setController(otherController.address)).to.be.revertedWithCustomError(
        pool, 'AlreadyInitialized'
      )

      await expect(pool.setController(controller.address)).to.be.revertedWithCustomError(
        pool, 'AlreadyInitialized'
      )
    })
  })

  describe('CollectedRatio', async function () {
    it('Should not work for non-admin', async function () {
      const { bob, pool } = await loadFixture(deploy)

      await expect(
        pool.connect(bob).setCollateralRatio((await pool.MAX_COLLATERAL_RATIO()).add(1))
      ).to.be.revertedWithCustomError(
        pool, 'NotAdmin'
      )
    })

    it('Should not work for more than max', async function () {
      const { pool } = await loadFixture(deploy)

      await expect(
        pool.setCollateralRatio((await pool.MAX_COLLATERAL_RATIO()).add(1))
      ).to.be.revertedWithCustomError(
        pool, 'GreaterThan', 'MAX_COLLATERAL_RATIO'
      )
    })

    it('Should not work for same ratio', async function () {
      const { pool } = await loadFixture(deploy)

      await expect(
        pool.setCollateralRatio(await pool.collateralRatio())
      ).to.be.revertedWithCustomError(
        pool, 'SameValue'
      )
    })
  })

  describe('Deposit', async function () {
    it('Should work', async function () {
      const { alice, bob, cToken, pool, token } = await loadFixture(deploy)

      await token.mint(alice.address, 1000)
      await token.mint(bob.address, 1000)
      await token.connect(alice).approve(pool.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Check "expected shares" calculation before deposit
      expect(await pool.convertToShares(1000)).to.be.equal(1000)
      // Check "expected amount" calculation before deposit
      expect(await pool.convertToAssets(1000)).to.be.equal(1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)

      // Check "expected shares" calculation after deposit
      expect(await pool.convertToShares(1000)).to.be.equal(1000)
      // Check "expected amount" calculation after deposit
      expect(await pool.convertToAssets(1000)).to.be.equal(1000)

      await token.mint(cToken.address, 8) // just to change the shares proportion

      // Check "expected shares" calculation after share proportion change
      expect(await pool.convertToShares(1000)).to.be.equal(992)

      expect(await pool.connect(alice)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await cToken.balanceOf(alice.address)).to.be.equal(992)
      expect(await pool.balance()).to.be.equal(2008)
    })

    it('Should not work for 0 amount', async function () {
      const { bob, cToken, pool } = await loadFixture(deploy)

      // Overloading Ethers-v6
      await expect(pool.connect(bob)['deposit(uint256)'](0)).to.be.revertedWithCustomError(pool, 'ZeroAmount')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should work on behalf of other', async function () {
      const { alice, bob, cToken, pool, token } = await loadFixture(deploy)

      await token.mint(alice.address, 1000)
      await token.mint(bob.address, 1000)
      await token.connect(alice).approve(pool.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await cToken.balanceOf(alice.address)).to.be.equal(0)

      await token.mint(cToken.address, 8) // just to change the shares proportion

      expect(await pool.connect(alice)['deposit(uint256,address)'](1000, bob.address)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1992)
      expect(await cToken.balanceOf(alice.address)).to.be.equal(0)
      expect(await pool.balance()).to.be.equal(2008)
    })
  })

  describe('Withdraw', async function () {
    it('Should work', async function () {
      const { bob, cToken, pool, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)


      // Overloading Ethers-v6
      expect(await pool.connect(bob)['withdraw(uint256)'](10)).to.emit(pool, 'Withdraw')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(990)
      expect(await token.balanceOf(bob.address)).to.be.equal(10)

      expect(await pool.connect(bob).withdrawAll()).to.emit(pool, 'Withdraw')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(bob.address)).to.be.equal(1000)
    })

    it('Should work to withdraw to other address', async function () {
      const { alice, bob, cToken, pool, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(alice.address)).to.be.equal(0)


      // Overloading Ethers-v6
      expect(await pool.connect(bob)['withdraw(uint256,address)'](10, alice.address)).to.emit(pool, 'Withdraw')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(990)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(alice.address)).to.be.equal(10)

      expect(await pool.connect(bob).withdrawAll()).to.emit(pool, 'Withdraw')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(bob.address)).to.be.equal(990)
      expect(await token.balanceOf(alice.address)).to.be.equal(10)
    })

    it('Should not work for 0 shares', async function () {
      const { bob, cToken, pool, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)


      // Overloading Ethers-v6
      await expect(pool.connect(bob)['withdraw(uint256)'](0)).to.be.revertedWithCustomError(pool, 'ZeroShares')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should not work if controller can\'t return any tokens', async function () {
      const { alice, bob, cToken, pool, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      const impersonatedCtroller = await impersonateContract(cToken.address)

      // Withdraw half tokens to get 0 tokens withdraw
      await token.connect(impersonatedCtroller).transfer(alice.address, 500)

      // Overloading Ethers-v6
      // 500 balance * 1 share / 1000 total Supply => 0
      await expect(pool.connect(bob)['withdraw(uint256)'](1)).to.be.revertedWithCustomError(pool, 'ZeroAmount')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)
    })

    it('Should not work when paused', async function () {
      const { bob, cToken, pool, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await pool.togglePause()

      // Overloading Ethers-v6
      await expect(pool.connect(bob)['withdraw(uint256)'](10)).to.be.revertedWith('Pausable: paused')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(pool.connect(bob)['withdraw(uint256)'](10)).to.be.revertedWith('Pausable: paused')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(pool.connect(bob)['withdraw(uint256,address)'](10, bob.address)).to.be.revertedWith('Pausable: paused')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(pool.connect(bob).withdrawAll()).to.be.revertedWith('Pausable: paused')
      expect(await cToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)
    })
  })

  describe('Rescue founds', async function () {
    it('Should work', async function () {
      const { bob, piGlobal, pool, token } = await loadFixture(deploy)
      const treasury                       = await piGlobal.treasury()

      await token.mint(bob.address, 1000)
      await token.connect(bob).transfer(pool.address, 1000)

      expect(await token.balanceOf(pool.address)).to.be.equal(1000)
      expect(await token.balanceOf(treasury)).to.be.equal(0)
      expect(await pool.balanceOf(bob.address)).to.be.equal(0)

      await pool.rescueFounds(token.address)

      expect(await token.balanceOf(pool.address)).to.be.equal(0)
      expect(await token.balanceOf(treasury)).to.be.equal(1000)
    })

    it('Should not work if not admin', async function () {
      const { bob, pool, token } = await loadFixture(deploy)

      await expect(
        pool.connect(bob).rescueFounds(token.address)
      ).to.be.revertedWithCustomError(pool, 'NotAdmin')
    })

    it('Should work for all erc20 tokens', async function () {
      const { bob, piGlobal, pool } = await loadFixture(deploy)
      const treasury                = await piGlobal.treasury()
      const token                   = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')

      await token.mint(bob.address, 1000)
      await token.connect(bob).transfer(pool.address, 1000)

      expect(await pool.asset()).not.to.be.equal(token.address)
      expect(await token.balanceOf(pool.address)).to.be.equal(1000)
      expect(await token.balanceOf(treasury)).to.be.equal(0)
      expect(await pool.balanceOf(bob.address)).to.be.equal(0)

      await pool.rescueFounds(token.address)

      expect(await token.balanceOf(pool.address)).to.be.equal(0)
      expect(await token.balanceOf(treasury)).to.be.equal(1000)
    })
  })

  describe('Check EOA only interactions', async function () {
    it('Should restrict to only EOA interactions', async function () {
      const { bob, pool, token } = await loadFixture(deploy)

      await pool.toggleOnlyEOA()

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(pool.address, 1000)

      // Overloading Ethers-v6
      expect(await pool.connect(bob)['deposit(uint256)'](1000)).to.emit(pool, 'Deposit')

      const ContractInteractionMock = await ethers.getContractFactory('ContractInteractionMock')
      const contractInteractionMock = await ContractInteractionMock.deploy(pool.address)

      await expect(
        contractInteractionMock.deposit()
      ).to.be.revertedWithCustomError(pool, 'OnlyEOA')

      await expect(
        contractInteractionMock.deposit2()
      ).to.be.revertedWithCustomError(pool, 'OnlyEOA')

      await expect(
        contractInteractionMock.withdrawAll()
      ).to.be.revertedWithCustomError(pool, 'OnlyEOA')

      await expect(
        contractInteractionMock.withdraw()
      ).to.be.revertedWithCustomError(pool, 'OnlyEOA')

      await expect(
        contractInteractionMock.withdraw2()
      ).to.be.revertedWithCustomError(pool, 'OnlyEOA')

      await pool.toggleOnlyEOA()

      await token.mint(contractInteractionMock.address, 1000)

      await expect(
        contractInteractionMock.deposit()
      ).to.be.not.reverted
    })
  })
})
