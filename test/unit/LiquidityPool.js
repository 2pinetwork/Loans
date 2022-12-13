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

const getPiFeeFor = async function (lPool, amount) {
  // 1% piFee
  // 1% per year => amount * 0.02(%) * (seconds) / SECONDS_PER_YEAR
  const [rate, piFee] = await Promise.all([lPool.interestRate(), lPool.piFee()]);

  return amount.mul(piFee).div(piFee.add(rate))
}

const getInterest = async function (lPool, base, seconds) {
  // 1% piFee
  // 1% per year => amount * 0.02(%) * (seconds) / SECONDS_PER_YEAR
  const [rate, piFee] = await Promise.all([lPool.interestRate(), lPool.piFee()]);
  const SECONDS_PER_YEAR = ethers.utils.parseUnits('31536000', 0)
  const PRECISION = ethers.utils.parseUnits('1', 18)

  return base.mul(rate.add(piFee)).mul(seconds).div(SECONDS_PER_YEAR).div(PRECISION)
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
    const [, alice, bob, treasury] = await ethers.getSigners()
    const { globalC, oracle }      = await deployOracle()

    const dueDate    = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const token      = await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't')
    const LPool      = await ethers.getContractFactory('LiquidityPool')
    const CPool      = await ethers.getContractFactory('CollateralPool')
    const LToken     = await ethers.getContractFactory('LToken')
    const DToken     = await ethers.getContractFactory('DToken')
    const lPool      = await LPool.deploy(token.address, dueDate)
    const cPool      = await CPool.deploy(token.address)
    const lToken     = await LToken.attach(await lPool.lToken())
    const dToken     = await DToken.attach(await lPool.dToken())
    const iToken     = await DToken.attach(await lPool.iToken())
    const TokenFeed  = await ethers.getContractFactory('PriceFeedMock')
    const tokenFeed  = await TokenFeed.deploy(13e8)

    await Promise.all([
      lPool.setOracle(oracle.address),
      lPool.setTreasury(treasury.address),
      lPool.setPiFee(0.02e18 + ''),
      globalC.addLiquidityPool(lPool.address),
    ])

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
      treasury,
      DToken,
      LToken,
      CPool,
      LPool,
      TokenFeed,
    }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const dueDate                  = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
      const { token, LPool, LToken } = await loadFixture(deploy)
      const lPool                    = await LPool.deploy(token.address, dueDate)
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

    it('Should not work for expired pool', async function () {
      const { token, LPool } = await loadFixture(deploy)
      const dueDate          = (await ethers.provider.getBlock()).timestamp + 3
      const lPool            = await LPool.deploy(token.address, dueDate)

      await mine(2)

      await expect(lPool['deposit(uint256)'](1)).to.be.revertedWithCustomError(lPool, 'EXPIRED_POOL')
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

      const { bob, dToken, iToken, lPool, token } = fixtures

      await token.mint(lPool.address, 10e18 + '')

      await setupCollateral(fixtures)

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(lPool.connect(bob).borrow(depositAmount)).to.emit(lPool, 'Borrow').withArgs(bob.address, depositAmount)

      expect(await token.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount)
      expect(await token.balanceOf(lPool.address)).to.be.equal(0.1e18 + '')

      // 100 blocks per 1 second => 100 seconds of interest
      // 1% per year => amount * 0.01(%) * 100(seconds) / SECONDS_PER_YEAR
      await mine(100, 1)
      const expectedDebt = depositAmount.add(
        await getInterest(lPool, depositAmount, 100)
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

      // Div(2) == 0.5 collateralRatio // div(5) == 0.2 tokenFeed // 13 token price
      // mul(3).div(10) == 0.3 collateralRatio // 1.0 tokenFeed // 13 token price
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

    it('Should not work for expired pool', async function () {
      const { token, LPool } = await loadFixture(deploy)
      const dueDate          = (await ethers.provider.getBlock()).timestamp + 3
      const lPool            = await LPool.deploy(token.address, dueDate)

      await mine(2)

      await expect(lPool.borrow(1)).to.be.revertedWithCustomError(lPool, 'EXPIRED_POOL')
    })

    it('Should work with originatorFee', async function () {
      const fixtures     = await loadFixture(deploy)
      const borrowAmount = ethers.utils.parseUnits('9.9', 18)

      const { bob, lPool, dToken, iToken, token, } = fixtures

      await Promise.all([
        lPool.setOriginatorFee(0.01e18 + ''),
        token.mint(lPool.address, 10e18 + ''),
        setupCollateral({...fixtures, lPool})
      ])

      expect(await token.balanceOf(bob.address)).to.be.equal(0)

      await expect(lPool.connect(bob).borrow(borrowAmount)).to.emit(lPool, 'Borrow').withArgs(bob.address, borrowAmount)

      const originatorFee = borrowAmount.mul(0.01e18 + '').div(1e18 + '')

      // originator fee is minted as interest directly
      expect(await token.balanceOf(bob.address)).to.be.equal(borrowAmount)
      expect(await dToken.balanceOf(bob.address)).to.be.equal(borrowAmount)
      expect(await iToken.balanceOf(bob.address)).to.be.equal(originatorFee)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(borrowAmount.add(originatorFee))
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
          token,
          treasury,
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

        const seconds        = (await hre.ethers.provider.getBlock()).timestamp - ts
        const interestAmount = await getInterest(lPool, depositAmount, seconds)
        const repayAmount    = depositAmount.add(interestAmount)
        const piFee          = await getPiFeeFor(lPool, interestAmount)

        // Full repay without iTokens minted or burned
        await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
          lPool, 'Repay'
        ).withArgs(
          bob.address, repayAmount
        ).to.emit(
          dToken, 'Transfer' // TMP: Will change for Burn event
        ).withArgs(
          bob.address, ZERO_ADDRESS, depositAmount
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, piFee
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
          token,
          treasury,
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

        const seconds        = (await hre.ethers.provider.getBlock()).timestamp - ts
        const interestAmount = await getInterest(lPool, depositAmount, seconds)
        const repayAmount    = depositAmount.add(interestAmount)
        const piFee          = await getPiFeeFor(lPool, interestAmount)

        // Extra repay without iTokens minted or burned
        await expect(lPool.connect(bob).repay(repayAmount.add(100))).to.emit(
          lPool, 'Repay'
        ).withArgs(
          bob.address, repayAmount
        ).to.emit(
          dToken, 'Transfer' // TMP: Will change for Burn event
        ).withArgs(
          bob.address, ZERO_ADDRESS, depositAmount
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, piFee
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
        const interest = await getInterest(lPool, depositAmount, seconds)

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
          token,
          treasury,
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
        const interest = await getInterest(lPool, depositAmount, seconds)

        expect(interest).to.not.be.equal(depositAmount)

        // Interest are calculated and minted/burned with each interaction
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

        let   repayment    = interest.div(2)
        const interestRest = interest.sub(repayment)
        let   piFee        = await getPiFeeFor(lPool, repayment)

        // Repay < _diff
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer'// TMP: will change for Mint
        ).withArgs(
          ZERO_ADDRESS, bob.address, interestRest
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, piFee
        ).to.not.emit(
          dToken, 'Transfer' // TMP: will change for Mint
        )

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount.add(interestRest)
        )

        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(interestRest)

        // 1 block for diff
        repayment = interestRest.div(2).add(await getInterest(lPool, depositAmount, 1))
        piFee     = await getPiFeeFor(lPool, repayment)

        // Repay > _diff
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer'// TMP: will change for Burn
        ).withArgs(
          bob.address, ZERO_ADDRESS, interestRest.div(2)
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, piFee
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
          token,
          treasury,
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
        const interest = await getInterest(lPool, depositAmount, seconds)

        expect(interest).to.not.be.equal(depositAmount)

        // Interest are calculated and minted/burned with each interaction
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

        let   repayment    = interest.div(2)
        const interestRest = interest.sub(repayment)
        let   piFee        = await getPiFeeFor(lPool, repayment)

        // Repay < _diff
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer'// TMP: will change for Mint
        ).withArgs(
          ZERO_ADDRESS, bob.address, interestRest
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, piFee
        ).to.not.emit(
          dToken, 'Transfer' // TMP: will change for Mint
        )

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount.add(interest.sub(repayment))
        )
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(interestRest)

        repayment = interestRest.add(await getInterest(lPool, depositAmount, 1))
        piFee     = await getPiFeeFor(lPool, repayment)

        // Repay == _diff + iTokens
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay', 'RepayEvent'
        ).withArgs(bob.address, repayment).to.emit(
          iToken, 'Transfer', 'iToken.MintEvent' // TMP: will change for Mint
        ).withArgs(
          bob.address, ZERO_ADDRESS, interestRest
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, piFee
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
          token,
          treasury,
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
        const interest = await getInterest(lPool, depositAmount, seconds)

        expect(interest).to.not.be.equal(depositAmount)

        // Interest are calculated and minted/burned with each interaction
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)

        let repayment    = interest.div(2)
        let interestRest = interest.sub(repayment)
        let piFee        = await getPiFeeFor(lPool, repayment)

        // Repay < _diff
        await expect(lPool.connect(bob).repay(repayment)).to.emit(
          lPool, 'Repay'
        ).withArgs(
          bob.address, repayment
        ).to.emit(
          iToken, 'Transfer'// TMP: will change for Mint
        ).withArgs(
          ZERO_ADDRESS, bob.address, interestRest
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, piFee
        ).to.not.emit(
          dToken, 'Transfer' // TMP: will change for Mint
        )

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount.add(interest.sub(repayment))
        )
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(interestRest)

        // Pay 5 more than all interests
        const totalInterest = interestRest.add(await getInterest(lPool, depositAmount, 1))

        repayment = totalInterest.add(5)
        piFee     = await getPiFeeFor(lPool, totalInterest)

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
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address,  piFee
        )

        // All iTokens burned
        expect(await lPool['debt(address)'](bob.address)).to.be.equal(
          depositAmount.sub(5)
        )
        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount.sub(5))
        expect(await iToken.balanceOf(bob.address)).to.be.equal(0)
      })
    })

    describe('Repay with originator Fee', async function () {
      it('Should work for repay == debt', async function () {
        const fixtures = await loadFixture(deploy)

        const {
          bob,
          dToken,
          iToken,
          lPool,
          token,
          treasury,
        } = fixtures

        await Promise.all([
          lPool.setOriginatorFee(0.01e18 + ''),
          token.mint(lPool.address, 10e18 + ''),
          setupCollateral(fixtures),
        ])

        // Add tokens for Repayment
        await token.mint(bob.address, 10e18 + '')

        const depositAmount = ethers.utils.parseUnits('9.9', 18)

        const ts = (await hre.ethers.provider.getBlock()).timestamp
        await lPool.connect(bob).borrow(depositAmount)

        const originatorFee = depositAmount.div(100) // 1% fee

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount.add(originatorFee))

        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(originatorFee)

        await token.connect(bob).approve(lPool.address, 100e18 + '')

        const seconds        = (await hre.ethers.provider.getBlock()).timestamp - ts
        const interestAmount = await getInterest(lPool, depositAmount, seconds)
        const repayAmount    = depositAmount.add(interestAmount).add(originatorFee)
        const piFeeAmount    = (await getPiFeeFor(lPool, interestAmount)).add(originatorFee)

        // Full repay without iTokens minted or burned
        await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
          lPool, 'Repay'
        ).withArgs(
          bob.address, repayAmount
        ).to.emit(
          dToken, 'Transfer' // TMP: Will change for Burn event
        ).withArgs(
          bob.address, ZERO_ADDRESS, depositAmount
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, piFeeAmount
        ).to.emit(
          iToken, 'Transfer' // TMP: Will change for Burn event
        ).withArgs(
          bob.address, ZERO_ADDRESS, originatorFee
        ).to.emit(
          lPool, 'CollectedFee'
        ).withArgs(piFeeAmount).to.emit(
          lPool, 'CollectedOriginatorFee' // PiFee
        ).withArgs(originatorFee)

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
      })

     it('Should work for repay (paying originator fee and keep debt token)', async function () {
        const fixtures = await loadFixture(deploy)

        const {
          bob,
          dToken,
          iToken,
          lPool,
          token,
          treasury,
        } = fixtures

        await Promise.all([
          lPool.setOriginatorFee(0.01e18 + ''),
          token.mint(lPool.address, 10e18 + ''),
          setupCollateral({...fixtures, lPool}),
        ])

        // Add tokens for Repayment
        await token.mint(bob.address, 10e18 + '')


        const depositAmount = ethers.utils.parseUnits('9.9', 18)

        const ts = (await hre.ethers.provider.getBlock()).timestamp
        await lPool.connect(bob).borrow(depositAmount)

        const originatorFee = depositAmount.div(100) // 1% fee

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount.add(originatorFee))

        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(originatorFee)

        await token.connect(bob).approve(lPool.address, 100e18 + '')

        const seconds        = (await hre.ethers.provider.getBlock()).timestamp - ts
        const interestAmount = await getInterest(lPool, depositAmount, seconds)
        const repayAmount    = depositAmount.add(interestAmount).add(originatorFee.div(2))
        const piFeeAmount    = (await getPiFeeFor(lPool, interestAmount)).add(originatorFee)

        await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
          lPool, 'Repay'
        ).withArgs(
          bob.address, repayAmount
        ).to.emit(
          dToken, 'Transfer' // TMP: Will change for Burn event
        ).withArgs(
          bob.address, ZERO_ADDRESS, depositAmount.sub(originatorFee.div(2))
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, piFeeAmount
        ).to.emit(
          iToken, 'Transfer' // TMP: Will change for Burn event
        ).withArgs(
          bob.address, ZERO_ADDRESS, originatorFee
        ).to.emit(
          lPool, 'CollectedFee'
        ).withArgs(piFeeAmount).to.emit(
          lPool, 'CollectedOriginatorFee' // PiFee
        ).withArgs(originatorFee)

        expect(await lPool.remainingOriginatorFee(bob.address)).to.be.equal(0)
        expect(await lPool['debt(address)'](bob.address)).to.be.equal(originatorFee.div(2))
      })

     it('Should work for repay < originatorFee', async function () {
        const fixtures = await loadFixture(deploy)

        const {
          bob,
          dToken,
          iToken,
          lPool,
          token,
          treasury,
        } = fixtures

        await Promise.all([
          lPool.setOriginatorFee(0.01e18 + ''),
          token.mint(lPool.address, 10e18 + ''),
          setupCollateral({...fixtures, lPool}),
        ])

        // Add tokens for Repayment
        await token.mint(bob.address, 10e18 + '')

        const depositAmount = ethers.utils.parseUnits('9.9', 18)

        await lPool.connect(bob).borrow(depositAmount)

        const originatorFee = depositAmount.div(100) // 1% fee

        expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount.add(originatorFee))

        expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
        expect(await iToken.balanceOf(bob.address)).to.be.equal(originatorFee)

        await token.connect(bob).approve(lPool.address, 100e18 + '')

        const repayAmount = originatorFee.div(2)

       // Should send the entire payment to treasury
        await expect(lPool.connect(bob).repay(repayAmount)).to.emit(
          lPool, 'Repay'
        ).withArgs(
          bob.address, repayAmount
        ).to.emit(
          token, 'Transfer' // PiFee
        ).withArgs(
          lPool.address, treasury.address, repayAmount
        ).to.emit(
          lPool, 'CollectedFee'
        ).withArgs(repayAmount).to.emit(
          lPool, 'CollectedOriginatorFee' // PiFee
        ).withArgs(repayAmount)

        expect(await lPool.remainingOriginatorFee(bob.address)).to.be.equal(repayAmount)
      })
    })

    it('Should not work for expired pool', async function () {
      const { token, LPool } = await loadFixture(deploy)
      const dueDate          = (await ethers.provider.getBlock()).timestamp + 3
      const lPool            = await LPool.deploy(token.address, dueDate)

      await mine(2)

      // doesn't matter if it has debt or not
      await expect(lPool.repay(1)).to.be.revertedWithCustomError(lPool, 'EXPIRED_POOL')
    })
  })

  describe('Oracle.HealthFactor', async function () {
    it('Should return valid ratio', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        bob,
        cPool,
        oracle,
        lPool,
        token,
      } = fixtures

      await Promise.all([
        token.mint(lPool.address, 10e18 + ''),
        setupCollateral({...fixtures, lPool}),
      ])

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      await lPool.connect(bob).borrow(depositAmount)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(depositAmount)

      let [hf, lt] = await oracle.healthFactor(bob.address);

      expect(hf).to.be.within(0.99e18 + '', 1.01e18 + '')
      expect(lt).to.be.within(0.49e18 + '', 0.5e18 + '');

      await cPool.setCollateralRatio(0.5e18 + '');

      [hf, lt] = await oracle.healthFactor(bob.address);

      expect(hf).to.be.within(0.49e18 + '', 0.5e18 + '')
      expect(lt).to.be.within(0.49e18 + '', 0.5e18 + '')

      await cPool.setCollateralRatio(0.3e18 + '');

      [hf, lt] = await oracle.healthFactor(bob.address);

      expect(hf).to.be.within(0.29e18 + '', 0.3e18 + '')
      expect(lt).to.be.within(0.49e18 + '', 0.5e18 + '')
    })
  })
})
