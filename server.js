// node-server/server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const config = require("./config");
const socketAuth = require("./middleware/socketAuth");
const { registerSocketHandlers } = require("./socket/handlers");

const app = express();
const server = http.createServer(app);
// Express middleware
app.use(
  cors({
    // origin: config.frontendUrl,
    origin: ["*", "http://localhost:3000", "https://kintree.info"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    exposedHeaders: ["Access-Control-Allow-Origin"],
  })
); // CORS for potential future HTTP routes on Node
app.use(express.json()); // If you add any standard Express routes

// Basic CORS setup - adjust allowed origins as needed
const io = new Server(server, {
  cors: {
    // origin: config.allowedOrigin, // Allow React frontend
    origin: ["*", "http://localhost:3000", "https://kintree.info"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    exposedHeaders: ["Access-Control-Allow-Origin"],
  },
  path: "/socket.io/",
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Health check endpoint (optional)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "Node server is running" });
});

// Socket.IO Middleware for Authentication
io.use(socketAuth);

// Handle Socket.IO Connections
io.on("connection", (socket) => {
  // Authentication was successful in middleware
  // socket.userData and socket.token are available here
  // Register all event handlers for this connected socket
  registerSocketHandlers(io, socket);
});

// Start the server
server.listen(config.port, () => {
  console.log(`Node.js intermediate server listening on port ${config.port}`);
  console.log(`Allowed Origin: ${config.allowedOrigin}`);
  console.log(`PHP Backend URL: ${config.phpBackendUrl}`);
});

// Graceful shutdown (optional but recommended)
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
    // Close Socket.IO connections if needed
    io.close(() => {
      console.log("Socket.IO closed");
      process.exit(0);
    });
  });
});
