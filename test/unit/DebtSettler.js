const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const {
  deployOracle,
  mine,
  waitFor,
  ZERO_ADDRESS
} = require('../helpers')

const setupCollateral = async function (fixtures, usersWithCollateral) {
  const {
    bob,
    cPool,
    piGlobal,
    oracle,
    token,
    tokenFeed
  } = fixtures

  await oracle.addPriceOracle(token.address, tokenFeed.address)
  await piGlobal.addCollateralPool(cPool.address)

  // let's use 1:1 collateral-borrow
  await expect(cPool.setCollateralRatio(1.0e18 + '')).to.emit(cPool, 'NewCollateralRatio')

  if (usersWithCollateral === undefined)
    usersWithCollateral = [[bob, ethers.utils.parseUnits('9.9', 18)]]

  let promises = []

  const deposit = async function (user, amount) {
    await token.mint(user.address, amount)
    await token.connect(user).approve(cPool.address, amount)

    expect(await token.balanceOf(user.address)).to.be.equal(amount)

    await expect(cPool.connect(user)['deposit(uint256)'](amount)).to.emit(cPool, 'Deposit')

    expect(await token.balanceOf(user.address)).to.be.equal(0)
  }

  for (let i in usersWithCollateral) {
    promises.push(deposit(...usersWithCollateral[i]))
  }

  await Promise.all(promises)
}

