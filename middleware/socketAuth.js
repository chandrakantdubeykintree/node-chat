// node-server/middleware/socketAuth.js
const { validateToken } = require("../services/phpApiService");

const socketAuth = async (socket, next) => {
  const token = socket.handshake.auth.token; // Get token passed from client

  if (!token) {
    return next(new Error("Authentication error: No token provided."));
  }

  try {
    const userData = await validateToken(token);
    // Attach user data and token to the socket object for later use
    socket.userData = userData;
    socket.token = token;

    next(); // Proceed with connection

    socket.emit("authenticatedUserData", { user: userData }); // Use a specific event name
  } catch (error) {
    console.error(`Socket Auth Error: ${error.message}`);
    next(new Error(`Authentication error: ${error.message}`)); // Deny connection
  }
};

module.exports = socketAuth;
