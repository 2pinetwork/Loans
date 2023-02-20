require('./setup')

const { expect } = require('chai')
global.expect = expect

const constants = require('./constants')

const toHex = function (n) {
  return ethers.utils.hexlify(n).replace(/^0x0+/, '0x')
}

const mine = async function (n, time) {
  const args = [toHex(n)]

  if (time) args.push(toHex(time))

  await hre.network.provider.send("hardhat_mine", args);
}

const mineUntil = async function (n) {
  const block = (await hre.ethers.provider.getBlock()).number

  await mine(n - block)
}

const deploy = async function (name, ...args) {
  const contract = await (await ethers.getContractFactory(name)).deploy(...args)

  await contract.deployTransaction.wait()

  return contract
}

const waitFor = async function (tx) { return await (await tx).wait() }

const impersonateContract = async function (addr) {
  // Fill with gas 10k eth
  const balance = ethers.BigNumber.from('1' + '0'.repeat(23))._hex

  await hre.network.provider.send('hardhat_setBalance', [addr, balance])

  // Tell hardhat what address enables to impersonate
  await hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [addr],
  })
  // return the impersonated signer
  return await ethers.getSigner(addr)
}

const deployOracle = async function () {
  const PiGlobal = await ethers.getContractFactory('PiGlobal')
  const Oracle   = await ethers.getContractFactory('Oracle')
  const piGlobal = await PiGlobal.deploy()
  const oracle   = await Oracle.deploy(piGlobal.address)

  await piGlobal.setOracle(oracle.address)

  return { piGlobal, oracle }
}

const getInterest = async function (lPool, base, seconds) {
  // 1% piFee
  // 1% per year => amount * 0.02(%) * (seconds) / SECONDS_PER_YEAR
  const [rate, piFee]    = await Promise.all([lPool.interestRate(), lPool.piFee()])
  const SECONDS_PER_YEAR = ethers.utils.parseUnits('31536000', 0)
  const PRECISION        = ethers.utils.parseUnits('1', 18)
  const numerator        = base.mul(rate.add(piFee)).mul(seconds)
  const denominator      = SECONDS_PER_YEAR.mul(PRECISION)

  // Round up
  if (numerator.mod(denominator).eq(0)) {
    return numerator.div(denominator)
  } else {
    return numerator.div(denominator).add(1)
  }
}

module.exports = {
  deploy,
  deployOracle,
  getInterest,
  impersonateContract,
  mine,
  mineUntil,
  toHex,
  waitFor,
  ...constants
}
