const { expect }      = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { ZERO_ADDRESS } = require('./helpers').constants

const toHex = (n) => {
  return ethers.utils.hexlify(n).replace(/^0x0/, '0x')
}

const mine = async function (n, time) {
  const args = [toHex(n)]

  if (time) args.push(toHex(time))

  await hre.network.provider.send("hardhat_mine", args);
}

const getInterest = function (base, seconds) {
  // 1% per year => amount * 0.01(%) * (seconds) / SECONDS_PER_YEAR
  const rate = ethers.utils.parseUnits('0.01', 18)
  const SECONDS_PER_YEAR = ethers.utils.parseUnits('31536000', 0)
  const PRECISION = ethers.utils.parseUnits('1', 18)

  return base.mul(
    rate.mul(seconds).div(SECONDS_PER_YEAR)
  ).div(PRECISION)
}

const deployOracle = async function () {
  const GlobalC = await ethers.getContractFactory('Global')
  const Oracle  = await ethers.getContractFactory('Oracle')
  const globalC = await GlobalC.deploy()
  const oracle  = await Oracle.deploy(globalC.address)

  return { globalC, oracle }
}

const setupCollateral = async function (fixtures) {
  const {
    bob,
    cPool,
    globalC,
    oracle,
    token,
    tokenFeed
  } = fixtures

  await oracle.addPriceOracle(token.address, tokenFeed.address)
  await globalC.addCollateralPool(cPool.address)

  const depositAmount = ethers.utils.parseUnits('9.9', 18)

  await token.mint(bob.address, depositAmount)
  await token.connect(bob).approve(cPool.address, 10e18 + '')

  expect(await token.balanceOf(bob.address)).to.be.equal(depositAmount)

  await expect(cPool.connect(bob)['deposit(uint256)'](depositAmount)).to.emit(cPool, 'Deposit')

  expect(await token.balanceOf(bob.address)).to.be.equal(0)
}

