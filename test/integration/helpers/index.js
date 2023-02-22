const chainId = +process.env.HARDHAT_INTEGRATION_CHAIN
const { fetchNeededTokens } = require(`../${chainId}/helpers`)
const helpers = require(`../../helpers`)
const { deploy, waitFor } = helpers

const setCustomBalanceFor = async function (token, address, rawAmount, slot) {
  slot = slot || {
    '0x4200000000000000000000000000000000000006': 3,  // OP-WETH
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 3,  // Polygon-WMatic
  }[token.toLowerCase()] || 0

  const weiAmount = typeof rawAmount === 'string' ? ethers.utils.parseUnits(rawAmount, 18) : rawAmount
  const index      = ethers.utils.solidityKeccak256(['uint256', 'uint256'], [address, slot])
  const balance32  = ethers.utils.hexlify(ethers.utils.zeroPad(weiAmount.toHexString(), 32))

  await ethers.provider.send('hardhat_setStorageAt', [token, index.toString(), balance32])
}

const setChainlinkRound = async function (address, roundId, timestamp, price) {
  const slot = [
    '0x89C991cbC41Af1a0294f79947aD71A028bf164b7', // CRV-agg
    '0x336584C8E6Dc19637A5b36206B1c79923111b405', // CRV
    '0x310990E8091b5cF083fA55F500F140CFBb959016', // EUR
    '0xbce7579e241e5d676c2371dc21891489dacda250', // DAI (OPTIMISM)
    '0x16a9fa2fda030272ce99b29cf780dfa30361e0f3', // USDC (OPTIMISM)
  ].includes(address) ? 44 : 43  // most of pricess are 43 slot

  const timestampL = 16
  const priceL     = 48
  const timestampHex = timestamp.toString(16)
  const priceHex   = parseInt(price * 1e8, 10).toString(16)
  const newValue   = [
    '0x',
    '0'.repeat(timestampL - timestampHex.length),
    timestampHex,
    '0'.repeat(priceL - priceHex.length),
    priceHex
  ].join('')
  let index = ethers.utils.solidityKeccak256(['uint256', 'uint256'], [roundId, slot])

  await ethers.provider.send('hardhat_setStorageAt', [address, index.toString(), newValue])
}

const setChainlinkRoundForNow = async function (feed) {
   const data = await feed.latestRoundData()
   const agg = await feed.aggregator()

  let roundId = data.roundId._hex
  // ETH feed
  if (feed.address != '0xF9680D99D6C9589e2a93a78A04A279e509205945') {
    roundId = `0x0000${roundId.substr(-8)}` // only 8 hex are used in some round
  }

  await setChainlinkRound(
    agg,
    roundId,
    (await hre.ethers.provider.getBlock()).timestamp,
    (data.answer / 1e8)
  )
}

const createUsdcPairWithPrice = async function (token, price, exchangeData = {}) {
  const factoryAddr  = exchangeData.factoryAddr || '0xc35DADB65012eC5796536bD9864eD8773aBc74C4'
  const exchange     = exchangeData.exchange || global.exchange
  const currentBlock = await hre.ethers.provider.getBlock()
  const factoryAbi   = require('../abi/uniswap-factory.json')
  const factory      = await ethers.getContractAt(factoryAbi, factoryAddr)
  const allowance    = '1' + '0'.repeat(59)

  const wantedTokens = ethers.utils.parseUnits('10000', await token.decimals())
  const usdcTokens   = ethers.utils.parseUnits((10000 * price).toFixed(6), 6) // USDC 6 decimals

  await setCustomBalanceFor(global.USDC.address, owner.address, usdcTokens, 0)

  for (let i = 0; i < 10000; i++) {
    try {
      await setCustomBalanceFor(token.address, owner.address, wantedTokens, i)
    } catch(e) {
      if (await token.balanceOf(owner.address) > 0) {
        break
      }
    }
  }

  await global.USDC.connect(owner).approve(exchange.address, allowance)
  await token.connect(owner).approve(exchange.address, allowance)

  await (
    await factory.createPair(global.USDC.address, token.address)
  ).wait()

  const pair = await factory.getPair(global.USDC.address, token.address)

  await (
    await exchange.addLiquidity(
      global.USDC.address,
      token.address,
      usdcTokens.toString(),
      wantedTokens.toString(),
      1,
      1,
      global.owner.address,
      currentBlock.timestamp + 600
    )
  ).wait()

  return pair
}

