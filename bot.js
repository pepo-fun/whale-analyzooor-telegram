const { Bot, InlineKeyboard } = require('grammy');
const cron = require('node-cron');
const UserDatabase = require('./database-railway');
const FilterEngine = require('./filters');

// Load environment variables
require('dotenv').config();

class WhaleBot {
  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.apiUrl = process.env.WHALE_API_URL || 'http://localhost:3000/api/swaps';
    this.pollingInterval = process.env.POLLING_INTERVAL || 10;
    
    if (!this.token) {
      console.error('TELEGRAM_BOT_TOKEN not found in environment variables');
      process.exit(1);
    }

    this.bot = new Bot(this.token);
    this.db = new UserDatabase();
    this.filterEngine = new FilterEngine();

    // Rate limiting: 500 interactions per user per day
    this.rateLimiter = new Map();
    this.dailyLimit = 500;

    this.setupCommands();
    this.startMonitoring();
  }

  // Check if user has exceeded daily rate limit
  checkRateLimit(userId) {
    const now = Date.now();
    const today = Math.floor(now / (24 * 60 * 60 * 1000)); // Days since epoch

    const userKey = `${userId}_${today}`;
    const currentCount = this.rateLimiter.get(userKey) || 0;

    if (currentCount >= this.dailyLimit) {
      return false; // Rate limited
    }

    this.rateLimiter.set(userKey, currentCount + 1);
    return true; // OK to proceed
  }

  setupCommands() {
    // Start command
    this.bot.command('start', async (ctx) => {
      const chatId = ctx.chat.id;
      const username = ctx.from.username;

      // Check rate limit
      if (!this.checkRateLimit(chatId)) {
        await ctx.reply('⚠️ Daily limit exceeded (500 interactions/day). Try again tomorrow!');
        return;
      }

      await this.db.addUser(chatId, username);
      
      const welcomeMessage = `🐋 Welcome to Whale Tracker Bot!

I monitor Solana whale transactions and send personalized alerts.

**⚠️ Bot starts OFF by default**
Use /menu to:
• Turn the bot ON 🔔
• Choose: All Tokens or Token Filter mode
• Configure your filters

Get started with /menu!`;

      await ctx.reply(welcomeMessage);
    });

    // Menu command
    this.bot.command('menu', async (ctx) => {
      // Check rate limit
      if (!this.checkRateLimit(ctx.chat.id)) {
        await ctx.reply('⚠️ Daily limit exceeded (500 interactions/day). Try again tomorrow!');
        return;
      }

      this.showMainMenu(ctx.chat.id);
    });

    // Help command
    this.bot.command('help', async (ctx) => {
      const helpText = `🐋 Whale Tracker Bot Help

Commands:
/start - Initialize your account
/menu - Configure filters and settings
/filters - View your current filters
/help - Show this help message

Filter Types:
• Token Whitelist - Track specific tokens only
• Minimum Purchase - Set USD threshold for alerts
• Maximum Market Cap - Filter out high market cap tokens
• Token Blacklist - Ignore specific tokens

The bot monitors whale transactions every ${this.pollingInterval} seconds and sends alerts when transactions match your filters.`;

      await ctx.reply(helpText);
    });

    // Filters command
    this.bot.command('filters', async (ctx) => {
      const chatId = ctx.chat.id;
      const filters = await this.db.getUserFilters(chatId);
      
      if (filters.length === 0) {
        await ctx.reply('❌ You have no active filters. Use /menu to set up filters.');
        return;
      }

      let filtersText = '🔍 Your Active Filters:\n\n';
      
      const filterGroups = {
        token_whitelist: '✅ Token Whitelist',
        min_purchase: '💰 Minimum Purchase',
        max_market_cap: '📊 Maximum Market Cap', 
        token_blacklist: '🚫 Token Blacklist',
        whale_blacklist: '🐋 Whale Blacklist'
      };

      for (const [type, title] of Object.entries(filterGroups)) {
        const typeFilters = filters.filter(f => f.filter_type === type);
        if (typeFilters.length > 0) {
          filtersText += `${title}:\n`;
          typeFilters.forEach(filter => {
            filtersText += `  • ${filter.filter_value}\n`;
          });
          filtersText += '\n';
        }
      }

      await ctx.reply(filtersText);
    });

    // Handle callback queries (inline keyboard buttons)
    this.bot.on('callback_query', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const chatId = ctx.chat.id;

      // Check rate limit for button interactions
      if (!this.checkRateLimit(chatId)) {
        await ctx.reply('⚠️ Daily limit exceeded (500 interactions/day). Try again tomorrow!');
        await ctx.answerCallbackQuery();
        return;
      }

      try {
        if (data === 'add_token') {
          await ctx.reply('Enter token symbol or mint address to whitelist:', {
            reply_markup: { force_reply: true }
          });
          this.awaitingInput[chatId] = 'token_whitelist';
          
        } else if (data === 'add_min_purchase') {
          await ctx.reply('Enter minimum purchase amount in USD:', {
            reply_markup: { force_reply: true }
          });
          this.awaitingInput[chatId] = 'min_purchase';
          
        } else if (data === 'add_max_market_cap') {
          await ctx.reply('Enter maximum market cap in USD:', {
            reply_markup: { force_reply: true }
          });
          this.awaitingInput[chatId] = 'max_market_cap';
          
        } else if (data === 'add_blacklist') {
          await ctx.reply('Enter token symbol or mint address to blacklist:', {
            reply_markup: { force_reply: true }
          });
          this.awaitingInput[chatId] = 'token_blacklist';
          
        } else if (data === 'add_whale_blacklist') {
          await ctx.reply('Enter whale address to blacklist:', {
            reply_markup: { force_reply: true }
          });
          this.awaitingInput[chatId] = 'whale_blacklist';
          
        } else if (data === 'view_filters') {
          await this.showFilters(chatId);
          
        } else if (data === 'cycle_monitor_mode') {
          const filters = await this.db.getUserFilters(chatId);
          const processedFilters = this.filterEngine.processFilters(filters);

          // Determine current mode
          let currentMode = 'all_tokens';
          if (processedFilters.first_mention_only) {
            currentMode = 'first_mention';
          } else if (!processedFilters.monitor_all) {
            currentMode = 'token_filter';
          }

          // Cycle to next mode: all_tokens → token_filter → first_mention → all_tokens
          let nextMode;
          if (currentMode === 'all_tokens') {
            nextMode = 'token_filter';
          } else if (currentMode === 'token_filter') {
            nextMode = 'first_mention';
          } else {
            nextMode = 'all_tokens';
          }

          // Clear existing mode filters
          await this.db.clearFilters(chatId, 'monitor_all');
          await this.db.clearFilters(chatId, 'first_mention_only');

          // Set new mode
          if (nextMode === 'all_tokens') {
            await this.db.addFilter(chatId, 'monitor_all', 'true');
            await this.db.addFilter(chatId, 'first_mention_only', 'false');
          } else if (nextMode === 'token_filter') {
            await this.db.addFilter(chatId, 'monitor_all', 'false');
            await this.db.addFilter(chatId, 'first_mention_only', 'false');
          } else if (nextMode === 'first_mention') {
            await this.db.addFilter(chatId, 'monitor_all', 'true');
            await this.db.addFilter(chatId, 'first_mention_only', 'true');
          }

          // Auto-disable notifications when mode is changed (consistency)
          await this.db.clearFilters(chatId, 'notifications_enabled');
          await this.db.addFilter(chatId, 'notifications_enabled', 'false');

          const modeNames = {
            'all_tokens': 'All Tokens',
            'token_filter': 'Token Filter',
            'first_mention': 'First Mention Only'
          };

          await ctx.reply(`🔄 Mode changed to: ${modeNames[nextMode]}\n\n⚠️ Pingooor has been automatically turned OFF due to mode change. Use /menu to turn it back ON when you're ready.`);

          // Small delay to ensure database update completes
          setTimeout(() => {
            this.showMainMenu(chatId);
          }, 100);
          
        } else if (data === 'toggle_notifications') {
          const filters = await this.db.getUserFilters(chatId);
          const processedFilters = this.filterEngine.processFilters(filters);
          const newValue = !processedFilters.notifications_enabled;
          
          // Clear all notifications_enabled filters first
          await this.db.clearFilters(chatId, 'notifications_enabled');
          // Add new notifications_enabled filter
          await this.db.addFilter(chatId, 'notifications_enabled', newValue.toString());
          
          await ctx.reply(`${newValue ? '🔔' : '🔕'} Pingoor notifications ${newValue ? 'enabled' : 'disabled'}!`);
          
          // Small delay to ensure database update completes
          setTimeout(() => {
            this.showMainMenu(chatId);
          }, 100);

        } else if (data === 'clear_all_filters') {
          await this.db.clearFilters(chatId);
          
          // Auto-disable notifications when filters are cleared
          await this.db.addFilter(chatId, 'notifications_enabled', 'false');
          
          await ctx.reply('✅ All filters cleared!\n\n⚠️ Pingooor has been automatically turned OFF. Use /menu to turn it back ON when you\'re ready.');
          
        } else if (data === 'back_to_menu') {
          this.showMainMenu(chatId);
          
        } else if (data.startsWith('del_')) {
          // Handle individual filter deletion using index
          const [, shortType, filterIndex] = data.split('_');
          const index = parseInt(filterIndex);

          // Map short types back to full filter types
          const typeMapping = {
            'tw': 'token_whitelist',
            'mp': 'min_purchase',
            'mc': 'max_market_cap',
            'tb': 'token_blacklist',
            'wb': 'whale_blacklist'
          };

          const filterType = typeMapping[shortType];

          try {
            const filters = await this.db.getUserFilters(chatId);
            const typeFilters = filters.filter(f => f.filter_type === filterType);

            if (index >= 0 && index < typeFilters.length) {
              const filterToDelete = typeFilters[index];
              await this.db.removeFilter(chatId, filterType, filterToDelete.filter_value);
              
              // Auto-disable notifications when filters are modified
              await this.db.clearFilters(chatId, 'notifications_enabled');
              await this.db.addFilter(chatId, 'notifications_enabled', 'false');
              
              await ctx.reply(`✅ Filter removed: ${filterToDelete.filter_value}\n\n⚠️ Pingooor has been automatically turned OFF due to filter changes. Use /menu to turn it back ON when you're done configuring.`);
              
              // Show updated filters after deletion
              setTimeout(() => {
                this.showFilters(chatId);
              }, 100);
            } else {
              await ctx.reply('❌ Filter not found. Please try again.');
            }

          } catch (error) {
            await ctx.reply('❌ Error removing filter. Please try again.');
          }
        }

        await ctx.answerCallbackQuery();
      } catch (error) {
        await ctx.answerCallbackQuery('Error processing request');
      }
    });

    // Handle text messages (filter input)
    this.awaitingInput = {};
    
    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text;
      
      // Skip if it's a command
      if (text.startsWith('/')) return;
      
      // Check if we're waiting for input
      if (this.awaitingInput[chatId]) {
        const filterType = this.awaitingInput[chatId];
        delete this.awaitingInput[chatId];
        
        try {
          if (filterType === 'min_purchase' || filterType === 'max_market_cap') {
            const value = parseInt(text);
            if (isNaN(value) || value <= 0 || text.includes('.')) {
              await ctx.reply('❌ Please enter a valid positive whole number (no decimals).');
              return;
            }
            // Clear existing values for single-value filters
            await this.db.clearFilters(chatId, filterType);
          }
          
          // Check limits for multi-value filters
          if (filterType === 'token_whitelist' || filterType === 'token_blacklist' || filterType === 'whale_blacklist') {
            const existingFilters = await this.db.getUserFilters(chatId);
            const existingCount = existingFilters.filter(f => f.filter_type === filterType).length;
            
            if (existingCount >= 20) {
              await ctx.reply('❌ Maximum 20 items allowed for this filter type. Clear some first.');
              return;
            }
          }
          
          await this.db.addFilter(chatId, filterType, text);
          
          // Auto-disable notifications when filters are modified
          await this.db.clearFilters(chatId, 'notifications_enabled');
          await this.db.addFilter(chatId, 'notifications_enabled', 'false');
          
          await ctx.reply(`✅ Filter added successfully!\n\n⚠️ Pingooor has been automatically turned OFF due to filter changes. Use /menu to turn it back ON when you're done configuring.`);
          
        } catch (error) {
          await ctx.reply('❌ Error adding filter. Please try again.');
        }
      }
    });

    // Error handling
    this.bot.catch((err) => {
      // Silent error handling
    });
  }

  async showMainMenu(chatId) {
    // Get current settings
    const filters = await this.db.getUserFilters(chatId);
    const processedFilters = this.filterEngine.processFilters(filters);
    
    // Determine current mode for 3-way toggle
    let currentMode = 'all_tokens'; // default
    if (processedFilters.first_mention_only) {
      currentMode = 'first_mention';
    } else if (!processedFilters.monitor_all) {
      currentMode = 'token_filter';
    }

    // Set button text to show NEXT mode (what you get when you click)
    let modeButtonText = '🔵 All Tokens';
    if (currentMode === 'all_tokens') {
      modeButtonText = '⚪ Token Filter'; // Click to get Token Filter
    } else if (currentMode === 'token_filter') {
      modeButtonText = '🆕 First Mention Only'; // Click to get First Mention Only
    } else if (currentMode === 'first_mention') {
      modeButtonText = '🔵 All Tokens'; // Click to get All Tokens
    }

    const keyboard = new InlineKeyboard()
      .text(modeButtonText, 'cycle_monitor_mode').row()
      .text(processedFilters.notifications_enabled ? '🔕 Turn OFF' : '🔔 Turn ON', 'toggle_notifications').row()
      .text('➕ Add Token Whitelist', 'add_token').row()
      .text('💰 Set Min Purchase', 'add_min_purchase').row()
      .text('📊 Set Max Market Cap', 'add_max_market_cap').row()
      .text('🚫 Add Token Blacklist', 'add_blacklist').row()
      .text('🐋 Add Whale Blacklist', 'add_whale_blacklist').row()
      .text('🔍 View Filters', 'view_filters')
      .text('🗑️ Clear All', 'clear_all_filters');

    // Get current mode name for display
    let currentModeName = 'All Tokens';
    if (currentMode === 'token_filter') {
      currentModeName = 'Token Filter';
    } else if (currentMode === 'first_mention') {
      currentModeName = 'First Mention Only';
    }

    const menuText = `🐋 Whaleooor Pingooor Settings

**Current Status:**
• Mode: ${currentModeName}
• Pingoor: ${processedFilters.notifications_enabled ? 'ON 🔔' : 'OFF 🔕'}

**How it works:**
• **All Tokens + ON**: Get alerts for all whale transactions (use blacklist to exclude)
• **Token Filter + ON**: Only get alerts for whitelisted tokens
• **First Mention Only + ON**: Only get alerts for tokens appearing for the first time
• **OFF**: No notifications (bot is paused)

**Configure your settings:**
• **Mode Button**: Cycles between All Tokens → Token Filter → First Mention Only
• **Pingoor Toggle**: Turn bot ON/OFF
• **Token Whitelist**: Add tokens to monitor (Token Filter mode)
• **Token Blacklist**: Exclude tokens (All Tokens mode)
• **Whale Blacklist**: Block specific whale addresses
• **Min Purchase/Max Market Cap**: Additional filters

Choose an option below:`;

    try {
      await this.bot.api.sendMessage(chatId, menuText, {
        reply_markup: keyboard,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      // Silent error handling
    }
  }

  async showFilters(chatId) {
    const filters = await this.db.getUserFilters(chatId);
    
    if (filters.length === 0) {
      await this.bot.api.sendMessage(chatId, '❌ You have no active filters.');
      return;
    }

    let filtersText = '🔍 Your Active Filters:\n\n';
    const keyboard = new InlineKeyboard();
    
    const filterGroups = {
      token_whitelist: '✅ Token Whitelist',
      min_purchase: '💰 Minimum Purchase',
      max_market_cap: '📊 Maximum Market Cap',
      token_blacklist: '🚫 Token Blacklist',
      whale_blacklist: '🐋 Whale Blacklist'
    };

    // Short filter type mapping for callback data
    const shortTypes = {
      token_whitelist: 'tw',
      min_purchase: 'mp',
      max_market_cap: 'mc', 
      token_blacklist: 'tb',
      whale_blacklist: 'wb'
    };

    for (const [type, title] of Object.entries(filterGroups)) {
      const typeFilters = filters.filter(f => f.filter_type === type);
      if (typeFilters.length > 0) {
        filtersText += `${title}:\n`;
        typeFilters.forEach((filter, index) => {
          filtersText += `  • ${filter.filter_value}\n`;
          // Add delete button for each filter using short type and index
          const shortValue = filter.filter_value.length > 8 ? 
            filter.filter_value.slice(0, 8) + '...' : filter.filter_value;
          keyboard.text(`❌ ${shortValue}`, `del_${shortTypes[type]}_${index}`).row();
        });
        filtersText += '\n';
      }
    }

    keyboard.text('🔙 Back to Menu', 'back_to_menu');

    await this.bot.api.sendMessage(chatId, filtersText + '\n💡 Tap ❌ to delete individual filters', {
      reply_markup: keyboard
    });
  }

  startMonitoring() {
    
    // Run every X seconds based on POLLING_INTERVAL
    cron.schedule(`*/${this.pollingInterval} * * * * *`, async () => {
      try {
        await this.checkForNewSwaps();
      } catch (error) {
      }
    });
  }

  async checkForNewSwaps() {
    try {
      // Fetch latest swaps from the API
      const response = await fetch(this.apiUrl);
      if (!response.ok) {
        return;
      }

      const swaps = await response.json();
      if (!Array.isArray(swaps) || swaps.length === 0) {
        return;
      }

      // Get all users
      const users = await this.db.getAllUsers();
      console.log(`👥 ${users?.length || 0} users`);

      // First, identify which tokens are first mentions (don't mark them yet)
      const firstMentionTokens = new Set();
      for (const swap of swaps) {
        const inputMint = swap.inputToken?.mint;
        const outputMint = swap.outputToken?.mint;

        if (inputMint) {
          const isKnown = await this.db.isTokenKnown(inputMint);
          if (!isKnown) {
            firstMentionTokens.add(inputMint);
          }
        }
        if (outputMint) {
          const isKnown = await this.db.isTokenKnown(outputMint);
          if (!isKnown) {
            firstMentionTokens.add(outputMint);
          }
        }
      }


      // 🚀 OPTIMIZATION: Pre-fetch all unique token data ONCE before user processing
      const uniqueTokens = new Set();
      for (const swap of swaps) {
        if (swap.inputToken?.mint) {
          uniqueTokens.add(swap.inputToken.mint);
        }
        if (swap.outputToken?.mint) {
          uniqueTokens.add(swap.outputToken.mint);
        }
      }

      // 🚀 SUPER OPTIMIZATION: Use Jupiter bulk API for maximum efficiency
      const tokenDataCache = new Map();

      try {
        // Step 1: Bulk fetch from Jupiter (up to 50 tokens at once!)
        const jupiterBulkData = await this.filterEngine.getJupiterBulkPriceData(Array.from(uniqueTokens));

        // Step 2: Individual calls for tokens not found in Jupiter + DexScreener for market cap
        const fetchPromises = Array.from(uniqueTokens).map(async (mint) => {
          try {
            // Find the symbol for this mint from any swap that contains it
            let symbol = 'Unknown';
            let token = null;
            for (const swap of swaps) {
              if (swap.inputToken?.mint === mint) {
                token = swap.inputToken;
                break;
              }
              if (swap.outputToken?.mint === mint) {
                token = swap.outputToken;
                break;
              }
            }

            // Get symbol with API fallback
            if (token) {
              symbol = await this.filterEngine.getTokenSymbol(token);
            }

            // Check if we have Jupiter data for this token
            const jupiterData = jupiterBulkData.get(mint);

            if (jupiterData && jupiterData.price > 0) {
              // We have Jupiter price, now get DexScreener for market cap or use hardcoded supply
              const dexData = await this.filterEngine.getDexScreenerData(mint);
              const knownSupply = await this.filterEngine.getTokenSupply(mint, symbol);

              const finalData = {
                price: jupiterData.price,
                marketCap: knownSupply ? (jupiterData.price * knownSupply) : (dexData.marketCap || 0),
                priceChange24h: jupiterData.priceChange24h,
                isHardcodedSupply: !!knownSupply,
                source: knownSupply ? 'Jupiter+Hardcoded' : 'Jupiter+DexScreener',
                symbol: dexData.symbol || symbol  // Store symbol in cache
              };

              tokenDataCache.set(mint, finalData);
            } else {
              // Fallback to individual getTokenData call (uses dual API internally)
              const tokenData = await this.filterEngine.getTokenData(mint, symbol);
              tokenDataCache.set(mint, tokenData);
            }

          } catch (error) {
            // On error, set default data to prevent crashes
            tokenDataCache.set(mint, {
              price: 0,
              marketCap: 0,
              priceChange24h: 0,
              isHardcodedSupply: false,
              source: 'Error',
              symbol: symbol || null  // Include symbol even on error
            });
          }
        });

        await Promise.all(fetchPromises);

        const jupiterCount = Array.from(tokenDataCache.values()).filter(d => d.source?.includes('Jupiter')).length;

      } catch (error) {
        console.error('❌ Bulk token data fetch failed:', error);
        // Fallback to original method if bulk fetch fails
        const fetchPromises = Array.from(uniqueTokens).map(async (mint) => {
          try {
            let symbol = 'Unknown';
            let token = null;
            for (const swap of swaps) {
              if (swap.inputToken?.mint === mint) {
                token = swap.inputToken;
                break;
              }
              if (swap.outputToken?.mint === mint) {
                token = swap.outputToken;
                break;
              }
            }

            // Get symbol with API fallback
            if (token) {
              symbol = await this.filterEngine.getTokenSymbol(token);
            }
            const tokenData = await this.filterEngine.getTokenData(mint, symbol);
            tokenDataCache.set(mint, tokenData);
          } catch (error) {
            tokenDataCache.set(mint, {
              price: 0,
              marketCap: 0,
              priceChange24h: 0,
              isHardcodedSupply: false,
              symbol: symbol || null  // Include symbol even on error
            });
          }
        });
        await Promise.all(fetchPromises);
      }

      // Process each swap against each user's filters
      for (const user of users) {
        try {
          const filters = await this.db.getUserFilters(user.telegram_id);
          const processedFilters = this.filterEngine.processFilters(filters);

          // Only log for users who have notifications enabled
          if (processedFilters.notifications_enabled) {
            let matchingSwaps = 0;
            let failedNotifications = 0;

            for (const swap of swaps) {
              const result = await this.filterEngine.shouldNotify(user.telegram_id, swap, filters, this.db, firstMentionTokens, tokenDataCache);


              if (result.matches) {
                matchingSwaps++;


                try {
                  // Calculate isFirstMention based on the global firstMentionTokens Set, not user-specific result
                  const inputMint = swap.inputToken?.mint;
                  const outputMint = swap.outputToken?.mint;
                  const globalIsFirstMention = (inputMint && firstMentionTokens.has(inputMint)) || (outputMint && firstMentionTokens.has(outputMint));

                  const notification = await this.filterEngine.formatNotification(swap, globalIsFirstMention, tokenDataCache);


                  await this.bot.api.sendMessage(user.telegram_id, notification, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                  });


                } catch (notifyError) {
                  failedNotifications++;
                }
              }
            }

            // Removed false positive logging - users might legitimately not match any swaps

          } else {
            // Regular processing for users with notifications off (no logging)
            let matchingSwaps = 0;
            for (const swap of swaps) {
              const result = await this.filterEngine.shouldNotify(user.telegram_id, swap, filters, this.db, firstMentionTokens, tokenDataCache);
              if (result.matches) {
                matchingSwaps++;

                // Calculate isFirstMention based on the global firstMentionTokens Set, not user-specific result
                const inputMint = swap.inputToken?.mint;
                const outputMint = swap.outputToken?.mint;
                const globalIsFirstMention = (inputMint && firstMentionTokens.has(inputMint)) || (outputMint && firstMentionTokens.has(outputMint));

                const notification = await this.filterEngine.formatNotification(swap, globalIsFirstMention, tokenDataCache);
                await this.bot.api.sendMessage(user.telegram_id, notification, {
                  parse_mode: 'Markdown',
                  disable_web_page_preview: true
                });
              }
            }
          }
        } catch (userError) {
        }
      }

      // After all users are processed, mark first mention tokens as seen WITH their symbols
      for (const tokenMint of firstMentionTokens) {
        // Get symbol from cache if available
        const cachedData = tokenDataCache.get(tokenMint);
        const tokenSymbol = cachedData?.symbol || null;
        await this.db.markTokenAsFirstMentioned(tokenMint, tokenSymbol);
      }

    } catch (error) {
      // Silent error handling for swap checking
    }
  }

  start() {
    this.bot.start();
  }

  stop() {
    this.bot.stop();
  }
}

// Create and start the bot
const whaleBot = new WhaleBot();

// Graceful shutdown
process.on('SIGINT', () => {
  whaleBot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  whaleBot.stop();
  process.exit(0);
});

// Start the bot
whaleBot.start();