class FilterEngine {
  constructor() {
    this.userProcessedSwaps = new Map(); // Track per-user to avoid duplicates to same user
  }

  // Main method called by bot - checks if user should be notified
  // Returns: { matches: boolean, isFirstMention: boolean }
  async shouldNotify(userId, swap, userFilters, database, firstMentionTokens = null, tokenDataCache = null) {
    const result = await this.matchesFilters(swap, this.processFilters(userFilters), database, firstMentionTokens, userId, tokenDataCache);
    return result;
  }

  // Convert database filters to usable format
  processFilters(dbFilters) {
    const filters = {
      tokens: [],
      blacklist: [],
      whale_blacklist: [],
      min_purchase: null,
      max_market_cap: null,
      monitor_all: true, // Default to monitoring all tokens
      notifications_enabled: false, // Default to OFF - user must explicitly turn ON
      first_mention_only: false // Default to monitoring all tokens, not just first mentions
    };

    // Handle case where dbFilters might not be an array
    if (!dbFilters || !Array.isArray(dbFilters)) {
      return filters;
    }

    // First pass: collect all filter data
    dbFilters.forEach(filter => {
      switch(filter.filter_type) {
        case 'token_whitelist':
          filters.tokens.push(filter.filter_value);
          break;
        case 'token_blacklist':
          filters.blacklist.push(filter.filter_value);
          break;
        case 'whale_blacklist':
          filters.whale_blacklist.push(filter.filter_value);
          break;
        case 'min_purchase':
          // Use the latest (last) min_purchase value only
          filters.min_purchase = parseFloat(filter.filter_value);
          break;
        case 'max_market_cap':
          // Use the latest (last) max_market_cap value only  
          filters.max_market_cap = parseFloat(filter.filter_value);
          break;
        case 'monitor_all':
          filters.monitor_all = filter.filter_value === 'true';
          break;
        case 'notifications_enabled':
          filters.notifications_enabled = filter.filter_value === 'true';
          break;
        case 'first_mention_only':
          filters.first_mention_only = filter.filter_value === 'true';
          break;
      }
    });

    return filters;
  }

  // Get token symbol with fallback for known tokens and API lookup
  async getTokenSymbol(token, tokenDataCache = null) {
    // First try metadata symbol
    if (token?.metadata?.symbol) {
      return token.metadata.symbol;
    }

    // Fallback mapping for known tokens without proper metadata
    // Synced with whale tracker's proven token mapping from @/lib/token-symbols
    const knownTokens = {
      // From whale tracker's proven list
      'Ey59PH7Z4BFU4HjyKnyMdWt5GGN76KazTAwQihoUXRnk': 'LAUNCHCOIN',
      'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn': 'PUMP',
      'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC': 'ai16z',
      'HUMA1821qVDKta3u2ovmfDQeW2fSQouSKE8fkF44wvGw': 'HUMA',
      'bioJ9JTqW62MLz7UKHU69gtKhPpGi1BQhccj2kmSvUJ': 'BIO',

      // Additional common tokens
      'So11111111111111111111111111111111111111112': 'SOL',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
      'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB': 'USD1',
      'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
      'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': 'bSOL',
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
      '2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk': 'ETH',
      '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': 'BTC',
      '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm': 'INF',
      'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM': 'USDCet',
      '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'WBTC'
    };

    const mint = token?.mint;
    if (mint && knownTokens[mint]) {
      return knownTokens[mint];
    }

    // Try name from metadata
    if (token?.metadata?.name) {
      return token.metadata.name;
    }

    // NEW: Fallback to Jupiter/DexScreener API if available in cache
    if (mint && tokenDataCache) {
      const cachedData = tokenDataCache.get(mint);
      if (cachedData?.symbol) {
        return cachedData.symbol;
      }
    }

    // Last resort: fetch from DexScreener directly
    if (mint) {
      try {
        const dexData = await this.getDexScreenerData(mint);
        if (dexData.symbol) {
          return dexData.symbol;
        }
      } catch (error) {
        // Silently fail and return Unknown
      }
    }

    return 'Unknown';
  }

