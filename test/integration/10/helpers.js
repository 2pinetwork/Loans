const fetchNeededTokens = async function (extras) {
  const IWNativeAbi = require('../abi/iwnative.json')

  let promises = []

  const ERC20_TOKENS = {
    OP:   '0x4200000000000000000000000000000000000042',
    DAI:  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    CRV:  '0x0994206dfE8De6Ec6920FF4D779B0d950605Fb53',
    USDC: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
  }

  for (let symbol in ERC20_TOKENS) {
    promises.push(
      ethers.getContractAt('IERC20Metadata', ERC20_TOKENS[symbol]).then(c => (global[symbol] = c))
    )
  }

  const CHAINLINK_ORACLES = {
    opFeed:   '0x0d276fc14719f9292d5c1ea2198673d1f4269246',
    daiFeed:  '0x8dba75e83da73cc766a7e5a0ee71f656bab470d6',
    crvFeed:  '0xbd92c6c284271c227a1e0bf1786f468b539f51d9',
    usdcFeed: '0x16a9fa2fda030272ce99b29cf780dfa30361e0f3',
    ethFeed:  '0x13e3Ee699D1909E989722E753853AE30b17e08c5',
  }

  for (let key in CHAINLINK_ORACLES) {
    promises.push(
      ethers.getContractAt('IChainLink', CHAINLINK_ORACLES[key]).then(c => {
        (global[key] = c)
        promises.push(extras.setChainlinkRoundForNow(c))
      })
    )
  }

  promises.push(
    ethers.getContractAt(IWNativeAbi, '0x4200000000000000000000000000000000000006').then(c => (global.WETH = c))
  )
  promises.push(
    ethers.getContractAt('IUniswapRouter', '0xe592427a0aece92de3edee1f18e0157c05861564').then(c => (global.exchange = c))
  )
  promises.push(
    ethers.getContractAt('ISolidlyRouter', '0x9c12939390052919aF3155f41Bf4160Fd3666A6f').then(c => global.solidlyExchange = c)
  )

  await Promise.all(promises)
}

module.exports = { fetchNeededTokens }
