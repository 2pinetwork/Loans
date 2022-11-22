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

describe('Liquidity Pool', async function () {
  const deploy = async function () {
    const [, alice, bob] = await ethers.getSigners()
    const token          = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const Pool           = await ethers.getContractFactory('LiquidityPool')
    const LToken         = await ethers.getContractFactory('LToken')
    const DToken         = await ethers.getContractFactory('DToken')
    const pool           = await Pool.deploy(token.address)
    const lToken         = await LToken.attach(await pool.lToken())
    const dToken         = await DToken.attach(await pool.dToken())

    return { alice, bob, dToken, pool, lToken, token, DToken, Pool, LToken }
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

  describe('Borrow', async function () {
    it('Should not work for zero amount', async function () {
      const { bob, pool } = await loadFixture(deploy)

      await expect(pool.connect(bob).borrow(0)).to.be.revertedWithCustomError(
        pool, 'ZeroAmount'
      )
    })

    it('Should not work without liquidity', async function () {
      const { bob, pool, token } = await loadFixture(deploy)

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(pool.connect(bob).borrow(1)).to.be.revertedWithCustomError(
        pool, 'WithoutLiquidity'
      )

      await token.mint(pool.address, 100)

      await expect(pool.connect(bob).borrow(101)).to.be.revertedWithCustomError(
        pool, 'WithoutLiquidity'
      )
    })

    it('Should work', async function () {
      const { bob, pool, token } = await loadFixture(deploy)

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      await token.mint(pool.address, 10e18 + '')

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(pool.connect(bob).borrow(depositAmount)).to.emit(pool, 'Borrow').withArgs(bob.address, depositAmount)

      expect(await token.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await pool['debt(address)'](bob.address)).to.be.equal(depositAmount)
      expect(await token.balanceOf(pool.address)).to.be.equal(0.1e18 + '')

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
      expect(await pool['debt(address)'](bob.address)).to.be.within(
        expectedDebt.mul(999).div(1000),
        expectedDebt.mul(1001).div(1000)
      )
    })
  })

  describe('Repay', async function () {
    it('Should not work for zero amount', async function () {
      const { bob, pool, token } = await loadFixture(deploy)

      await token.mint(pool.address, 100)

      await pool.connect(bob).borrow(100)

      await expect(pool.connect(bob).repay(0)).to.be.revertedWithCustomError(pool, 'ZeroAmount')
    })

    it('Should work for total amount', async function () {
      const { bob, pool, token } = await loadFixture(deploy)

      // Add liquidity & Repayment
      await token.mint(pool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp
      await pool.connect(bob).borrow(depositAmount)

      expect(await pool['debt(address)'](bob.address)).to.be.equal(
        depositAmount
      )

      await token.connect(bob).approve(pool.address, 100e18 +'')

      const seconds = (await hre.ethers.provider.getBlock()).timestamp - ts
      const repayAmount = depositAmount.add(getInterest(depositAmount, seconds))

      await expect(pool.connect(bob).repay(repayAmount)).to.emit(
        pool, 'Repay'
      ).withArgs(bob.address, repayAmount)


      expect(await pool['debt(address)'](bob.address)).to.be.equal(0)
    })

    it('Should work for partial interest amount (+mint debt tokens)', async function () {
      const { bob, dToken, pool, token } = await loadFixture(deploy)

      // Add liquidity & Repayment
      await token.mint(pool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.connect(bob).approve(pool.address, 100e18 +'')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp

      await pool.connect(bob).borrow(depositAmount)

      expect(await pool['debt(address)'](bob.address)).to.be.equal(
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
      await expect(pool.connect(bob).repay(repayment)).to.emit(
        pool, 'Repay'
      ).withArgs(bob.address, repayment).to.emit(
        dToken, 'Transfer' // TMP: will change for Mint
      ).withArgs(ZERO_ADDRESS, bob.address, interest.sub(repayment))

      expect(await pool['debt(address)'](bob.address)).to.be.equal(
        depositAmount.add(interest.sub(repayment))
      )
    })

    it('Should work for partial interest amount (+burn debt tokens)', async function () {
      const { bob, dToken, pool, token } = await loadFixture(deploy)

      // Add liquidity & Repayment
      await token.mint(pool.address, 10e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.connect(bob).approve(pool.address, 100e18 +'')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const ts = (await hre.ethers.provider.getBlock()).timestamp

      await pool.connect(bob).borrow(depositAmount)

      expect(await pool['debt(address)'](bob.address)).to.be.equal(
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
      await expect(pool.connect(bob).repay(repayment)).to.emit(
        pool, 'Repay'
      ).withArgs(bob.address, repayment).to.emit(
        dToken, 'Transfer' // TMP: will change for Burn
      ).withArgs(bob.address, ZERO_ADDRESS, 2)

      expect(await pool['debt(address)'](bob.address)).to.be.equal(
        depositAmount.sub(2)
      )
    })
  })
})