  // Format notification message
  async formatNotification(swap, isFirstMention = false, tokenDataCache = null) {
    const isBuy = this.isBuyTransaction(swap);
    const relevantToken = isBuy ? swap.outputToken : swap.inputToken;
    const symbol = await this.getTokenSymbol(relevantToken, tokenDataCache);
    const amount = relevantToken?.amount;
    const usdValue = await this.calculateSwapValueUSD(swap, tokenDataCache);
    const whale = swap.feePayer?.slice(0, 8) + '...';
    const txHash = swap.signature?.slice(0, 8) + '...';
    const tokenCA = relevantToken?.mint;

    // Get market cap data using cached calculation
    const tokenData = tokenDataCache && tokenCA ? tokenDataCache.get(tokenCA) : await this.getTokenData(tokenCA, symbol);
    const marketCap = tokenData.marketCap;
    let marketCapFormatted = 'Unknown';
    if (marketCap > 0) {
      if (marketCap >= 1000000000) {
        marketCapFormatted = `$${(marketCap / 1000000000).toFixed(1)}B`;
      } else if (marketCap >= 1000000) {
        marketCapFormatted = `$${(marketCap / 1000000).toFixed(1)}M`;
      } else {
        marketCapFormatted = `$${Math.round(marketCap / 1000)}K`;
      }
    }

    const firstMentionTag = isFirstMention ? '🆕 NEW MENTION ' : '';

    return `${firstMentionTag}${isBuy ? '🟢 BUY' : '🔴 SELL'} Alert!

🐋 Whale: [${whale}](https://solscan.io/account/${swap.feePayer})
💰 Token: [${symbol}](https://dexscreener.com/solana/${tokenCA})${isFirstMention ? ' 🆕 FIRST TIME SEEN' : ''}
📋 CA: \`${tokenCA}\`
📊 Amount: ${amount?.toLocaleString() || 'Unknown'}
💵 Value: $${Math.round(usdValue || 0).toLocaleString()}
🏦 Market Cap: ${marketCapFormatted}
🔗 [View Transaction](https://solscan.io/tx/${swap.signature})
💹 [Trade on Pepo](https://app.pepo.fun/whaleooor)

#WhaleAlert #${symbol}`;
  }