const createOracles = async function (tokensData) {
  for (let token in tokensData) {
    let pair = await global.EXCHANGE_FACTORY.getPair(token, global.USDC.address)

    if (pair == '0x' + '0'.repeat(40)) {
      await createUsdcPairWithPrice(
        await ethers.getContractAt('IERC20Metadata', token),
        tokensData[token].price
      )

      pair = await global.EXCHANGE_FACTORY.getPair(token, global.USDC.address)
    }

    tokensData[token].oracle = await deploy('PiPriceOracle', pair, token)
  }

  for (let i = 0; i < 3; i++) {
    // mine + 1 minute
    await network.provider.send('hardhat_mine', ['0x2', '0x3f']) // 63 seconds
    for (let token in tokensData) {
      await tokensData[token].oracle.update()
    }
  }

  await network.provider.send('hardhat_mine', ['0x2', '0x3f'])
}

const resetHardhat = async function (blockNumber) {
  // Reset network because the rewards are not harvested for somereason
  await network.provider.request({
    method: 'hardhat_reset',
    params: [
      {
        forking: {
          jsonRpcUrl:  hre.network.config.forking.url,
          blockNumber: (blockNumber || hre.network.config.forking.blockNumber)
        },
      },
    ],
  });
}

const createCPool = async function (token, stratName, extraArgs = {}) {
  const { piGlobal, oracle } = await helpers.deployOracle()

  const cPool  = await global.CPool.deploy(piGlobal.address, token.address)
  const cToken = await global.Controller.deploy(cPool.address)

  await waitFor(cPool.setController(cToken.address))

  let strategy

  switch (stratName) {
      case 'MetaCurveStrat':
        strategy = await deploy(
          'MetaCurveStrat',
          token.address,
          cToken.address,
          global.exchange.address,
          global.owner.address,
          extraArgs.crvToken,
          extraArgs.pool,
          extraArgs.metaPool,
          extraArgs.gauge,
          extraArgs.gaugeFactory,
          extraArgs.gaugeType,
          extraArgs.poolSize,
          extraArgs.tokenIndex,
        )
        break
      case 'JarvisStrat':
        strategy = await deploy(
          'JarvisStrat',
          cToken.address,
          global.exchange.address,
          '0x546C79662E028B661dFB4767664d0273184E4dD1', // KyberSwap router
          global.owner.address
        )
        break
      case 'MStableStrat':
        strategy = await deploy(
          'MStableStrat',
          token.address,
          cToken.address,
          global.exchange.address,
          global.owner.address
        )
        break
      case 'BalancerV2Strat':
        strategy = await deploy(
          'BalancerV2Strat',
          '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
          extraArgs.poolId,
          extraArgs.gauge,
          token.address,
          cToken.address,
          global.exchange.address,
          global.owner.address
        )
        break
      case 'SolidlyLPStrat':
        strategy = await deploy(
          'SolidlyLPStrat',
          token.address,
          cToken.address,
          '0x9c12939390052919aF3155f41Bf4160Fd3666A6f', // Velodrome router
          global.owner.address,
          extraArgs.gauge,
          extraArgs.lp
        )
        break
  }

  if (strategy)
    await waitFor(cToken.setStrategy(strategy.address))

  return { cPool, cToken, oracle, piGlobal, strategy }
}


before(async function () {
  const accounts = await ethers.getSigners()

  global.owner    = accounts[0]
  global.bob      = accounts[1]
  global.alice    = accounts[2]
  global.treasury = accounts[3]
  global.deployer = accounts[accounts.length - 1]

  global.Token       = await ethers.getContractFactory('ERC20Mintable')
  global.LPool       = await ethers.getContractFactory('LiquidityPool')
  global.CPool       = await ethers.getContractFactory('CollateralPool')
  global.LToken      = await ethers.getContractFactory('LToken')
  global.DToken      = await ethers.getContractFactory('DToken')
  global.DebtSettler = await ethers.getContractFactory('DebtSettler')
  global.TokenFeed   = await ethers.getContractFactory('PriceFeedMock')
  global.Controller  = await ethers.getContractFactory('Controller')

  await fetchNeededTokens({setChainlinkRoundForNow})
})

beforeEach(async function () {
  await Promise.all([
    // Reset hardhat "state"
    network.provider.send('evm_setAutomine', [true]),
    network.provider.send('evm_setIntervalMining', [0]),
    network.provider.send('evm_mine')
  ])
})

module.exports = {
  createUsdcPairWithPrice,
  createCPool,
  createOracles,
  resetHardhat,
  setCustomBalanceFor,
  setChainlinkRound,
  setChainlinkRoundForNow,
  ...helpers
}
