const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class UserDatabase {
  constructor() {
    this.db = new sqlite3.Database(path.join(__dirname, 'users.db'));
    this.initDatabase();
  }

  initDatabase() {
    const createUsersTable = `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER UNIQUE NOT NULL,
        username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const createFiltersTable = `
      CREATE TABLE IF NOT EXISTS user_filters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        filter_type TEXT NOT NULL,
        filter_value TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_id) REFERENCES users (telegram_id)
      )
    `;

    this.db.serialize(() => {
      this.db.run(createUsersTable);
      this.db.run(createFiltersTable);
    });
  }

  // Add or update user
  addUser(telegramId, username) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT OR REPLACE INTO users (telegram_id, username) 
        VALUES (?, ?)
      `;
      this.db.run(query, [telegramId, username], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  // Get user filters - returns raw rows for filter engine to process
  getUserFilters(telegramId) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT filter_type, filter_value 
        FROM user_filters 
        WHERE telegram_id = ?
      `;
      this.db.all(query, [telegramId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows); // Return raw rows, let FilterEngine.processFilters() handle it
      });
    });
  }

  // Add filter
  addFilter(telegramId, filterType, filterValue) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO user_filters (telegram_id, filter_type, filter_value) 
        VALUES (?, ?, ?)
      `;
      this.db.run(query, [telegramId, filterType, filterValue], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  // Remove filter
  removeFilter(telegramId, filterType, filterValue) {
    return new Promise((resolve, reject) => {
      const query = `
        DELETE FROM user_filters 
        WHERE telegram_id = ? AND filter_type = ? AND filter_value = ?
      `;
      this.db.run(query, [telegramId, filterType, filterValue], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }

  // Clear all filters for user
  clearFilters(telegramId, filterType = null) {
    return new Promise((resolve, reject) => {
      let query = `DELETE FROM user_filters WHERE telegram_id = ?`;
      let params = [telegramId];
      
      if (filterType) {
        query += ` AND filter_type = ?`;
        params.push(filterType);
      }
      
      this.db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }

  // Get all users (for broadcasting)
  getAllUsers() {
    return new Promise((resolve, reject) => {
      const query = `SELECT telegram_id FROM users`;
      this.db.all(query, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows); // Return objects with telegram_id property
      });
    });
  }
}

module.exports = UserDatabase;