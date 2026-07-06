/**
 * @file hash.js
 * @description Hashing Utility Generator for Gym SaaS.
 * This standalone script is utilized to generate a secure bcrypt hash of a plaintext password.
 * 
 * Default verified bcrypt hash for plaintext 'password':
 * - Plaintext: "password"
 * - Bcrypt Salt Rounds: 10
 * - Generated Seed Hash: $2b$10$nOUIs5kJ7naTuTFkBy1veuK0kSxUFXfuaOKdOKf9xYT0KKIGSJwFa
 * 
 * This hash matches the seeded records for 'admin@saas.com' and 'owner@gym.com' in the database.
 */

const bcrypt = require('bcrypt');

// Generate and log the bcrypt hash of 'password' using 10 salt rounds
bcrypt.hash('password', 10).then(hash => {
  console.log('--------------------------------------------------');
  console.log('Your local, verified hash for the word "password":');
  console.log(hash); // Output: e.g., $2b$10$nOUIs5kJ7naTuTFkBy1veuK0kSxUFXfuaOKdOKf9xYT0KKIGSJwFa
  console.log('--------------------------------------------------');
});