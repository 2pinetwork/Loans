// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

contract PriceFeedMock {
    int256 public price;

    constructor(int256 _price) {
        price = _price;
    }

    function setPrice(int256 _price) public {
        price = _price;
    }

    function decimals() public pure returns (uint8) {
        return 8;
    }

    function latestRoundData() public view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        roundId = uint80(block.number);
        answer = price;
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
        answeredInRound = uint80(block.number);
    }
}