  // Check if a swap matches user's filters
  // Returns: { matches: boolean, isFirstMention: boolean }
  async matchesFilters(swap, userFilters, database = null, firstMentionTokens = null, userId = null, tokenDataCache = null) {
    // Check if notifications are enabled first
    if (!userFilters.notifications_enabled) {
      return { matches: false, isFirstMention: false };
    }

    // Prevent same user from getting duplicate notifications for same swap
    const swapId = swap.signature || `${swap.timestamp}-${swap.feePayer}`;

    if (!this.userProcessedSwaps.has(userId)) {
      this.userProcessedSwaps.set(userId, new Set());
    }

    if (this.userProcessedSwaps.get(userId).has(swapId)) {
      return { matches: false, isFirstMention: false };
    }

    // Extract token info from swap
    const inputToken = swap.inputToken;
    const outputToken = swap.outputToken;
    
    // Filter out SOL<->stablecoin swaps (these are just conversions, not token trades)
    const stablecoins = ['USDC', 'USDT', 'BUSD', 'USD1', 'DAI', 'FRAX'];
    const inputSymbol = this.getTokenSymbol(inputToken);
    const outputSymbol = this.getTokenSymbol(outputToken);

    if ((inputSymbol === 'SOL' && stablecoins.includes(outputSymbol)) ||
        (outputSymbol === 'SOL' && stablecoins.includes(inputSymbol))) {
      return { matches: false, isFirstMention: false }; // Skip SOL<->stablecoin conversions
    }
    
    // Filter out spam tokens starting with "Xs" prefix
    const inputMint = inputToken?.mint;
    const outputMint = outputToken?.mint;
    
    if ((inputMint && inputMint.startsWith('Xs')) || (outputMint && outputMint.startsWith('Xs'))) {
      return { matches: false, isFirstMention: false }; // Skip spam tokens with "Xs" prefix
    }
    
    // Blacklist specific problematic tokens
    const hardcodedBlacklist = [
      'EJhqXKJEncSx1HJjS5ZpKdiKGGgLiRgNPvo8JZvw5Guj'
    ];
    
    if (hardcodedBlacklist.includes(inputMint) || hardcodedBlacklist.includes(outputMint)) {
      return { matches: false, isFirstMention: false }; // Skip blacklisted tokens
    }
    
    // Determine if this is a buy or sell
    const isBuy = this.isBuyTransaction(swap);
    const relevantToken = isBuy ? outputToken : inputToken;
    const swapAmountUSD = await this.calculateSwapValueUSD(swap, tokenDataCache);

    if (!relevantToken) return { matches: false, isFirstMention: false };

    // Check for first mentions using pre-identified tokens
    let isFirstMention = false;
    if (firstMentionTokens) {
      const inputMint = inputToken?.mint;
      const outputMint = outputToken?.mint;

      const inputIsFirst = inputMint && firstMentionTokens.has(inputMint);
      const outputIsFirst = outputMint && firstMentionTokens.has(outputMint);

      isFirstMention = inputIsFirst || outputIsFirst;
    }

    // Apply mode-based filtering:
    // - "monitor all" mode: receives all swaps (first mention and regular)
    // - "first mention only" mode: receives only swaps with first mention tokens
    if (userFilters.first_mention_only && !isFirstMention) {
      return { matches: false, isFirstMention: false };
    }

    // First mention status will be returned in the result object

    // Note: Server-side filtering already handles stable/SOL blacklisting via proven API
    // Trust the /api/swaps endpoint filtering and focus only on user preferences

    // Apply filters based on monitor mode
    let tokenCheck = true;
    
    if (userFilters.monitor_all) {
      // All Tokens mode: check blacklist to exclude tokens
      tokenCheck = this.checkBlacklist(relevantToken, userFilters.blacklist);
    } else {
      // Token Filter mode: check whitelist to include only specific tokens
      tokenCheck = this.checkTokenWhitelist(relevantToken, userFilters.tokens);
    }
    
    // Check hardcoded whale blacklist first
    const hardcodedWhaleBlacklist = [
      'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa'
    ];

    if (hardcodedWhaleBlacklist.includes(swap.feePayer)) {
      return { matches: false, isFirstMention: false }; // Skip blacklisted whales
    }

    // Check whale blacklist - applies to both modes
    const whaleCheck = this.checkWhaleBlacklist(swap.feePayer, userFilters.whale_blacklist);
    
    // Perform async market cap check if needed
    let marketCapCheck = true;
    if (userFilters.max_market_cap && userFilters.max_market_cap > 0) {
      marketCapCheck = await this.checkMarketCap(relevantToken, userFilters.max_market_cap, tokenDataCache);
    }

    const checks = [
      tokenCheck,
      whaleCheck,
      this.checkMinimumPurchase(swapAmountUSD, userFilters.min_purchase),
      marketCapCheck
    ];

    // All checks must pass
    const matches = checks.every(check => check === true);

    if (matches) {
      // Mark this swap as processed for this specific user only
      this.userProcessedSwaps.get(userId).add(swapId);

      // Clean up old processed swaps for this user (keep only last 100 per user)
      if (this.userProcessedSwaps.get(userId).size > 100) {
        const oldSwaps = Array.from(this.userProcessedSwaps.get(userId)).slice(0, 50);
        oldSwaps.forEach(id => this.userProcessedSwaps.get(userId).delete(id));
      }
    }

    return { matches, isFirstMention };
  }

