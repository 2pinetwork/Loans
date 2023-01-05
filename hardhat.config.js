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

module.exports = {
  solidity: {
    version:  '0.8.17',
    settings: {
      optimizer: {
        enabled: true,
        runs:    10000
      }
    }
  },
  etherscan: {
    apiKey: {
      polygon:       process.env.POLYGON_SCAN_API_KEY,
      polygonMumbai: process.env.POLYGON_SCAN_API_KEY
    }
  },
  networks: {
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
}
