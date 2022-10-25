require('@nomicfoundation/hardhat-toolbox')
require('@nomiclabs/hardhat-etherscan')
require('solidity-coverage')

const loadAccounts = () => {
  const fs = require('fs')

  if (process.env.DEPLOYER) {
    return [process.env.DEPLOYER]
  } else if (fs.existsSync('.accounts')) {
    return JSON.parse(fs.readFileSync('.accounts'))
  } else {
    return []
  }
}

const accounts = loadAccounts()

module.exports = {
  solidity: {
    version:  '0.8.15',
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
  }
}
