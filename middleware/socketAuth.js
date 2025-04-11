// node-server/middleware/socketAuth.js
const { validateToken } = require("../services/phpApiService");

const socketAuth = async (socket, next) => {
  const token = socket.handshake.auth.token; // Get token passed from client

  if (!token) {
    console.error("Socket Auth Error: No token provided.");
    return next(new Error("Authentication error: No token provided."));
  }

  try {
    const userData = await validateToken(token);
    // Attach user data and token to the socket object for later use
    socket.userData = userData;
    socket.token = token;
    console.log(
      `User ${userData.id} (${userData.username}) connected with socket ${socket.id}`
    );
    next(); // Proceed with connection
  } catch (error) {
    console.error(`Socket Auth Error: ${error.message}`);
    next(new Error(`Authentication error: ${error.message}`)); // Deny connection
  }
};

module.exports = socketAuth;
