// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GrailsSubscription
 * @notice Minimal subscription contract for Grails PRO tier.
 *         Users send ETH to subscribe for a given number of days.
 *         No auto-renewal; call subscribe() again to extend.
 */
contract GrailsSubscription {
    address public owner;
    uint256 public pricePerDay; // wei per day

    struct Subscription {
        uint256 expiry; // unix timestamp
    }

    mapping(address => Subscription) public subscriptions;

    event Subscribed(address indexed subscriber, uint256 expiry, uint256 amount);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event Withdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(uint256 _pricePerDay) {
        owner = msg.sender;
        pricePerDay = _pricePerDay;
    }

    /**
     * @notice Subscribe or extend subscription for `durationDays` days.
     * @param durationDays Number of days to subscribe for (minimum 1).
     */
    function subscribe(uint256 durationDays) external payable {
        require(durationDays >= 1, "Min 1 day");
        require(msg.value >= pricePerDay * durationDays, "Insufficient payment");

        uint256 currentExpiry = subscriptions[msg.sender].expiry;
        uint256 startFrom = block.timestamp > currentExpiry ? block.timestamp : currentExpiry;
        uint256 newExpiry = startFrom + (durationDays * 1 days);

        subscriptions[msg.sender].expiry = newExpiry;

        emit Subscribed(msg.sender, newExpiry, msg.value);
    }

    /**
     * @notice Check subscription expiry for an address.
     */
    function getSubscription(address subscriber) external view returns (uint256 expiry) {
        return subscriptions[subscriber].expiry;
    }

    /**
     * @notice Owner-only: withdraw collected funds.
     */
    function withdraw() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No balance");
        (bool sent, ) = owner.call{value: balance}("");
        require(sent, "Transfer failed");
        emit Withdrawn(owner, balance);
    }

    /**
     * @notice Owner-only: update the price per day.
     */
    function setPrice(uint256 _pricePerDay) external onlyOwner {
        uint256 oldPrice = pricePerDay;
        pricePerDay = _pricePerDay;
        emit PriceUpdated(oldPrice, _pricePerDay);
    }

    /**
     * @notice Owner-only: transfer ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }
}