  // Check if transaction is a buy (receiving non-stablecoin token)
  isBuyTransaction(swap) {
    const stablecoins = ['USDC', 'USDT', 'BUSD', 'USD1'];
    const outputToken = swap.outputToken;
    
    if (!outputToken) return false;
    
    // If output is a stablecoin, this is a sell
    if (stablecoins.includes(outputToken.metadata?.symbol)) return false;
    
    // If output is not SOL and not stablecoin, likely a buy
    return outputToken.metadata?.symbol !== 'SOL';
  }

  // Calculate USD value using proven token-flows logic
  async calculateSwapValueUSD(swap, tokenDataCache = null) {
    const inputToken = swap.inputToken;
    const outputToken = swap.outputToken;
    
    // Try input token first
    if (inputToken?.metadata?.symbol) {
      const stablecoins = ['USDC', 'USDT', 'BUSD', 'DAI', 'FRAX', 'USD1'];
      if (stablecoins.includes(inputToken.metadata.symbol)) {
        return inputToken.amount; // Stablecoins are ~$1
      }
      
      if (inputToken.metadata.symbol === 'SOL') {
        // Get real SOL price from cache or proven method
        const solData = tokenDataCache?.get('So11111111111111111111111111111111111111112') || await this.getTokenData('So11111111111111111111111111111111111111112', 'SOL');
        return inputToken.amount * (solData.price || 220); // Fallback to 220
      }

      // For other tokens, try to get real price from cache first
      if (inputToken.mint) {
        const tokenData = tokenDataCache?.get(inputToken.mint) || await this.getTokenData(inputToken.mint, inputToken.metadata.symbol);
        if (tokenData.price > 0) {
          return inputToken.amount * tokenData.price;
        }
      }
    }
    
    // Try output token if input failed
    if (outputToken?.metadata?.symbol) {
      const stablecoins = ['USDC', 'USDT', 'BUSD', 'DAI', 'FRAX', 'USD1'];
      if (stablecoins.includes(outputToken.metadata.symbol)) {
        return outputToken.amount; // Stablecoins are ~$1
      }
      
      if (outputToken.metadata.symbol === 'SOL') {
        // Get real SOL price from cache or proven method
        const solData = tokenDataCache?.get('So11111111111111111111111111111111111111112') || await this.getTokenData('So11111111111111111111111111111111111111112', 'SOL');
        return outputToken.amount * (solData.price || 220); // Fallback to 220
      }

      // For other tokens, try to get real price from cache first
      if (outputToken.mint) {
        const tokenData = tokenDataCache?.get(outputToken.mint) || await this.getTokenData(outputToken.mint, outputToken.metadata.symbol);
        if (tokenData.price > 0) {
          return outputToken.amount * tokenData.price;
        }
      }
    }
    
    return 0; // Can't determine USD value
  }

  // Token whitelist check - for Token Filter mode
  checkTokenWhitelist(token, allowedTokens) {
    // If no whitelist specified, block everything in Token Filter mode
    if (!allowedTokens || allowedTokens.length === 0) return false;
    
    const tokenSymbol = this.getTokenSymbol(token).toLowerCase();
    const tokenMint = token.mint?.toLowerCase();
    
    return allowedTokens.some(allowed => 
      allowed.toLowerCase() === tokenSymbol || 
      allowed.toLowerCase() === tokenMint
    );
  }

  // Blacklist check
  checkBlacklist(token, blacklistedTokens) {
    if (!blacklistedTokens || blacklistedTokens.length === 0) return true; // No blacklist = allow all
    
    const tokenSymbol = this.getTokenSymbol(token).toLowerCase();
    const tokenMint = token.mint?.toLowerCase();
    
    return !blacklistedTokens.some(blocked => 
      blocked.toLowerCase() === tokenSymbol || 
      blocked.toLowerCase() === tokenMint
    );
  }

