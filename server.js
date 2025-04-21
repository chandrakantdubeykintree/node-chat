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

// Basic CORS setup - adjust allowed origins as needed
const io = new Server(server, {
  cors: {
    origin: config.allowedOrigin, // Allow React frontend
    methods: ["GET", "POST"],
  },
});

// Express middleware
app.use(cors({ origin: config.allowedOrigin })); // CORS for potential future HTTP routes on Node
app.use(express.json()); // If you add any standard Express routes

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
