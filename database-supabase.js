const { createClient } = require('@supabase/supabase-js');

class UserDatabase {
  constructor() {
    // Use environment variables for Supabase connection (try service key first, fallback to anon)
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('Supabase URL or Key not found in environment variables');
      process.exit(1);
    }

    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  // Add or update user
  async addUser(telegramId, username) {
    try {
      const { data, error } = await this.supabase
        .from('users')
        .upsert({
          telegram_id: telegramId,
          username: username
        })
        .select('id')
        .single();

      if (error) throw error;
      return data?.id;
    } catch (error) {
      throw error;
    }
  }

  // Get user filters - returns raw rows for filter engine to process
  async getUserFilters(telegramId) {
    try {
      const { data, error } = await this.supabase
        .from('user_filters')
        .select('filter_type, filter_value')
        .eq('telegram_id', telegramId);

      if (error) throw error;
      return data || [];
    } catch (error) {
      throw error;
    }
  }

  // Add filter
  async addFilter(telegramId, filterType, filterValue) {
    try {
      const { data, error } = await this.supabase
        .from('user_filters')
        .insert({
          telegram_id: telegramId,
          filter_type: filterType,
          filter_value: filterValue
        })
        .select('id')
        .single();

      if (error) throw error;
      return data?.id;
    } catch (error) {
      throw error;
    }
  }

  // Remove filter
  async removeFilter(telegramId, filterType, filterValue) {
    try {
      const { error, count } = await this.supabase
        .from('user_filters')
        .delete({ count: 'exact' })
        .eq('telegram_id', telegramId)
        .eq('filter_type', filterType)
        .eq('filter_value', filterValue);

      if (error) throw error;
      return count;
    } catch (error) {
      throw error;
    }
  }

  // Clear all filters for user
  async clearFilters(telegramId, filterType = null) {
    try {
      let query = this.supabase
        .from('user_filters')
        .delete({ count: 'exact' })
        .eq('telegram_id', telegramId);

      if (filterType) {
        query = query.eq('filter_type', filterType);
      }

      const { error, count } = await query;

      if (error) throw error;
      return count;
    } catch (error) {
      throw error;
    }
  }

  // Get all users (for broadcasting)
  async getAllUsers() {
    try {
      const { data, error } = await this.supabase
        .from('users')
        .select('telegram_id');

      if (error) throw error;
      return data || [];
    } catch (error) {
      throw error;
    }
  }

  // Check if token is first mention and add to unique_tokens if new
  async checkAndMarkFirstMention(tokenMint, tokenSymbol = null) {
    try {
      // Check if token already exists
      const { data: existingToken, error: checkError } = await this.supabase
        .from('unique_tokens')
        .select('id')
        .eq('token_mint', tokenMint)
        .single();

      if (checkError && checkError.code !== 'PGRST116') { // PGRST116 is "not found"
        throw checkError;
      }

      // If token doesn't exist, it's a first mention
      if (!existingToken) {
        // Add to unique_tokens table
        const { error: insertError } = await this.supabase
          .from('unique_tokens')
          .insert({
            token_mint: tokenMint,
            token_symbol: tokenSymbol,
            first_seen_at: new Date().toISOString()
          });

        if (insertError) {
          // If insert fails due to race condition (token was added by another process),
          // that's fine - just means it's no longer a first mention
          if (insertError.code === '23505') { // Unique constraint violation
            return false;
          }
          throw insertError;
        }

        return true; // It's a first mention
      }

      return false; // Token already exists, not a first mention
    } catch (error) {
      console.error('Error checking first mention:', error);
      return false; // On error, assume not first mention to avoid false positives
    }
  }

  // Check if token exists in unique_tokens (without marking it)
  async isTokenKnown(tokenMint) {
    try {
      const { data: existingToken, error } = await this.supabase
        .from('unique_tokens')
        .select('id')
        .eq('token_mint', tokenMint)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
        throw error;
      }

      return !!existingToken; // Returns true if token exists in unique_tokens
    } catch (error) {
      console.error('Error checking if token is known:', error);
      return true; // On error, assume token is known to avoid false first mentions
    }
  }

  // Mark token as first mentioned (call this AFTER all users are processed)
  async markTokenAsFirstMentioned(tokenMint, tokenSymbol = null) {
    try {
      const { error } = await this.supabase
        .from('unique_tokens')
        .insert({
          token_mint: tokenMint,
          token_symbol: tokenSymbol,
          first_seen_at: new Date().toISOString()
        });

      if (error && error.code !== '23505') { // 23505 is unique constraint violation (already exists)
        throw error;
      }

      return true;
    } catch (error) {
      console.error('Error marking token as first mentioned:', error);
      return false;
    }
  }
}

module.exports = UserDatabase;