  // Whale blacklist check
  checkWhaleBlacklist(whaleAddress, blacklistedWhales) {
    if (!blacklistedWhales || blacklistedWhales.length === 0) return true; // No blacklist = allow all
    
    return !blacklistedWhales.some(blocked => 
      blocked.toLowerCase() === whaleAddress?.toLowerCase()
    );
  }

  // Minimum purchase amount check
  checkMinimumPurchase(swapValueUSD, minPurchase) {
    if (!minPurchase || minPurchase <= 0) return true; // No minimum = allow all
    return swapValueUSD >= minPurchase;
  }

  // Market cap filter using proven token-flows logic
  async checkMarketCap(token, maxMarketCap, tokenDataCache = null) {
    if (!maxMarketCap || maxMarketCap <= 0) return true; // No filter = allow all (including unknown market cap)

    try {
      const tokenSymbol = this.getTokenSymbol(token);
      const tokenData = tokenDataCache?.get(token.mint) || await this.getTokenData(token.mint, tokenSymbol);

      // CRITICAL FIX: For hardcoded supply tokens, always trust our calculated market cap
      if (tokenData.isHardcodedSupply) {
        // For tokens like CPOOL, GUN, BIO - use our calculated market cap
        if (tokenData.marketCap === 0) {
          // If price is 0, we can't calculate market cap, so block it
          return false;
        }

        const allowed = tokenData.marketCap <= maxMarketCap;
        return allowed;
      }

      // For other tokens, use standard logic
      if (tokenData.marketCap === 0) {
        return false; // Block tokens with unknown market cap when filter is active
      }

      const allowed = tokenData.marketCap <= maxMarketCap;
      return allowed;
    } catch (error) {
      console.error(`Market cap check error for ${token.mint}:`, error);
      return false; // On error, block token (filter out) only when filter is active
    }
  }

  // Format swap for notification
  formatSwapNotification(swap) {
    const isBuy = this.isBuyTransaction(swap);
    const action = isBuy ? '🟢 BUY' : '🔴 SELL';
    const relevantToken = isBuy ? swap.outputToken : swap.inputToken;
    const swapValueUSD = this.calculateSwapValueUSD(swap);
    
    const tokenSymbol = relevantToken?.metadata?.symbol || 'Unknown';
    const tokenAmount = relevantToken?.amount?.toFixed(2) || '0';
    
    return `${action} ${tokenSymbol}

💰 Amount: ${tokenAmount} ${tokenSymbol}
💵 Value: ~$${swapValueUSD.toFixed(2)}
🐋 Whale: ${swap.feePayer?.slice(0, 8)}...${swap.feePayer?.slice(-4)}
📝 Tx: ${swap.signature?.slice(0, 8)}...${swap.signature?.slice(-4)}

🔗 [View on Solscan](https://solscan.io/tx/${swap.signature})`;
  }

  // Jupiter Price API V3 for accurate pricing
  async getJupiterPriceData(mint) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, {
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) return { price: 0, marketCap: 0, priceChange24h: 0 };

      const data = await response.json();

      if (data[mint]) {
        const tokenData = data[mint];
        return {
          price: parseFloat(tokenData.usdPrice) || 0,
          marketCap: 0, // Jupiter doesn't provide market cap, we'll calculate it
          priceChange24h: parseFloat(tokenData.priceChange24h) || 0
        };
      }

