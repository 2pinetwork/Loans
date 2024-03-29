module.exports = {
  env: {
    commonjs: true,
    es2021:   true,
    node:     true,
    jest:     true
  },
  extends: 'eslint:recommended',
  root: true,
  globals: {
    BTC:             'readonly',
    CRV:             'readonly',
    DAI:             'readonly',
    MUSD:            'readonly',
    OP:              'readonly',
    Promise:         'readonly',
    USDC:            'readonly',
    USDT:            'readonly',
    WETH:            'readonly',
    WMATIC:          'readonly',
    afterEach:       'readonly',
    alice:           'readonly',
    before:          'readonly',
    beforeEach:      'readonly',
    bob:             'readonly',
    exchange:        'readonly',
    usdtFeed:        'readonly',
    crvFeed:         'readonly',
    daiFeed:         'readonly',
    deployer:        'readonly',
    describe:        'readonly',
    ethFeed:         'readonly',
    ethers:          'readonly',
    global:          'writable',
    hre:             'readonly',
    it:              'readonly',
    network:         'readonly',
    opFeed:          'readonly',
    owner:           'readonly',
    process:         'readonly',
    require:         'readonly',
    solidlyExchange: 'readonly',
    treasury:        'readonly',
    usdcFeed:        'readonly',
    web3:            'readonly',
  },
  parserOptions: {
    ecmaVersion: 'latest'
  },
  rules: {
  }
}
