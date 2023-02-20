const fetchNeededTokens = async function (extras) {
  const IWNativeAbi = require('../abi/iwnative.json')
  const uniswapFactoryAbi = require('../abi/uniswap-factory.json')

  let promises = []

  const ERC20_TOKENS = {
    WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    BTC:  '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    CRV:  '0x172370d5Cd63279eFa6d502DAB29171933a610AF',
    USDC: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    DAI:  '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
    MUSD: '0xe840b73e5287865eec17d250bfb1536704b43b21',
  }

  for (let symbol in ERC20_TOKENS) {
    promises.push(
      ethers.getContractAt('IERC20Metadata', ERC20_TOKENS[symbol]).then(c => (global[symbol] = c))
    )
  }

  const CHAINLINK_ORACLES = {
    daiFeed:    '0x4746DeC9e833A82EC7C2C1356372CcF2cfcD2F3D',
    usdcFeed:   '0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7',
    usdtFeed:   '0x0A6513e40db6EB1b165753AD52E80663aeA50545',
    wmaticFeed: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
  }

  for (let key in CHAINLINK_ORACLES) {
    promises.push(
      ethers.getContractAt('IChainLink', CHAINLINK_ORACLES[key]).then(c => {
        global[key] = c
        promises.push(extras.setChainlinkRoundForNow(c))
      })
    )
  }

  promises.push(
    ethers.getContractAt(IWNativeAbi, '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270').then(c => (global.WMATIC = c))
  )
  promises.push(
    ethers.getContractAt('IUniswapRouter', '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506').then(c => (global.exchange = c))
  )
  promises.push(
    ethers.getContractAt('ICurvePool', '0xC2d95EEF97Ec6C17551d45e77B590dc1F9117C67').then(c => (global.CurvePool = c))
  )
  // Gauge is not created at some reset blocks
  promises.push(
    ethers.getContractAt('ICurveGauge', '0x8D9649e50A0d1da8E939f800fB926cdE8f18B47D').then(c => (global.CurveRewardsGauge = c)).catch(e => e)
  )
  promises.push(
    ethers.getContractAt(uniswapFactoryAbi, '0xc35DADB65012eC5796536bD9864eD8773aBc74C4').then(c => (global.EXCHANGE_FACTORY = c))
  )

  await Promise.all(promises)
}

module.exports = { fetchNeededTokens }
