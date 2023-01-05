require('./setup')

const constants = require('./constants')

const toHex = function (n) {
  return ethers.utils.hexlify(n).replace(/^0x0+/, '0x')
}

const mine = async function (n, time) {
  const args = [toHex(n)]

  if (time) args.push(toHex(time))

  await hre.network.provider.send("hardhat_mine", args);
}

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

module.exports = { deployOracle, toHex, mine, impersonateContract, ...constants }
