module.exports = {
  enableTimeouts: false,
  configureYulOptimizer: true,
  skipFiles: [
    'mocks/ERC20Mintable.sol',
    'mocks/PriceFeedMock.sol',
    'mocks/MockStrat.sol',
  ]
}
