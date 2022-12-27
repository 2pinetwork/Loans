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

module.exports = { toHex, mine, ...constants }
