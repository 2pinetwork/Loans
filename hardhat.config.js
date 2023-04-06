require('@nomicfoundation/hardhat-toolbox')
require('@nomicfoundation/hardhat-chai-matchers')
require('solidity-coverage')

const fs = require('fs')

const loadAccounts = () => {
  if (process.env.DEPLOYER) {
    return [process.env.DEPLOYER]
  } else if (fs.existsSync('.accounts')) {
    return JSON.parse(fs.readFileSync('.accounts'))
  } else {
    return []
  }
}

const accounts = loadAccounts()
const mochaSettings = JSON.parse(fs.readFileSync('.mocharc.json'))
const isIntegration = process.env.HARDHAT_INTEGRATION_TESTS
const chainId = +process.env.HARDHAT_INTEGRATION_CHAIN

if (isIntegration) {
  mochaSettings.timeout = 300000 // 5 minutes
}

const hardhatNetwork = () => {
  if (isIntegration) {
    switch (chainId) {
        case 1:
          return {
            network_id:    chainId,
            chainId:       chainId,
            gasMultiplier: 5,
            forking:       {
              url:           `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_MAINNET_API_KEY}`,
              gasMultiplier: 5,
              blockNumber:   14980909
            }
          }
        case 10:
          return {
            network_id:    chainId,
            chainId:       chainId,
            gasMultiplier: 5,
            forking:       {
              url:           `https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_OPTIMISM_API_KEY}`,
              gasMultiplier: 5,
              blockNumber:   (+process.env.BLOCK || 22562704)
            }
          }
        case 56:
          return {
            network_id:    chainId,
            chainId:       chainId,
            gasMultiplier: 5,
            forking:       {
              url:           `https://speedy-nodes-nyc.moralis.io/${process.env.MORALIS_API_KEY}/bsc/mainnet/archive`,
              gasMultiplier: 5,
              blockNumber:   14051137
            }
          }
        case 137:
          return {
            chains: {
              137: {
                hardforkHistory: {
                  london: 23850000
                }
              }
            },
            network_id:    chainId,
            chainId:       chainId,
            gasMultiplier: 10,
            forking:       {
              url:           `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
              gasMultiplier: 10,
              blockNumber:   (+process.env.BLOCK || 19880876)
              // blockNumber:   28401104
              // blockNumber:    24479611 // test for balancer
            }
          }
        case 80001:
          return {
            network_id:    chainId,
            chainId:       chainId,
            gasMultiplier: 5,
            forking:       {
              url:           `https://polygon-mumbai.g.alchemy.com/v2/${process.env.ALCHEMY_MUMBAI_KEY}`,
              gasMultiplier: 5,
              blockNumber:   20761905
            }
          }
    }
  }

  return { hardfork: 'berlin', network_id: 31337 }
}


module.exports = {
  solidity: {
    compilers: [
      {
        version:  '0.8.17',
        settings: {
          optimizer: {
            enabled: true,
            runs:    10000
          }
        }
      },
      {
        version:  '0.6.6',
        settings: {
          optimizer: {
            enabled: true,
            runs:    10000
          }
        }
      }
    ],
    overrides: {
      'contracts/mocks/PiPriceOracle.sol': { version: '0.6.6' },
      'contracts/mocks/USDT.sol': { version: '0.4.17' },
    },
  },
  etherscan: {
    apiKey: {
      polygon:       process.env.POLYGON_SCAN_API_KEY,
      polygonMumbai: process.env.POLYGON_SCAN_API_KEY
    }
  },
  networks: {
    hardhat: hardhatNetwork(),
    mumbai: {
      url:        `https://polygon-mumbai.g.alchemy.com/v2/${process.env.ALCHEMY_MUMBAI_KEY}`,
      accounts:   accounts,
      network_id: 80001
    },
    polygon: {
      url:        `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POLYGON_API_KEY}`,
      accounts:   accounts,
      network_id: 137
    }
  },
  mocha: mochaSettings,
  gasReporter: {
    enabled:       !!process.env.REPORT_GAS,
    currency:      'USD',
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    gasPrice:      1 // to compare between tests
  },
  paths: {
    tests: isIntegration ? `./test/integration/${chainId}` : './test/unit'
  },
}