describe('Debt settler', async function () {
  const deploy = async function () {
    const token = (await (await ethers.getContractFactory('ERC20Mintable')).deploy('t', 't'))

    return await _deploy(token)
  }

  const deployUSDT = async function () {
    const token = await (await ethers.getContractFactory('TetherToken')).deploy(0, 'USDT', 'USDT', 6)

    return await _deploy(token)
  }

  const _deploy = async function (token) {
    const [, alice, bob, trent, treasury] = await ethers.getSigners()
    const { piGlobal, oracle }            = await deployOracle()

    const dueDate     = (await ethers.provider.getBlock()).timestamp + (365 * 24 * 60 * 60)
    const LPool       = await ethers.getContractFactory('LiquidityPool')
    const CPool       = await ethers.getContractFactory('CollateralPool')
    const DToken      = await ethers.getContractFactory('DToken')
    const DebtSettler = await ethers.getContractFactory('DebtSettler')
    const lPool       = await LPool.deploy(piGlobal.address, token.address, dueDate)
    const cPool       = await CPool.deploy(piGlobal.address, token.address)
    const dToken      = await DToken.attach(await lPool.dToken())
    const debtSettler = await DebtSettler.deploy(lPool.address)
    const TokenFeed   = await ethers.getContractFactory('PriceFeedMock')
    const tokenFeed   = await TokenFeed.deploy(13e8)
    const Controller  = await ethers.getContractFactory('Controller')
    const cToken      = await Controller.deploy(cPool.address)

    await Promise.all([
      cPool.setController(cToken.address),
      lPool.setTreasury(treasury.address),
      lPool.setDebtSettler(debtSettler.address),
      lPool.setPiFee(0.02e18 + ''),
      piGlobal.addLiquidityPool(lPool.address),
      lPool.togglePause(),
      debtSettler.grantRole(await debtSettler.HANDLER_ROLE(), treasury.address)
    ])

    return {
      alice,
      bob,
      cPool,
      dToken,
      piGlobal,
      lPool,
      oracle,
      debtSettler,
      token,
      tokenFeed,
      treasury,
      trent,
      DToken,
      CPool,
      LPool,
      DebtSettler,
      TokenFeed,
    }
  }

  describe('Deployment', async function () {
    it('Should work', async function () {
      const { lPool, DebtSettler } = await loadFixture(deploy)
      const debtSettler            = await DebtSettler.deploy(lPool.address)

      await expect(debtSettler.address).to.not.be.equal(ZERO_ADDRESS)
    })

    it('Should fail when zero address', async function () {
      const { DebtSettler } = await loadFixture(deploy)

      await expect(DebtSettler.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        DebtSettler,
        'ZeroAddress'
      )
    })

    it('Should fail when liquidity pool is expired', async function () {
      const { piGlobal, token, DebtSettler, LPool, lPool } = await loadFixture(deploy)

      const minDuration = await lPool.MIN_DURATION()
      const dueDate     = minDuration.add((await ethers.provider.getBlock()).timestamp + 10)
      const _lPool      = await LPool.deploy(piGlobal.address, token.address, dueDate)

      mine(minDuration.add(10))

      await expect(DebtSettler.deploy(_lPool.address)).to.be.revertedWithCustomError(
        DebtSettler,
        'InvalidPool'
      )
    })

    it('Should fail when address is not a liquidity pool', async function () {
      const { dToken, DebtSettler } = await loadFixture(deploy)

      await expect(DebtSettler.deploy(dToken.address)).to.be.revertedWithoutReason()
    })
  })

  describe('Validations', async function () {
    it('Should fail when not called by handler', async function () {
      const { bob, debtSettler } = await loadFixture(deploy)

      await expect(debtSettler.connect(bob).build()).to.be.revertedWithCustomError(
        debtSettler,
        'UnknownSender'
      )
    })

    it('Should fail when addBorrower is called from a non liquidity pool', async function () {
      const { alice, debtSettler } = await loadFixture(deploy)

      await expect(debtSettler.addBorrower(alice.address)).to.be.revertedWithCustomError(
        debtSettler,
        'UnknownSender'
      )
    })

    it('Should fail when removeBorrower is called from a non liquidity pool', async function () {
      const { alice, debtSettler } = await loadFixture(deploy)

      await expect(debtSettler.removeBorrower(alice.address)).to.be.revertedWithCustomError(
        debtSettler,
        'UnknownSender'
      )
    })
  })

  describe('Build and pay', async function () {
    it('Should work for debt settling when amount >= debt', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        alice,
        bob,
        dToken,
        lPool,
        debtSettler,
        token,
        treasury,
        trent,
      } = fixtures

      const depositAmount = ethers.utils.parseUnits('9.9', 18)
      const aliceAmount   = depositAmount
      const bobAmount     = depositAmount.mul(2)
      const trentAmount   = depositAmount.mul(4)
      const userDeposits = [
        [alice, aliceAmount],
        [bob,   bobAmount],
        [trent, trentAmount],
      ]

      await setupCollateral(fixtures, userDeposits)

      // Add liquidity & Repayment
      await token.mint(lPool.address, ethers.utils.parseUnits('200', 18))
      await token.mint(treasury.address, ethers.utils.parseUnits('200', 18))
      await debtSettler.grantRole(await debtSettler.HANDLER_ROLE(), treasury.address)
      await waitFor(token.connect(treasury).transfer(debtSettler.address, await token.balanceOf(treasury.address)))


      // The idea here is for each borrower to have an equal part of the debt.
      // so the distribution will be 1/3 for each one
      // alice: 400 blocks for 9.9
      // bob: 200 blocks for 19.8
      // trent: 100 blocks for 39.6
      await lPool.connect(alice).borrow(aliceAmount)
      await mine(199)
      await lPool.connect(bob).borrow(bobAmount)
      await mine(99)
      await lPool.connect(trent).borrow(trentAmount)
      await mine(99)

      expect(await lPool['debt(address)'](alice.address)).to.be.within(
        aliceAmount, aliceAmount.add(ethers.utils.parseUnits('0.0002', 18))
      )
      expect(await lPool['debt(address)'](bob.address)).to.be.within(
        bobAmount, bobAmount.add(ethers.utils.parseUnits('0.0001', 18))
      )
      expect(await lPool['debt(address)'](trent.address)).to.be.within(
        trentAmount, trentAmount.add(ethers.utils.parseUnits('0.0003', 18))
      )

      // dTokens should never change unless borrow/repay is called
      expect(await dToken.balanceOf(alice.address)).to.be.equal(aliceAmount)
      expect(await dToken.balanceOf(bob.address)).to.be.equal(bobAmount)
      expect(await dToken.balanceOf(trent.address)).to.be.equal(trentAmount)

      // here's the tricky part, the amount of repayment will be 100
      // but there's 69.6 debt. So the used amount will be 69.6
      // the build method will distribute equal parts for each borrower
      // paying 100% of alice and bob debt but not paying the 100% of the trent debt
      await waitFor(debtSettler.connect(treasury).build())
      await waitFor(debtSettler.connect(treasury).pay())

      // The distributed amount will be 69.6 / 3 = 23.2 for each one
      // so trent will only receive 23.2, having 16.4 left that can be repaid in the next iteration

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
      expect(await lPool['debt(address)'](alice.address)).to.be.equal(0)
      expect(await lPool['debt(address)'](trent.address)).to.be.within(15e18 + '', 17e18 + '')


      // Now we can recall build/pay and pay the trent remaining debt
      // in the same block to prevent new interest from being generated
      await network.provider.send('evm_setAutomine', [false])
      await debtSettler.connect(treasury).build() // without waitFor
      await debtSettler.connect(treasury).pay() // without waitFor
      await network.provider.send('evm_setAutomine', [true])
      await mine(1)

      expect(await lPool['debt(address)'](bob.address)).to.be.equal(0)
      expect(await lPool['debt(address)'](alice.address)).to.be.equal(0)
      expect(await lPool['debt(address)'](trent.address)).to.be.equal(0)

      // Now we check that clean method works
      expect(await debtSettler.usersCreditLength()).to.be.equal(3)
      await debtSettler.clean()
      expect(await debtSettler.usersCreditLength()).to.be.equal(0)
    })

    it('Should work for debt settling when amount < debt', async function () {
     const fixtures = await loadFixture(deploy)

      const {
        alice,
        bob,
        dToken,
        lPool,
        debtSettler,
        token,
        treasury,
        trent,
      } = fixtures

      const depositAmount = ethers.utils.parseUnits('9.9', 18)
      const aliceAmount   = depositAmount
      const bobAmount     = depositAmount.mul(2)
      const trentAmount   = depositAmount.mul(4)
      const userDeposits = [
        [alice, aliceAmount],
        [bob,   bobAmount],
        [trent, trentAmount],
      ]

      await setupCollateral(fixtures, userDeposits)

      // Add liquidity & Repayment
      await token.mint(lPool.address, ethers.utils.parseUnits('200', 18))
      await token.mint(treasury.address, ethers.utils.parseUnits('10', 18))
      await debtSettler.grantRole(await debtSettler.HANDLER_ROLE(), treasury.address)
      await waitFor(token.connect(treasury).transfer(debtSettler.address, await token.balanceOf(treasury.address)))

      // The idea here is for each borrower to have an equal part of the debt.
      // so the distribution will be 1/3 for each one
      // alice: 400 blocks for 9.9
      // bob: 200 blocks for 19.8
      // trent: 100 blocks for 39.6
      await lPool.connect(alice).borrow(aliceAmount)
      await mine(199)
      await lPool.connect(bob).borrow(bobAmount)
      await mine(99)
      await lPool.connect(trent).borrow(trentAmount)
      await mine(99)

      expect(await lPool['debt(address)'](alice.address)).to.be.within(
        aliceAmount, aliceAmount.add(ethers.utils.parseUnits('0.0002', 18))
      )
      expect(await lPool['debt(address)'](bob.address)).to.be.within(
        bobAmount, bobAmount.add(ethers.utils.parseUnits('0.0001', 18))
      )
      expect(await lPool['debt(address)'](trent.address)).to.be.within(
        trentAmount, trentAmount.add(ethers.utils.parseUnits('0.0003', 18))
      )

      // dTokens should never change unless borrow/repay is called
      expect(await dToken.balanceOf(alice.address)).to.be.equal(aliceAmount)
      expect(await dToken.balanceOf(bob.address)).to.be.equal(bobAmount)
      expect(await dToken.balanceOf(trent.address)).to.be.equal(trentAmount)

      // Here should distribute 3.3 for each one
      await waitFor(debtSettler.connect(treasury).build())
      await waitFor(debtSettler.connect(treasury).pay())

      const distributedAmount = ethers.utils.parseUnits('10', 18).div(3)

      expect(await lPool['debt(address)'](alice.address)).to.be.within(
        aliceAmount.sub(distributedAmount),
        aliceAmount.sub(distributedAmount).add(ethers.utils.parseUnits('0.0001', 18)),
      )
      expect(await lPool['debt(address)'](bob.address)).to.be.within(
        bobAmount.sub(distributedAmount),
        bobAmount.sub(distributedAmount).add(ethers.utils.parseUnits('0.0001', 18)),
      )
      expect(await lPool['debt(address)'](trent.address)).to.be.within(
        trentAmount.sub(distributedAmount),
        trentAmount.sub(distributedAmount).add(ethers.utils.parseUnits('0.0001', 18)),
      )
    })

    it('Should work until run out of gas', async function () {
      const fixtures = await loadFixture(deploy)

      const {
        alice,
        bob,
        dToken,
        cPool,
        lPool,
        debtSettler,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)

      // Add liquidity & Repayment
      await token.mint(lPool.address, 40e18 + '')
      await token.mint(bob.address, 10e18 + '')
      await token.mint(alice.address, 20e18 + '')

      // Alice collateral
      await token.connect(alice).approve(cPool.address, 20e18 + '')
      await expect(cPool.connect(alice)['deposit(uint256)'](20e18 + '')).to.emit(cPool, 'Deposit')

      const depositAmount = ethers.utils.parseUnits('9.9', 18)

      await lPool.connect(bob).borrow(depositAmount)
      await lPool.connect(alice).borrow(depositAmount.mul(2))

      // Since it already compute some interests
      expect(await lPool['debt(address)'](bob.address)).to.be.within(
        depositAmount, depositAmount.add(ethers.utils.parseUnits('0.00001', 18))
      )

      expect(await lPool['debt(address)'](alice.address)).to.be.equal(
        depositAmount.mul(2)
      )

      await mine(1000000) // Some huge time jump

      expect(await dToken.balanceOf(bob.address)).to.be.equal(depositAmount)
      expect(await dToken.balanceOf(alice.address)).to.be.equal(depositAmount.mul(2))

      const repayAmount = ethers.utils.parseUnits('20', 18)
      await token.mint(treasury.address, 20e18 + '')
      await token.connect(treasury).transfer(debtSettler.address, repayAmount)
      await debtSettler.grantRole(await debtSettler.HANDLER_ROLE(), treasury.address)

      const bobDebt   = await lPool['debt(address)'](bob.address)
      const aliceDebt = await lPool['debt(address)'](alice.address)

      await debtSettler.connect(treasury).build()
      await debtSettler.connect(treasury).pay({ gasLimit: 200000 })

      const bobDebtAfter   = await lPool['debt(address)'](bob.address)
      const aliceDebtAfter = await lPool['debt(address)'](alice.address)

      // Bob debt should be paid
      expect(bobDebtAfter).to.be.lessThan(bobDebt)
      // Alice debt won't be paid since we run out of gas
      expect(aliceDebtAfter).to.be.greaterThan(aliceDebt)

      // Clean should only remove bob
      expect(await debtSettler.usersCreditLength()).to.be.equal(2)
      await debtSettler.clean()
      expect(await debtSettler.usersCreditLength()).to.be.equal(1)
    })

    it('Should recover _stuck_ founds', async function () {
      const fixtures = await loadFixture(deploy)

      const { debtSettler, token, treasury } = fixtures

      await token.mint(treasury.address, 20e18 + '')
      // We send some _extra_ founds to the contract
      await token.connect(treasury).transfer(debtSettler.address, 20e18 + '')

      expect(await token.balanceOf(debtSettler.address)).to.be.equal(20e18 + '')

      await debtSettler.rescueFounds()

      expect(await token.balanceOf(debtSettler.address)).to.be.equal(0)
      expect(await token.balanceOf(treasury.address)).to.be.equal(20e18 + '')
    })

    it('Should recover no founds when none', async function () {
      const fixtures = await loadFixture(deploy)

      const { debtSettler, token, treasury } = fixtures

      expect(await token.balanceOf(debtSettler.address)).to.be.equal(0)

      await debtSettler.rescueFounds()

      expect(await token.balanceOf(treasury.address)).to.be.equal(0)
    })

    it.skip('[SLOW] increases gas spent while building when there are more borrowers WITH USDT', async function () {
      const fixtures = await loadFixture(deployUSDT)
      const {
        alice,
        cPool,
        lPool,
        debtSettler,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)
      // Add liquidity & Repayment
      await token.mint(lPool.address, 50e18 + '')

      let amountOfBorrowers = 300

      const promises = [
        token.mint(debtSettler.address, 100e18 + '')
      ]

      const borrowWithNewSigner = async () => {
        // get a signer
        let curSigner = ethers.Wallet.createRandom()
        // add it to Hardhat Network
        curSigner = curSigner.connect(ethers.provider)

        // send some gas ether
        await alice.sendTransaction({to: curSigner.address, value: ethers.utils.parseEther('0.3')})
        // generate token balance
        await token.mint(curSigner.address, 1e18 + '')
        // approve and deposit
        await token.connect(curSigner).approve(cPool.address, 100e18 + '')
        await expect(cPool.connect(curSigner)['deposit(uint256)'](1e17 + '')).to.emit(cPool, 'Deposit')
        await lPool.connect(curSigner).borrow(1)

        let signerDebt = await lPool['debt(address)'](curSigner.address)

        expect(signerDebt).to.be.within(1, 3) // async breaks the exact amount
      }

      for (let index = 0; index < amountOfBorrowers; index++) {
        promises.push(borrowWithNewSigner())
      }

      await Promise.all(promises)

      // build consume aprox 10M of gas per 50 borrowers so we have to iterate at least 4 times

      let buildTx
      let buildReceipt

      for (let index = 0; index < 5; index++) {
        buildTx      = await debtSettler.connect(treasury).build({gasLimit: 10e6 })
        buildReceipt = await buildTx.wait()

        expect(buildReceipt.gasUsed).to.be.greaterThan(9e6)
      }

      buildTx      = await debtSettler.connect(treasury).build({gasLimit: 10e6 })
      buildReceipt = await buildTx.wait()

      expect(buildReceipt.gasUsed).to.be.within(3e6, 10e6) // last only process 50 borrowers so should be left a few

      // build has to wait for pay to finish
      await expect(debtSettler.connect(treasury).build()).to.be.revertedWithCustomError(debtSettler, 'StillPaying')

      let payReceipt = await (await debtSettler.pay({gasLimit: 10e6})).wait()
      expect(payReceipt.gasUsed).to.be.greaterThan(4e6)

      payReceipt = await (await debtSettler.pay({gasLimit: 10e6})).wait()
      expect(payReceipt.gasUsed).to.be.greaterThan(4e6)

      // this one will run without paying
      payReceipt = await (await debtSettler.pay({gasLimit: 10e6})).wait()
      expect(payReceipt.gasUsed).to.be.lessThan(2e6)
    })

    it.skip('[SLOW] REPAYMENT - debt building process DoS WITH USDT', async function () {
      const fixtures = await loadFixture(deployUSDT)
      const {
        alice,
        bob,
        cPool,
        lPool,
        debtSettler,
        token,
        treasury,
      } = fixtures

      await setupCollateral(fixtures)
      // Add liquidity & Repayment
      await token.mint(lPool.address, 50e18 + '')
      // await lPool.togglePause();
      // Bob incurs in a big debt before the build call
      // generate token balance
      await token.mint(bob.address, ethers.utils.parseEther("1000"))
      // approve and deposit
      await token.connect(bob).approve(cPool.address, ethers.utils.parseEther("100"))
      await expect(cPool.connect(bob)['deposit(uint256)'](ethers.utils.parseEther("100"))).to.emit(cPool, 'Deposit')
      await lPool.connect(bob).borrow(ethers.utils.parseEther("10"))
      let bobsDebt = await lPool['debt(address)'](bob.address)
      expect(bobsDebt).to.be.eq(ethers.utils.parseEther("10"))
      console.log(`0) Total Debt: ${(await lPool.totalDebt()).toString()}`);
      // Rest of borrowers
      let amountOfBorrowers = 300
      let borrowers = [];
      for (let index = 0; index < amountOfBorrowers; index++) {
        // get a signer
        let curSigner = ethers.Wallet.createRandom()
        // add it to Hardhat Network
        curSigner = curSigner.connect(ethers.provider)
        borrowers.push(curSigner);
        // send some gas ether
        await alice.sendTransaction({to: curSigner.address, value: ethers.utils.parseEther('0.3')})
        // generate token balance
        await token.mint(curSigner.address, 1e18 + '')
        // approve and deposit
        await token.connect(curSigner).approve(cPool.address, 100e18 + '')
        await expect(cPool.connect(curSigner)['deposit(uint256)'](1e17 + '')).to.emit(cPool, 'Deposit')
        await lPool.connect(curSigner).borrow(1e15 + '')
        let signerDebt = await lPool['debt(address)'](curSigner.address)

        expect(signerDebt).to.be.eq(1e15)
      }
      // Since bob is the first in the enumerable mapping, his debt position is built in the first call
      await token.mint(treasury.address, 100e18 + '')
      await token.connect(treasury).transfer(debtSettler.address, ethers.utils.parseEther('10')) // Amt less than total debt
      console.log(`1) Total Debt: ${(await lPool.totalDebt()).toString()}`);
      bobsDebt =  await lPool['debt(address)'](bob.address)
      console.log(`Bobs debt: ${bobsDebt.toString()}`)
      let buildTx = await debtSettler.connect(treasury).build({gasLimit: 10e6 })
      let buildReceipt = await buildTx.wait()
      expect(buildReceipt.gasUsed).to.be.greaterThan(9e6)
      console.log(`2) Total Debt: ${(await lPool.totalDebt()).toString()}`);
      // Bob now decides to repay his debt
      await token.connect(bob).approve(lPool.address, ethers.utils.parseEther("100"))
      await lPool.connect(bob).repay(ethers.utils.parseEther("0.01")) // Repays a part of his debt
      bobsDebt = await lPool['debt(address)'](bob.address)
      console.log(`Bobs debt: ${bobsDebt.toString()}`)
      buildTx = await debtSettler.connect(treasury).build({gasLimit: 10e6 })
      buildReceipt = await buildTx.wait()
      // expect(buildReceipt.gasUsed).to.be.greaterThan(7e6)
      console.log(`3) Total Debt: ${(await lPool.totalDebt()).toString()}`);
      buildTx = await debtSettler.connect(treasury).build()
      buildReceipt = await buildTx.wait()
      // expect(buildReceipt.gasUsed).to.be.lessThan(5e6) // last only process 50 borrowers so should be left a few
      console.log(`Balance of Settler: ${(await token.balanceOf(debtSettler.address)).toString()}`);
      let buildReceipt2 = await (await debtSettler.pay({gasLimit: 10e6})).wait()
      // expect(buildReceipt2.gasUsed).to.be.greaterThan(8e6)
      console.log(`Balance of Settler: ${(await token.balanceOf(debtSettler.address)).toString()}`);
      buildReceipt2 = await (await debtSettler.pay({gasLimit: 10e6})).wait()
      // expect(buildReceipt2.gasUsed).to.be.lessThan(2e6)
      // this one will run without paying
      console.log(`Balance of Settler: ${(await token.balanceOf(debtSettler.address)).toString()}`);
      await (await debtSettler.pay()).wait()
      await (await debtSettler.pay()).wait()
      await (await debtSettler.pay()).wait()
      // expect(buildReceipt2.gasUsed).to.be.lessThan(6e6)
      // Check if the other users had their debt repaid
      for (let index = 0; index < amountOfBorrowers; index++) {
        // get a signer
        let curSigner = borrowers[index];
        // add it to Hardhat Network
        curSigner = curSigner.connect(ethers.provider)
        let signerDebt = await lPool['debt(address)'](curSigner.address)
        if (signerDebt.toString() != '0') {
          console.log(`Signer with ${signerDebt.toString()} debt`)
}
        // expect(signerDebt).to.be.gt(0)
      }
      bobsDebt = await lPool['debt(address)'](bob.address)
      console.log(`Bobs debt: ${bobsDebt.toString()}`)
    })

    it.skip('[SLOW] increases gas spent while building when there are more borrowers', async function () {
      const fixtures = await loadFixture(deploy)
      const {
        alice,
        cPool,
        lPool,
        debtSettler,
        token,
        treasury,
      } = fixtures
      await setupCollateral(fixtures)
      // Add liquidity & Repayment
      await token.mint(lPool.address, 50e18 + '')

      let amountOfBorrowers = 300

      const promises = [
        token.mint(debtSettler.address, 100e18 + '')
      ]

      const borrowWithNewSigner = async () => {
        // get a signer
        let curSigner = ethers.Wallet.createRandom()
        // add it to Hardhat Network
        curSigner = curSigner.connect(ethers.provider)

        // send some gas ether
        await alice.sendTransaction({to: curSigner.address, value: ethers.utils.parseEther('0.3')})
        // generate token balance
        await token.mint(curSigner.address, 1e18 + '')
        // approve and deposit
        await token.connect(curSigner).approve(cPool.address, 100e18 + '')
        await expect(cPool.connect(curSigner)['deposit(uint256)'](1e17 + '')).to.emit(cPool, 'Deposit')
        await lPool.connect(curSigner).borrow(1)

        let signerDebt = await lPool['debt(address)'](curSigner.address)

        expect(signerDebt).to.be.within(1, 3) // async breaks the exact amount
      }

      for (let index = 0; index < amountOfBorrowers; index++) {
        promises.push(borrowWithNewSigner())
      }

      await Promise.all(promises)

      // build consume aprox 10M of gas per 50 borrowers so we have to iterate at least 4 times

      let buildTx
      let buildReceipt

      for (let index = 0; index < 5; index++) {
        buildTx      = await debtSettler.connect(treasury).build({gasLimit: 10e6 })
        buildReceipt = await buildTx.wait()

        expect(buildReceipt.gasUsed).to.be.greaterThan(9e6)
      }

      buildTx      = await debtSettler.connect(treasury).build({gasLimit: 10e6 })
      buildReceipt = await buildTx.wait()

      expect(buildReceipt.gasUsed).to.be.within(3e6, 10e6) // last only process 50 borrowers so should be left a few

      // build has to wait for pay to finish
      await expect(debtSettler.connect(treasury).build()).to.be.revertedWithCustomError(debtSettler, 'StillPaying')

      let payReceipt = await (await debtSettler.pay({gasLimit: 10e6})).wait()
      expect(payReceipt.gasUsed).to.be.greaterThan(4e6)

      payReceipt = await (await debtSettler.pay({gasLimit: 10e6})).wait()
      expect(payReceipt.gasUsed).to.be.greaterThan(4e6)

      // this one will run without paying
      payReceipt = await (await debtSettler.pay({gasLimit: 10e6})).wait()
      expect(payReceipt.gasUsed).to.be.lessThan(2e6)
    })

    it.skip('[SLOW] REPAYMENT - debt building process DoS', async function () {
      const fixtures = await loadFixture(deploy)
      const {
        alice,
        bob,
        cPool,
        lPool,
        debtSettler,
        token,
        treasury,
      } = fixtures
      await setupCollateral(fixtures)
      // Add liquidity & Repayment
      await token.mint(lPool.address, 50e18 + '')
      // await lPool.togglePause();
      // Bob incurs in a big debt before the build call
      // generate token balance
      await token.mint(bob.address, ethers.utils.parseEther("1000"))
      // approve and deposit
      await token.connect(bob).approve(cPool.address, ethers.utils.parseEther("100"))
      await expect(cPool.connect(bob)['deposit(uint256)'](ethers.utils.parseEther("100"))).to.emit(cPool, 'Deposit')
      await lPool.connect(bob).borrow(ethers.utils.parseEther("10"))
      let bobsDebt = await lPool['debt(address)'](bob.address)
      expect(bobsDebt).to.be.eq(ethers.utils.parseEther("10"))
      console.log(`0) Total Debt: ${(await lPool.totalDebt()).toString()}`);
      // Rest of borrowers
      let amountOfBorrowers = 300
      let borrowers = [];
      for (let index = 0; index < amountOfBorrowers; index++) {
        // get a signer
        let curSigner = ethers.Wallet.createRandom()
        // add it to Hardhat Network
        curSigner = curSigner.connect(ethers.provider)
        borrowers.push(curSigner);
        // send some gas ether
        await alice.sendTransaction({to: curSigner.address, value: ethers.utils.parseEther('0.3')})
        // generate token balance
        await token.mint(curSigner.address, 1e18 + '')
        // approve and deposit
        await token.connect(curSigner).approve(cPool.address, 100e18 + '')
        await expect(cPool.connect(curSigner)['deposit(uint256)'](1e17 + '')).to.emit(cPool, 'Deposit')
        await lPool.connect(curSigner).borrow(1e15 + '')
        let signerDebt = await lPool['debt(address)'](curSigner.address)

        expect(signerDebt).to.be.eq(1e15)
      }
      // Since bob is the first in the enumerable mapping, his debt position is built in the first call
      await token.mint(treasury.address, 100e18 + '')
      await token.connect(treasury).transfer(debtSettler.address, ethers.utils.parseEther('10')) // Amt less than total debt
      console.log(`1) Total Debt: ${(await lPool.totalDebt()).toString()}`);
      bobsDebt =  await lPool['debt(address)'](bob.address)
      console.log(`Bobs debt: ${bobsDebt.toString()}`)
      let buildTx = await debtSettler.connect(treasury).build({gasLimit: 10e6 })
      let buildReceipt = await buildTx.wait()
      expect(buildReceipt.gasUsed).to.be.greaterThan(9e6)
      console.log(`2) Total Debt: ${(await lPool.totalDebt()).toString()}`);
      // Bob now decides to repay his debt
      await token.connect(bob).approve(lPool.address, ethers.utils.parseEther("100"))
      await lPool.connect(bob).repay(ethers.utils.parseEther("0.01")) // Repays a part of his debt
      bobsDebt = await lPool['debt(address)'](bob.address)
      console.log(`Bobs debt: ${bobsDebt.toString()}`)
      buildTx = await debtSettler.connect(treasury).build({gasLimit: 10e6 })
      buildReceipt = await buildTx.wait()
      // expect(buildReceipt.gasUsed).to.be.greaterThan(7e6)
      console.log(`3) Total Debt: ${(await lPool.totalDebt()).toString()}`);
      buildTx = await debtSettler.connect(treasury).build()
      buildReceipt = await buildTx.wait()
      // expect(buildReceipt.gasUsed).to.be.lessThan(5e6) // last only process 50 borrowers so should be left a few
      console.log(`Balance of Settler: ${(await token.balanceOf(debtSettler.address)).toString()}`);
      let buildReceipt2 = await (await debtSettler.pay({gasLimit: 12e6})).wait()
      // expect(buildReceipt2.gasUsed).to.be.greaterThan(8e6)
      console.log(`Balance of Settler: ${(await token.balanceOf(debtSettler.address)).toString()}`);
      buildReceipt2 = await (await debtSettler.pay({gasLimit: 10e6})).wait()
      // expect(buildReceipt2.gasUsed).to.be.lessThan(2e6)
      // this one will run without paying
      console.log(`Balance of Settler: ${(await token.balanceOf(debtSettler.address)).toString()}`);
      await (await debtSettler.pay()).wait()
      await (await debtSettler.pay()).wait()
      await (await debtSettler.pay()).wait()
      // expect(buildReceipt2.gasUsed).to.be.lessThan(6e6)
      // Check if the other users had their debt repaid
      for (let index = 0; index < amountOfBorrowers; index++) {
        // get a signer
        let curSigner = borrowers[index];
        // add it to Hardhat Network
        curSigner = curSigner.connect(ethers.provider)
        let signerDebt = await lPool['debt(address)'](curSigner.address)
        if (signerDebt.toString() != '0') {
          console.log(`Signer with ${signerDebt.toString()} debt`)
}
        // expect(signerDebt).to.be.gt(0)
      }
      bobsDebt = await lPool['debt(address)'](bob.address)
      console.log(`Bobs debt: ${bobsDebt.toString()}`)
    })

    it('Should not reset indexes', async function () {
      const { bob, debtSettler } = await loadFixture(deploy)

      await expect(debtSettler.connect(bob).changeIndexes(1,2, 0)).to.be.revertedWithCustomError(debtSettler, 'NotAdmin')
    })

    it('Should reset indexes', async function () {
      const { debtSettler } = await loadFixture(deploy)

      // deployer is the admin
      await expect(debtSettler.changeIndexes(0, 0, 0)).to.not.be.reverted
    })
  })
})
