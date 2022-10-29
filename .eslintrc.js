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
    Promise:    'readonly',
    USDC:       'readonly',
    afterEach:  'readonly',
    before:     'readonly',
    beforeEach: 'readonly',
    describe:   'readonly',
    ethers:     'readonly',
    global:     'writable',
    hre:        'readonly',
    it:         'readonly',
    network:    'readonly',
    owner:      'readonly',
    process:    'readonly',
    require:    'readonly',
    web3:       'readonly',
  },
  parserOptions: {
    ecmaVersion: 'latest'
  },
  rules: {
  }
}
