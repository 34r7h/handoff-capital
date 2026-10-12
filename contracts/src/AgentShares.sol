// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The stablecoin side: USDC on Base, or any ERC-20 / TIP-20 with the same three calls.
interface IERC20Min {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title AgentShares: shares in a handoff company of AI agents
/// @notice A company on handoff is an agent. It publishes miniapps, and each sale of those apps, plus every
/// downstream royalty when other apps include them (up to eight steps away), credits its treasury. handoff's
/// settler pays an agent's earnings out in USDC (EIP-3009 transferWithAuthorization) to the agent's payout wallet.
/// USDC that arrives that way calls nothing here, so `sync` reads the balance: whatever this contract holds above
/// what it already owes is booked pro rata to share holders, who claim it. Making the contract a company's payout
/// wallet also needs handoff's deposit poller to skip the address, or the swept USDC is credited back as balance.
/// Until that exists the company pays revenue in with `pay`, or sends it here and anyone calls `sync`.
///
/// Raise: shares sell at a fixed price, up to a cap, and the proceeds go straight to `treasury` (the address the
/// company spends from to hire agents and buy upstream components). The raise never sits in this contract.
/// Revenue: a buyer is synced in first, so new shares never collect revenue that arrived before them.
/// Dividends use the magnified per-share accumulator (O(1) per holder), and moving shares carries no past earnings.
///
/// One file and no imports, so handoff's POST /contracts/compile builds it as is. handoff's broker deploys it, so
/// the company's operator is a constructor argument, never msg.sender.
contract AgentShares {
    // ---- ERC-20 -------------------------------------------------------------------------------------------
    string public name;
    string public symbol;
    uint8 public constant decimals = 0; // a share is a whole unit
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ---- the company ----------------------------------------------------------------------------------------
    IERC20Min public immutable cash; // USDC (6 decimals on Base)
    string public companyId; // the company's handoff agent id, e.g. "agy"
    address public operator; // the company's controller: closes the raise, moves the treasury
    address public treasury; // raise proceeds go here, never into this contract

    // ---- the raise ------------------------------------------------------------------------------------------
    uint256 public immutable price; // atomic cash per share
    uint256 public immutable sharesForSale;
    uint256 public sold;
    bool public raiseOpen = true;

    // ---- dividends ------------------------------------------------------------------------------------------
    uint256 private constant MAG = 2 ** 128;
    uint256 public magnifiedPerShare; // cumulative revenue per share, times MAG
    mapping(address => int256) private corrections; // keeps earnings with whoever held the shares when booked
    mapping(address => uint256) public withdrawn;
    uint256 public reserved; // booked to holders and not yet claimed; always covered by cash.balanceOf(this)
    uint256 public totalRevenue; // every unit of cash ever booked as revenue
    uint256 public totalClaimed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Bought(address indexed buyer, uint256 shares, uint256 cost);
    event Revenue(uint256 amount, string ref);
    event Claimed(address indexed holder, uint256 amount);
    event RaiseClosed(uint256 sold);
    event TreasuryMoved(address treasury);
    event OperatorMoved(address operator);

    error NotOperator();
    error RaiseIsClosed();
    error OverCap(uint256 left);
    error BadAddress();
    error BadLength();
    error CashTransferFailed();
    error NotEnough();
    error TooLarge();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @param founders the agents' wallets that hold founding shares (members of the handoff company)
    constructor(
        string memory companyId_,
        string memory name_,
        string memory symbol_,
        IERC20Min cash_,
        address operator_,
        address treasury_,
        uint256 price_,
        uint256 sharesForSale_,
        address[] memory founders,
        uint256[] memory founderShares
    ) {
        if (address(cash_) == address(0) || operator_ == address(0) || treasury_ == address(0)) revert BadAddress();
        if (treasury_ == address(this)) revert BadAddress();
        if (founders.length != founderShares.length) revert BadLength();
        companyId = companyId_;
        name = name_;
        symbol = symbol_;
        cash = cash_;
        operator = operator_;
        treasury = treasury_;
        price = price_;
        sharesForSale = sharesForSale_;
        for (uint256 i = 0; i < founders.length; i++) _mint(founders[i], founderShares[i]);
    }

    // ---- the raise ------------------------------------------------------------------------------------------

    /// @notice Buy `shares` at `price` each. The cost moves from the buyer to the treasury in the same call.
    function buy(uint256 shares) external {
        if (!raiseOpen) revert RaiseIsClosed();
        if (shares == 0) revert NotEnough();
        uint256 left = sharesForSale - sold;
        if (shares > left) revert OverCap(left);
        sync(); // revenue that arrived before this purchase belongs to the holders before it
        uint256 cost = shares * price;
        sold += shares;
        _mint(msg.sender, shares);
        emit Bought(msg.sender, shares, cost);
        if (!cash.transferFrom(msg.sender, treasury, cost)) revert CashTransferFailed();
    }

    function closeRaise() external onlyOperator {
        raiseOpen = false;
        emit RaiseClosed(sold);
    }

    function setTreasury(address t) external onlyOperator {
        if (t == address(0) || t == address(this)) revert BadAddress();
        treasury = t;
        emit TreasuryMoved(t);
    }

    function setOperator(address o) external onlyOperator {
        if (o == address(0)) revert BadAddress();
        operator = o;
        emit OperatorMoved(o);
    }

    // ---- revenue --------------------------------------------------------------------------------------------

    /// @notice Book any cash that arrived here without a call (a settler payout or a plain transfer) as revenue.
    /// @return booked the amount newly divided among holders
    function sync() public returns (uint256 booked) {
        booked = _unbooked();
        if (booked > 0) _book(booked, "");
    }

    /// @notice Pay revenue in with a reference, e.g. a handoff sale id or "royalty SirKit/Hexspan". Needs approval.
    function pay(uint256 amount, string calldata ref) external {
        sync();
        if (amount == 0) revert NotEnough();
        if (!cash.transferFrom(msg.sender, address(this), amount)) revert CashTransferFailed();
        if (totalSupply == 0) return; // nobody to pay yet; the next sync books it
        _book(amount, ref);
    }

    function _unbooked() private view returns (uint256) {
        if (totalSupply == 0) return 0;
        uint256 bal = cash.balanceOf(address(this));
        return bal > reserved ? bal - reserved : 0;
    }

    function _book(uint256 amount, string memory ref) private {
        magnifiedPerShare += (amount * MAG) / totalSupply;
        reserved += amount;
        totalRevenue += amount;
        emit Revenue(amount, ref);
    }

    // ---- dividends ------------------------------------------------------------------------------------------

    function _earned(address who, uint256 perShare) private view returns (uint256) {
        int256 magnified = _signed(perShare * balanceOf[who]) + corrections[who];
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(magnified) / MAG; // never negative: corrections only remove what was booked before a holding

    }

    /// @notice What `who` can claim now, counting revenue that has arrived but is not booked yet.
    function claimable(address who) public view returns (uint256) {
        uint256 perShare = magnifiedPerShare;
        uint256 pending = _unbooked();
        if (pending > 0) perShare += (pending * MAG) / totalSupply;
        return _earned(who, perShare) - withdrawn[who];
    }

    /// @notice Everything `who` has been paid out of this contract plus what is still waiting for them.
    function lifetimeEarned(address who) external view returns (uint256) {
        return claimable(who) + withdrawn[who];
    }

    function claim() external returns (uint256 amount) {
        sync();
        amount = _earned(msg.sender, magnifiedPerShare) - withdrawn[msg.sender];
        if (amount == 0) return 0;
        withdrawn[msg.sender] += amount;
        reserved -= amount;
        totalClaimed += amount;
        if (!cash.transfer(msg.sender, amount)) revert CashTransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// @notice One read for a page: the raise and the revenue in a single call.
    function state()
        external
        view
        returns (uint256 supply, uint256 sold_, uint256 forSale, uint256 price_, bool open, uint256 revenue, uint256 claimed, uint256 unbooked)
    {
        return (totalSupply, sold, sharesForSale, price, raiseOpen, totalRevenue, totalClaimed, _unbooked());
    }

    // ---- ERC-20 mechanics -----------------------------------------------------------------------------------

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < value) revert NotEnough();
            allowance[from][msg.sender] = a - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        if (to == address(0) || to == address(this)) revert BadAddress(); // shares held here could never claim
        if (balanceOf[from] < value) revert NotEnough();
        sync(); // book what arrived first, so it stays with the sender
        balanceOf[from] -= value;
        balanceOf[to] += value;
        int256 c = _signed(magnifiedPerShare * value);
        corrections[from] += c;
        corrections[to] -= c;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) private {
        if (to == address(0)) revert BadAddress();
        totalSupply += value;
        balanceOf[to] += value;
        corrections[to] -= _signed(magnifiedPerShare * value);
        emit Transfer(address(0), to, value);
    }

    function _signed(uint256 x) private pure returns (int256) {
        if (x > uint256(type(int256).max)) revert TooLarge();
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(x); // checked on the line above
    }
}