      return { price: 0, marketCap: 0, priceChange24h: 0 };
    } catch (error) {
      return { price: 0, marketCap: 0, priceChange24h: 0 };
    }
  }

  // Bulk fetch prices for multiple tokens - MASSIVE OPTIMIZATION!
  async getJupiterBulkPriceData(mints) {
    try {
      // Jupiter allows up to 50 mints at once
      const chunks = [];
      for (let i = 0; i < mints.length; i += 50) {
        chunks.push(mints.slice(i, i + 50));
      }

      const results = new Map();

      for (const chunk of chunks) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${chunk.join(',')}`, {
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();

          for (const [mint, tokenData] of Object.entries(data)) {
            results.set(mint, {
              price: parseFloat(tokenData.usdPrice) || 0,
              marketCap: 0, // Will be calculated separately
              priceChange24h: parseFloat(tokenData.priceChange24h) || 0
            });
          }
        }
      }

      return results;
    } catch (error) {
      console.error('Jupiter bulk price fetch error:', error);
      return new Map();
    }
  }

  // DexScreener API for market cap data and backup pricing
  async getDexScreenerData(mint) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) return { price: 0, marketCap: 0, priceChange24h: 0, symbol: null };

      const data = await response.json();

      if (data.pairs && data.pairs.length > 0) {
        const pair = data.pairs[0];
        return {
          price: parseFloat(pair.priceUsd) || 0,
          marketCap: pair.fdv || pair.marketCap || 0,
          priceChange24h: parseFloat(pair.priceChange?.h24) || 0,
          symbol: pair.baseToken?.symbol || null
        };
      }

      return { price: 0, marketCap: 0, priceChange24h: 0, symbol: null };
    } catch (error) {
      return { price: 0, marketCap: 0, priceChange24h: 0, symbol: null };
    }
  }

  async getTokenSupply(mint, symbol) {
    // Known token supplies for accurate market cap calculation - synced with token-flows
    const knownSupplies = {
      'SOL': 542_300_000, // 542.3M SOL circulating supply
      'USDC': 72_400_000_000, // 72.4B USDC circulating supply
      'USDT': 169_100_000_000, // 169.1B USDT circulating supply
      'GUN': 1_121_166_667,  // 1.121B circulating supply
      'CPOOL': 808_900_000,  // 808.9M circulating supply
      'PUMP': 1_000_000_000_000, // 1 quadrillion (1000 billion) circulating supply
      'BIO': 1_900_000_000, // 1.9B circulating supply
    };

    // Check by symbol first
    if (knownSupplies[symbol]) {
      return knownSupplies[symbol];
    }

    // Check by mint address patterns - ONLY pump.fun tokens that end with "pump"
    if (mint && mint.endsWith('pump')) {
      return 1_000_000_000; // 1B supply for pump.fun tokens
    }

    // Check for bonk tokens
    if (mint && mint.endsWith('bonk')) {
      return 1_000_000_000; // 1B supply for bonk tokens
    }

    return null; // Unknown supply, use API
  }

  async getTokenData(mint, symbol) {
    // 🚀 DUAL API STRATEGY: Jupiter first, DexScreener backup
    const jupiterData = await this.getJupiterPriceData(mint);
    const dexData = await this.getDexScreenerData(mint);

    // Choose best price: Jupiter first (more accurate), then DexScreener
    const bestPrice = jupiterData.price || dexData.price || 0;
    const bestPriceChange = jupiterData.priceChange24h || dexData.priceChange24h || 0;

    // Priority 1: ALWAYS use hardcoded supply calculation if available
    const knownSupply = await this.getTokenSupply(mint, symbol);
    if (knownSupply) {
      const calculatedMarketCap = bestPrice > 0 ? bestPrice * knownSupply : 0;

      return {
        price: bestPrice,
        marketCap: calculatedMarketCap, // Always use our hardcoded calculation
        priceChange24h: bestPriceChange,
        isHardcodedSupply: true,
        source: jupiterData.price > 0 ? 'Jupiter+Hardcoded' : 'DexScreener+Hardcoded'
      };
    }

    // Priority 2: Use DexScreener market cap for unknown supply tokens
    return {
      price: bestPrice,
      marketCap: dexData.marketCap || 0, // DexScreener provides market cap
      priceChange24h: bestPriceChange,
      isHardcodedSupply: false,
      source: jupiterData.price > 0 ? 'Jupiter+DexScreener' : 'DexScreener'
    };
  }

  // Note: Arbitrage filtering is handled server-side by the proven /api/swaps endpoint
  // No need to duplicate that logic here - trust the server filtering
}

module.exports = FilterEngine;