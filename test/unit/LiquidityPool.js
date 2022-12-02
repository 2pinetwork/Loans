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

  // let's use 1:1 collateral-borrow
  await expect(cPool.setCollateralRatio(1.0e18 + '')).to.emit(cPool, 'NewCollateralRatio')

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
    const iToken         = await DToken.attach(await lPool.iToken())
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
      iToken,
      lPool,
      lToken,
      oracle,
      token,
      tokenFeed,
      DToken,
      LToken,
      CPool,
      LPool,
      TokenFeed,
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
      const fixtures      = await loadFixture(deploy)
      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const { bob, lPool, token } = fixtures

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

    it('Should work for multiple collaterals with different prices', async function () {
      // This test should test the entire flow from collateral with different tokens and
      // different prices, and then borrow with different token and different price
      const fixtures      = await loadFixture(deploy)
      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      const {
        bob,
        cPool,
        globalC,
        lPool,
        oracle,
        token,
        tokenFeed,
        CPool,
        TokenFeed
      } = fixtures

      // deploy 2 different tokens with Token factory
      const token2     = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t2', 't2')
      const token3     = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t3', 't3')
      const cPool2     = await CPool.deploy(token2.address)
      const cPool3     = await CPool.deploy(token3.address)
      const tokenFeed2 = await TokenFeed.deploy(0.2e8)
      const tokenFeed3 = await TokenFeed.deploy(1.0e8)

      await Promise.all([
        cPool2.setCollateralRatio(ethers.utils.parseUnits('0.5', 18)),
        cPool3.setCollateralRatio(ethers.utils.parseUnits('0.3', 18)),
        globalC.addCollateralPool(cPool.address),
        globalC.addCollateralPool(cPool2.address),
        globalC.addCollateralPool(cPool3.address),
        oracle.addPriceOracle(token.address, tokenFeed.address),
        oracle.addPriceOracle(token2.address, tokenFeed2.address),
        oracle.addPriceOracle(token3.address, tokenFeed3.address),
        token.mint(lPool.address, depositAmount),
        token2.mint(bob.address, depositAmount),
        token3.mint(bob.address, depositAmount),
        token2.connect(bob).approve(cPool2.address, depositAmount),
        token3.connect(bob).approve(cPool3.address, depositAmount),
      ])

      await Promise.all([
        cPool2.connect(bob)['deposit(uint256)'](depositAmount),
        cPool3.connect(bob)['deposit(uint256)'](depositAmount),
      ])

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      // Should have 0.61e18 of collateral in token1
      // Div(2) == 0.5 collateralRatio // div(5) == 0.2 tokenFeed
      // mul(3).div(10) == 0.3 collateralRatio // 1.0 tokenFeed
      const expectedAvailable = (depositAmount.div(2).div(5).div(13)).add(
        depositAmount.mul(3e18 + '').div(10e18 + '').div(13)
      )

      expect(await oracle.availableCollateralForAsset(bob.address, token.address)).to.be.equal(
        expectedAvailable
      )

      await expect(lPool.connect(bob).borrow(expectedAvailable.add(1))).to.be.revertedWithCustomError(
        lPool, 'InsufficientFunds'
      )

      await expect(lPool.connect(bob).borrow(expectedAvailable)).to.emit(lPool, 'Borrow').withArgs(bob.address, expectedAvailable)
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

    describe('Repay >= debt', async function () {
      it('Should work for repay == debt', async function () {
        const fixtures = await loadFixture(deploy)

        const {
          bob,
          iToken,
          dToken,
          lPool,
          token
        } = fixtures

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

        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

        await token.connect(bob).approve(lPool.address, 100e18 + '')

        const seconds     = (await hre.ethers.provider.getBlock()).timestamp - ts
        const repayAmount = depositAmount.add(getInterest(depositAmount, seconds))

        // Full repay without iTokens minted or burned
        await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
          lPool, 'Repay'
        ).withArgs(
          bob.address, repayAmount
        ).to.emit(
          dToken, 'Transfer' // TMP: Will change for Burn event
        ).withArgs(
          bob.address, ZERO_ADDRESS, depositAmount
        ).to.not.emit(iToken, 'Transfer') // TMP: Will change for Burn event

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
      })

      it('Should work for repay > debt', async function () {
        const fixtures = await loadFixture(deploy)

        const {
          bob,
          iToken,
          dToken,
          lPool,
          token
        } = fixtures

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

        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

        await token.connect(bob).approve(lPool.address, 100e18 + '')

        const seconds     = (await hre.ethers.provider.getBlock()).timestamp - ts
        const repayAmount = depositAmount.add(getInterest(depositAmount, seconds))

        // Extra repay without iTokens minted or burned
        await expect(lPool.connect(bob).repay(repayAmount.add(100))).to.emit(
          lPool, 'Repay'
        ).withArgs(
          bob.address, repayAmount
        ).to.emit(
          dToken, 'Transfer' // TMP: Will change for Burn event
        ).withArgs(
          bob.address, ZERO_ADDRESS, depositAmount
        ).to.not.emit(iToken, 'Transfer') // TMP: Will change for Burn event

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
      })
    })

    describe('Repay < Debt', async function () {
      it('Should work repay == not-minted-interest', async function () {
        const fixtures = await loadFixture(deploy)

        const {
          bob,
          dToken,
          iToken,
          lPool,
          token
        } = fixtures

        await setupCollateral(fixtures)

        // Add liquidity & Repayment
        await token.mint(lPool.address, 10e18 + '')
        await token.mint(bob.address, 10e18 + '')
        await token.connect(bob).approve(lPool.address, 100e18 + '')

        const depositAmount = ethers.utils.parseUnits('9.9', 18)

        const ts = (await hre.ethers.provider.getBlock()).timestamp

        await lPool.connect(bob).borrow(depositAmount)

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount
        )

        await mine(100, 1)

        const seconds  = (await hre.ethers.provider.getBlock()).timestamp - ts
        const interest = getInterest(depositAmount, seconds)

        expect(interest).to.be.below(depositAmount)

        // Interest are calculated and minted/burned with each interaction
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

        // Check repay event and "drop" the acumulated interest with no-mint tokens
        await expect(lPool.connect(bob).repay(interest)).to.emit(
          lPool, 'Repay'
        ).withArgs(bob.address, interest).to.not.emit(
          iToken, 'Transfer'// TMP: will change for Mint
        ).to.not.emit(
          dToken, 'Transfer' // TMP: will change for Mint
        )

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount
        )
      })

      it('Should work repay != not-minted-interest', async function () {
        const fixtures = await loadFixture(deploy)
        const {
          bob,
          dToken,
          iToken,
          lPool,
          token
        } = fixtures

        await setupCollateral(fixtures)

        // Add liquidity & Repayment
        await token.mint(lPool.address, 10e18 + '')
        await token.mint(bob.address, 10e18 + '')
        await token.connect(bob).approve(lPool.address, 100e18 + '')

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
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

        let   repayment    = interest.div(2)
        const interestRest = interest.sub(repayment)

        // Repay < _diff
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer'// TMP: will change for Mint
        ).withArgs(
          ZERO_ADDRESS, bob.address, interestRest
        ).to.not.emit(
          dToken, 'Transfer' // TMP: will change for Mint
        )

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount.add(interestRest)
        )

        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(interestRest)

        // 1 block for diff
        repayment = interestRest.div(2).add(getInterest(depositAmount, 1))

        // Repay > _diff
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer'// TMP: will change for Burn
        ).withArgs(
          bob.address, ZERO_ADDRESS, interestRest.div(2)
        ).to.not.emit(
          dToken, 'Transfer' // TMP: will change for Mint
        )
      })

      it('Should work repay == not-minted-interest + iTokens (iToken.burn)', async function () {
        const fixtures = await loadFixture(deploy)
        const {
          bob,
          dToken,
          iToken,
          lPool,
          token
        } = fixtures

        await setupCollateral(fixtures)

        // Add liquidity & Repayment
        await token.mint(lPool.address, 10e18 + '')
        await token.mint(bob.address, 10e18 + '')
        await token.connect(bob).approve(lPool.address, 100e18 + '')

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
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

        let   repayment    = interest.div(2)
        const interestRest = interest.sub(repayment)

        // Repay < _diff
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer'// TMP: will change for Mint
        ).withArgs(
          ZERO_ADDRESS, bob.address, interestRest
        ).to.not.emit(
          dToken, 'Transfer' // TMP: will change for Mint
        )

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount.add(interest.sub(repayment))
        )
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(interestRest)

        repayment = interestRest.add(getInterest(depositAmount, 1))

        // Repay == _diff + iTokens
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay', 'RepayEvent'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer', 'iToken.MintEvent' // TMP: will change for Mint
        ).withArgs(
          bob.address, ZERO_ADDRESS, interestRest
        ).to.not.emit(
          dToken, 'Transfer', 'dToken.BurnEvent' // TMP: will change for Mint
        )

        // All iTokens burned
        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount
        )
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)
      })

      it('Should work repay > not-minted-interest + iTokens (dToken.burn)', async function () {
        const fixtures = await loadFixture(deploy)
        const {
          bob,
          dToken,
          iToken,
          lPool,
          token
        } = fixtures

        await setupCollateral(fixtures)

        // Add liquidity & Repayment
        await token.mint(lPool.address, 10e18 + '')
        await token.mint(bob.address, 10e18 + '')
        await token.connect(bob).approve(lPool.address, 100e18 + '')

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
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

        let repayment    = interest.div(2)
        let interestRest = interest.sub(repayment)

        // Repay < _diff
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer'// TMP: will change for Mint
        ).withArgs(
          ZERO_ADDRESS, bob.address, interestRest
        ).to.not.emit(
          dToken, 'Transfer' // TMP: will change for Mint
        )

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount.add(interest.sub(repayment))
        )
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(interestRest)

        // Pay 5 more than all interests
        repayment = interestRest.add(getInterest(depositAmount, 1)).add(5)

        // Repay == _diff + iTokens
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer'// TMP: will change for Mint
        ).withArgs(
          bob.address, ZERO_ADDRESS, interestRest
        ).to.emit(
          dToken, 'Transfer' // TMP: will change for Mint
        ).withArgs(
          bob.address, ZERO_ADDRESS, 5
        )

        // All iTokens burned
        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount.sub(5)
        )
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount.sub(5))
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)
      })
    })
  })
})
