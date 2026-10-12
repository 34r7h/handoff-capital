// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentShares, IERC20Min} from "../src/AgentShares.sol";

/// USDC stand-in: 6 decimals, mint for tests.
contract MockUSDC {
    string public constant name = "USD Coin (test)";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
        return true;
    }
}

contract AgentSharesTest is Test {
    MockUSDC usdc;
    AgentShares shares;

    address deployer = makeAddr("handoff-deployer"); // the broker's deployer signs the create, not the company
    address company = makeAddr("agy"); // the company agent's wallet: operator
    address treasury = makeAddr("agy-treasury");
    address settler = makeAddr("handoff-settler"); // stands in for the payout, which reaches the contract without a call
    address funny = makeAddr("funny");
    address smarty = makeAddr("smarty");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant USDC = 1e6;
    uint256 constant PRICE = 1 * USDC; // 1 USDC per share

    event Revenue(uint256 amount, string ref);
    event Bought(address indexed buyer, uint256 shares, uint256 cost);

    function setUp() public {
        usdc = new MockUSDC();
        address[] memory f = new address[](2);
        f[0] = funny;
        f[1] = smarty;
        uint256[] memory n = new uint256[](2);
        n[0] = 600;
        n[1] = 400;
        vm.prank(deployer);
        shares = new AgentShares("agy", "agy shares", "AGY", IERC20Min(address(usdc)), company, treasury, PRICE, 1000, f, n);
        usdc.mint(settler, 1_000_000 * USDC);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            usdc.mint(who, 10_000 * USDC);
            vm.prank(who);
            usdc.approve(address(shares), type(uint256).max);
        }
    }

    function sweep(uint256 amount) internal {
        vm.prank(settler);
        usdc.transfer(address(shares), amount);
    }

    function test_foundersAndOperator() public view {
        assertEq(shares.totalSupply(), 1000);
        assertEq(shares.balanceOf(funny), 600);
        assertEq(shares.balanceOf(smarty), 400);
        assertEq(shares.operator(), company, "operator is the constructor argument, not the deployer");
        assertEq(shares.companyId(), "agy");
        assertEq(shares.decimals(), 0);
    }

    function test_buyPaysTreasuryNotContract() public {
        vm.expectEmit(true, false, false, true);
        emit Bought(alice, 250, 250 * PRICE);
        vm.prank(alice);
        shares.buy(250);
        assertEq(shares.balanceOf(alice), 250);
        assertEq(shares.totalSupply(), 1250);
        assertEq(shares.sold(), 250);
        assertEq(usdc.balanceOf(treasury), 250 * PRICE);
        assertEq(usdc.balanceOf(address(shares)), 0, "the raise never sits in the share contract");
        assertEq(shares.claimable(alice), 0);
    }

    function test_capAndClose() public {
        vm.prank(alice);
        shares.buy(900);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentShares.OverCap.selector, 100));
        shares.buy(101);
        vm.prank(alice);
        vm.expectRevert(AgentShares.NotOperator.selector);
        shares.closeRaise();
        vm.prank(company);
        shares.closeRaise();
        vm.prank(bob);
        vm.expectRevert(AgentShares.RaiseIsClosed.selector);
        shares.buy(1);
    }

    function test_sweepIsDividedProRata() public {
        sweep(1000 * USDC);
        assertEq(shares.claimable(funny), 600 * USDC, "unsynced revenue already shows as claimable");
        assertEq(shares.claimable(smarty), 400 * USDC);
        vm.prank(funny);
        assertEq(shares.claim(), 600 * USDC);
        assertEq(usdc.balanceOf(funny), 600 * USDC);
        assertEq(shares.claimable(funny), 0);
        assertEq(shares.totalRevenue(), 1000 * USDC);
        vm.prank(smarty);
        shares.claim();
        assertEq(usdc.balanceOf(address(shares)), 0);
        assertEq(shares.reserved(), 0);
    }

    function test_lateBuyerGetsNoEarlierRevenue() public {
        sweep(1000 * USDC); // arrives, nobody syncs
        vm.prank(alice);
        shares.buy(1000); // syncs first
        assertEq(shares.claimable(alice), 0);
        assertEq(shares.claimable(funny), 600 * USDC);
        sweep(2000 * USDC); // now 2000 shares outstanding
        assertEq(shares.claimable(alice), 1000 * USDC);
        assertEq(shares.claimable(funny), 600 * USDC + 600 * USDC);
        assertEq(shares.claimable(smarty), 400 * USDC + 400 * USDC);
    }

    function test_transferMovesFutureEarningsOnly() public {
        sweep(1000 * USDC);
        vm.prank(funny);
        shares.transfer(alice, 300);
        assertEq(shares.claimable(funny), 600 * USDC, "earned before the transfer stays with the sender");
        assertEq(shares.claimable(alice), 0);
        sweep(1000 * USDC);
        assertEq(shares.claimable(funny), 900 * USDC);
        assertEq(shares.claimable(alice), 300 * USDC);
        vm.prank(alice);
        shares.approve(bob, 100);
        vm.prank(bob);
        shares.transferFrom(alice, bob, 100);
        sweep(1000 * USDC);
        assertEq(shares.claimable(alice), 300 * USDC + 200 * USDC);
        assertEq(shares.claimable(bob), 100 * USDC);
    }

    function test_payWithReference() public {
        usdc.mint(company, 50 * USDC);
        vm.startPrank(company);
        usdc.approve(address(shares), 50 * USDC);
        vm.expectEmit(false, false, false, true);
        emit Revenue(50 * USDC, "royalty SirKit/Hexspan");
        shares.pay(50 * USDC, "royalty SirKit/Hexspan");
        vm.stopPrank();
        assertEq(shares.claimable(funny), 30 * USDC);
    }

    function test_noHoldersNoBooking() public {
        address[] memory none = new address[](0);
        uint256[] memory zero = new uint256[](0);
        AgentShares empty =
            new AgentShares("x", "x", "X", IERC20Min(address(usdc)), company, treasury, PRICE, 10, none, zero);
        vm.prank(settler);
        usdc.transfer(address(empty), 5 * USDC);
        assertEq(empty.sync(), 0);
        assertEq(empty.reserved(), 0);
    }

    function test_cannotSendSharesToTheContract() public {
        vm.prank(funny);
        vm.expectRevert(AgentShares.BadAddress.selector);
        shares.transfer(address(shares), 1);
    }

    function test_constructorRejectsZeroOperator() public {
        address[] memory none = new address[](0);
        uint256[] memory zero = new uint256[](0);
        vm.expectRevert(AgentShares.BadAddress.selector);
        new AgentShares("x", "x", "X", IERC20Min(address(usdc)), address(0), treasury, PRICE, 10, none, zero);
    }

    /// Any order of buys, transfers and payouts: the contract always holds what it owes, every payout is booked,
    /// and holders are paid all of it except rounding, under one atomic unit per holder.
    function testFuzz_conservation(uint8[24] calldata ops, uint32[24] calldata amts) public {
        address[4] memory who = [funny, smarty, alice, bob];
        uint256 swept;
        for (uint256 i = 0; i < ops.length; i++) {
            uint256 op = ops[i] % 3;
            uint256 a = uint256(amts[i]);
            if (op == 0) {
                address b = i % 2 == 0 ? alice : bob;
                uint256 left = shares.sharesForSale() - shares.sold();
                uint256 n = left == 0 ? 0 : 1 + (a % left);
                if (n > 0) {
                    vm.prank(b);
                    shares.buy(n);
                }
            } else if (op == 1) {
                address from = who[a % 4];
                address to = who[(a / 4) % 4];
                uint256 bal = shares.balanceOf(from);
                if (bal > 0) {
                    vm.prank(from);
                    shares.transfer(to, 1 + (a % bal));
                }
            } else if (a > 0) {
                sweep(a);
                swept += a;
            }
            assertGe(usdc.balanceOf(address(shares)), shares.reserved(), "cash covers what is owed");
        }
        uint256 paid;
        for (uint256 k = 0; k < 4; k++) {
            vm.prank(who[k]);
            paid += shares.claim();
        }
        assertEq(paid, shares.totalClaimed());
        assertLe(paid, shares.totalRevenue());
        assertEq(shares.totalRevenue(), swept, "every payout is booked");
        assertLt(shares.totalRevenue() - paid, 4, "rounding leaves under one unit per holder");
    }
}