describe('Liquidity Pool', async function () {
  const deploy = async function () {
    const [, alice, bob] = await ethers.getSigners()
    const token          = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const LPool          = await ethers.getContractFactory('LiquidityPool')
    const CPool          = await ethers.getContractFactory('CollateralPool')
    const LToken         = await ethers.getContractFactory('LToken')
    const DToken         = await ethers.getContractFactory('DToken')
    const lPool          = await LPool.deploy(token.address)
    const cPool          = await CPool.deploy(token.address)
    const lToken         = await LToken.attach(await lPool.lToken())
    const dToken         = await DToken.attach(await lPool.dToken())
    const TokenFeed      = await ethers.getContractFactory('PriceFeedMock')
    const tokenFeed      = await TokenFeed.deploy(13e8)

    const { globalC, oracle } = await deployOracle()

    await lPool.setOracle(oracle.address)

    return {
      alice,
      bob,
      cPool,
      dToken,
      globalC,
      lPool,
      lToken,
      oracle,
      token,
      tokenFeed,
      DToken,
      LToken,
      LPool,
    }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { token, LPool, LToken } = await loadFixture(deploy)
      const lPool                    = await LPool.deploy(token.address)
      const lToken                   = await LToken.attach(await lPool.lToken())

      expect(lPool.address).to.not.be.equal(ZERO_ADDRESS)
      expect(lToken.address).to.not.be.equal(ZERO_ADDRESS)

      expect(await lToken.name()).to.be.equal('2pi Liquidity t')
      expect(await lToken.symbol()).to.be.equal('2pi-L-t')
      expect(await lToken.decimals()).to.be.equal(18)
    })
  })

  describe('Deposit', async function () {
    it('Should work', async function () {
      const { alice, bob, lPool, lToken, token } = await loadFixture(deploy)

      await token.mint(alice.address, 1000)
      await token.mint(bob.address, 1000)
      await token.connect(alice).approve(lPool.address, 1000)
      await token.connect(bob).approve(lPool.address, 1000)

      // Overloading Ethers-v6
      expect(await lPool.connect(bob)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)

      await token.mint(lPool.address, 8) // just to change the shares proportion

      expect(await lPool.connect(alice)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await lToken.balanceOf(alice.address)).to.be.within(990, 1000)
      expect(await lPool.balance()).to.be.equal(2008)
    })
  })

  describe('Withdraw', async function () {
    it('Should work', async function () {
      const { bob, lPool, lToken, token } = await loadFixture(deploy)

      await token.mint(bob.address, 1000)
      await token.connect(bob).approve(lPool.address, 1000)

      // Overloading Ethers-v6
      expect(await lPool.connect(bob)['deposit(uint256)'](1000)).to.emit(lPool, 'Deposit')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(1000)
      expect(await token.balanceOf(bob.address)).to.be.equal(0)


      // Overloading Ethers-v6
      expect(await lPool.connect(bob)['withdraw(uint256)'](10)).to.emit(lPool, 'Withdraw')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(990)
      expect(await token.balanceOf(bob.address)).to.be.equal(10)

      expect(await lPool.connect(bob).withdrawAll()).to.emit(lPool, 'Withdraw')
      expect(await lToken.balanceOf(bob.address)).to.be.equal(0)
      expect(await token.balanceOf(bob.address)).to.be.equal(1000)
    })
  })

  describe('Borrow', async function () {
    it('Should not work for zero amount', async function () {
      const { bob, lPool } = await loadFixture(deploy)

      await expect(lPool.connect(bob).borrow(0)).to.be.revertedWithCustomError(
        lPool, 'ZeroAmount'
      )
    })

    it('Should not work without liquidity', async function () {
      const { bob, lPool, token } = await loadFixture(deploy)

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(lPool.connect(bob).borrow(1)).to.be.revertedWithCustomError(
        lPool, 'InsufficientLiquidity'
      )

      await token.mint(lPool.address, 100)

      await expect(lPool.connect(bob).borrow(101)).to.be.revertedWithCustomError(
        lPool, 'InsufficientLiquidity'
      )
    })

    it('Should be reverted without collateral', async function () {
      const {
        bob,
        cPool,
        globalC,
        lPool,
        oracle,
        token,
        tokenFeed
      } = await loadFixture(deploy)

      await oracle.addPriceOracle(token.address, tokenFeed.address)
      await globalC.addCollateralPool(cPool.address)

      const amount = ethers.utils.parseUnits('9.9', 18)

      await token.mint(lPool.address, amount)
      await token.mint(bob.address, amount)

      expect(await token.balanceOf(bob.address)).to.be.equal(amount)

      // Just to check the case
      await expect(lPool.connect(bob).borrow(amount)).to.be.revertedWithCustomError(lPool, 'InsufficientFunds')
    })

    it('Should work', async function () {
      const fixtures              = await loadFixture(deploy)
      const { bob, lPool, token } = fixtures
      const depositAmount         = ethers.utils.parseUnits('9.9', 18)

      await token.mint(lPool.address, 10e18 + '')

      await setupCollateral(fixtures)

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(lPool.connect(bob).borrow(depositAmount)).to.emit(lPool, 'Borrow').withArgs(bob.address, depositAmount)

      expect(await token.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount)
      expect(await token.balanceOf(lPool.address)).to.be.equal(0.1e18 + '')

      // 100 blocks per 1 second => 100 seconds of interest
      // 1% per year => amount * 0.01(%) * 100(seconds) / SECONDS_PER_YEAR
      await mine(100, 1)
      const expectedDebt = depositAmount.add(
        getInterest(depositAmount, 100)
      )

      // Token amount doesn't change, just the debt until the user
      // interacts again with the protocol
      expect(await token.balanceOf(bob.address)).to.be.equal(depositAmount)

      // JS calcs are not the same than solidity
      expect(await lPool['debt(address)'](bob.address)).to.be.within(
        expectedDebt.mul(999).div(1000),
        expectedDebt.mul(1001).div(1000)
      )
    })
  })

  describe('Repay', async function () {
    it('Should not work for zero amount', async function () {
      const fixtures              = await loadFixture(deploy)
      const { bob, lPool, token } = fixtures

      await setupCollateral(fixtures)

      await token.mint(lPool.address, 100)

      await lPool.connect(bob).borrow(100)

      await expect(lPool.connect(bob).repay(0)).to.be.revertedWithCustomError(lPool, 'ZeroAmount')
    })

    it('Should work for total amount', async function () {
      const fixtures              = await loadFixture(deploy)
      const { bob, lPool, token } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp
      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      await token.connect(bob).approve(lPool.address, 100e18 +'')

      const seconds = (await hre.ethers.provider.getBlock()).timestamp - ts
      const repayAmount = depositAmount.add(getInterest(depositAmount, seconds))

      await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
        lPool, 'Repay'
      ).withArgs(bob.address, repayAmount)


      expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
    })

    it('Should work for partial interest amount (+mint debt tokens)', async function () {
      const fixtures                      = await loadFixture(deploy)
      const { bob, dToken, lPool, token } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.connect(bob).approve(lPool.address, 100e18 +'')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp

      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      await mine(100, 1)

      const seconds  = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interest = getInterest(depositAmount, seconds)

      expect(interest).to.not.be.equal(depositAmount)

      // Interest are calculated and minted/burned with each interaction
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)

      const repayment = interest.div(2)

      // Check repay event + mint "half of interest"
      await expect(lPool.connect(bob).repay(repayment)).to.emit(
        lPool, 'Repay'
      ).withArgs(bob.address, repayment).to.emit(
        dToken, 'Transfer' // TMP: will change for Mint
      ).withArgs(ZERO_ADDRESS, bob.address, interest.sub(repayment))

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount.add(interest.sub(repayment))
      )
    })

    it('Should work for partial interest amount (+burn debt tokens)', async function () {
      const fixtures                      = await loadFixture(deploy)
      const { bob, dToken, lPool, token } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.connect(bob).approve(lPool.address, 100e18 +'')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp

      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      await mine(100, 1)

      const seconds  = (await hre.ethers.provider.getBlock()).timestamp - ts
      const interest = getInterest(depositAmount, seconds)

      expect(interest).to.not.be.equal(depositAmount)

      // Interest are calculated and minted/burned with each interaction
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)

      // Should only burn 2 tokens
      const repayment = interest.add(2)

      // Check repay event + mint "half of interest"
      await expect(lPool.connect(bob).repay(repayment)).to.emit(
        lPool, 'Repay'
      ).withArgs(bob.address, repayment).to.emit(
        dToken, 'Transfer' // TMP: will change for Burn
      ).withArgs(bob.address, ZERO_ADDRESS, 2)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(
        depositAmount.sub(2)
      )
    })
  })
})
