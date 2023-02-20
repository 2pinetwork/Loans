// SPDX-License-Identifier: MIT

pragma solidity 0.8.17;

interface IJarvisPool {
    function deposit(uint256 _pid, uint256 _amount) external;
    function withdraw(uint256 _pid, uint256 _amount) external;
    function userInfo(uint256 _pid, address _user) external view returns (uint256, uint256);
    function emergencyWithdraw(uint256 _pid) external;
    function pendingRwd(uint256 _pid, address _user) external view returns (uint256);
    function endBlock() external view returns (uint256);
}

interface IJarvisRewards {
    function claim(uint256 _amount) external;
}
