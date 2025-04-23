// node-server/config/index.js
require("dotenv").config();

module.exports = {
  port: process.env.NODE_PORT,
  // port: 3000,
  phpBackendUrl: process.env.PHP_BACKEND_URL,
  allowedOrigin: process.env.ALLOWED_ORIGIN,
  phpApiKey: process.env.PHP_API_KEY,
};
