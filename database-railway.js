const { Pool } = require('pg');

class UserDatabase {
  constructor() {
    // Railway PostgreSQL connection - uses DATABASE_URL or individual variables
    const connectionString = process.env.DATABASE_URL ||
      `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.POSTGRES_DB}`;

    if (!connectionString || connectionString.includes('undefined')) {
      console.error('Railway PostgreSQL connection string not found in environment variables');
      console.error('Required: DATABASE_URL or PGUSER, PGPASSWORD, PGHOST, POSTGRES_DB');
      process.exit(1);
    }

    this.pool = new Pool({
      connectionString,
      ssl: {
        rejectUnauthorized: false
      }
    });
  }

  // Add or update user
  async addUser(telegramId, username) {
    try {
      const query = `
        INSERT INTO users (telegram_id, username)
        VALUES ($1, $2)
        ON CONFLICT (telegram_id)
        DO UPDATE SET username = EXCLUDED.username
        RETURNING id
      `;
      const result = await this.pool.query(query, [telegramId, username]);
      return result.rows[0]?.id;
    } catch (error) {
      throw error;
    }
  }

  // Get user filters - returns raw rows for filter engine to process
  async getUserFilters(telegramId) {
    try {
      const query = `
        SELECT filter_type, filter_value
        FROM user_filters
        WHERE telegram_id = $1
      `;
      const result = await this.pool.query(query, [telegramId]);
      return result.rows || [];
    } catch (error) {
      throw error;
    }
  }

  // Add filter
  async addFilter(telegramId, filterType, filterValue) {
    try {
      const query = `
        INSERT INTO user_filters (telegram_id, filter_type, filter_value)
        VALUES ($1, $2, $3)
        RETURNING id
      `;
      const result = await this.pool.query(query, [telegramId, filterType, filterValue]);
      return result.rows[0]?.id;
    } catch (error) {
      throw error;
    }
  }

  // Remove filter
  async removeFilter(telegramId, filterType, filterValue) {
    try {
      const query = `
        DELETE FROM user_filters
        WHERE telegram_id = $1 AND filter_type = $2 AND filter_value = $3
      `;
      const result = await this.pool.query(query, [telegramId, filterType, filterValue]);
      return result.rowCount;
    } catch (error) {
      throw error;
    }
  }

  // Clear all filters for user
  async clearFilters(telegramId, filterType = null) {
    try {
      let query = `DELETE FROM user_filters WHERE telegram_id = $1`;
      let params = [telegramId];

      if (filterType) {
        query += ` AND filter_type = $2`;
        params.push(filterType);
      }

      const result = await this.pool.query(query, params);
      return result.rowCount;
    } catch (error) {
      throw error;
    }
  }

  // Get all users (for broadcasting)
  async getAllUsers() {
    try {
      const query = `SELECT telegram_id FROM users`;
      const result = await this.pool.query(query);
      return result.rows || [];
    } catch (error) {
      throw error;
    }
  }

  // Check if token is first mention and add to unique_tokens if new
  async checkAndMarkFirstMention(tokenMint, tokenSymbol = null) {
    try {
      // Check if token already exists
      const checkQuery = `SELECT id FROM unique_tokens WHERE token_mint = $1`;
      const checkResult = await this.pool.query(checkQuery, [tokenMint]);

      // If token doesn't exist, it's a first mention
      if (checkResult.rows.length === 0) {
        try {
          // Add to unique_tokens table
          const insertQuery = `
            INSERT INTO unique_tokens (token_mint, token_symbol, first_seen_at)
            VALUES ($1, $2, NOW())
          `;
          await this.pool.query(insertQuery, [tokenMint, tokenSymbol]);
          return true; // It's a first mention
        } catch (insertError) {
          // If insert fails due to race condition (token was added by another process),
          // that's fine - just means it's no longer a first mention
          if (insertError.code === '23505') { // Unique constraint violation
            return false;
          }
          throw insertError;
        }
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
      const query = `SELECT id FROM unique_tokens WHERE token_mint = $1`;
      const result = await this.pool.query(query, [tokenMint]);
      return result.rows.length > 0; // Returns true if token exists in unique_tokens
    } catch (error) {
      console.error('Error checking if token is known:', error);
      return true; // On error, assume token is known to avoid false first mentions
    }
  }

  // Mark token as first mentioned (call this AFTER all users are processed)
  async markTokenAsFirstMentioned(tokenMint, tokenSymbol = null) {
    try {
      const query = `
        INSERT INTO unique_tokens (token_mint, token_symbol, first_seen_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (token_mint) DO NOTHING
      `;
      await this.pool.query(query, [tokenMint, tokenSymbol]);
      return true;
    } catch (error) {
      console.error('Error marking token as first mentioned:', error);
      return false;
    }
  }
}

module.exports = UserDatabase;