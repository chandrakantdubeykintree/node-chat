// node-server/socket/handlers.js
const {
  makePhpRequest,
  phpApiClient,
  updatePhpOnlineStatus,
} = require("../services/phpApiService");
const FormData = require("form-data"); // If sending FormData from Node

const config = require("../config");

const SOCKET_EVENTS = {
  // Or define directly if not using separate file
  START_TYPING: "startTyping",
  STOP_TYPING: "stopTyping",
  USER_TYPING: "userTyping",
  USER_STOPPED_TYPING: "userStoppedTyping",
  // ... other events

  MESSAGE_DELIVERED_ACK: "messageDeliveredAck",
  MARK_MESSAGE_READ: "markMessageRead",
  MARK_CHANNEL_READ: "markChannelRead",
  MARK_CHANNEL_DELIVERED: "markChannelDelivered",
  MESSAGE_STATUS_UPDATE: "messageStatusUpdate",
  CHANNEL_READ_UPDATE: "channelReadUpdate",
  CHANNEL_BULK_DELIVERED_UPDATE: "channelBulkDeliveredUpdate",
  CHANNEL_BULK_READ_UPDATE: "channelBulkReadUpdate",
};

const safeStringify = (key, value) => {
  if (value instanceof Set) {
    // Convert Sets to Arrays for JSON serialization
    return Array.from(value);
  }
  // Add more handlers if needed (e.g., for Maps, specific object types)
  // Handle circular references if they become an issue (more complex)
  return value;
};

// Store connected users { userId: socketId } - simplistic, refine for multiple connections per user if needed
const connectedUsers = new Map();
// --- Export IO instance ---
let ioRef = null;
const getIoInstance = () => ioRef;

const registerSocketHandlers = (io, socket) => {
  ioRef = io; // Store io instance
  const userId = socket.userData.id;
  const userToken = socket.token; // Use token associated with this specific socket

  const userName =
    socket.userData.profile?.first_name || socket.userData.username; // Get user's name

  // --- Handle User Connection ---
  if (!connectedUsers.has(userId)) {
    connectedUsers.set(userId, new Set());
  }
  const userSockets = connectedUsers.get(userId);
  const isFirstConnection = userSockets.size === 0;
  userSockets.add(socket.id);

  if (isFirstConnection) {
    updatePhpOnlineStatus(userToken, true)
      .then((phpResponse) => {
        // Check if the user is still connected when the response comes back
        if (connectedUsers.has(userId)) {
          io.emit("userOnline", { userId });
        } else {
          console.log(
            `User ${userId} disconnected before PHP online update finished.`
          );
        }
      })
      .catch((error) => {
        console.error(
          `Failed to update PHP status to online for ${userId}: ${error.message}`
        );
        // Optionally still broadcast userOnline optimistically? Or handle error?
        // For now, let's still broadcast so clients *might* see the status change
        if (connectedUsers.has(userId)) {
          // Check again before optimistic broadcast
          io.emit("userOnline", { userId });
        }
      });
  }

  const safeCallback = (callback, ...args) => {
    if (typeof callback === "function") {
      try {
        // Use JSON.stringify with the replacer for logging complex args if needed
        // console.log(`${baseLogPrefix} Executing callback with args:`, JSON.stringify(args, safeStringify));
        callback(...args);
      } catch (e) {
        console.error(
          `${baseLogPrefix} !!! EXCEPTION during callback execution:`,
          e
        );
        // Avoid crashing Node if the client-provided callback fails
      }
    } else {
      // Log if a callback was expected but not provided or not a function
      if (callback !== undefined) {
        // Only log if something was passed but wasn't a function
        console.warn(
          `${baseLogPrefix} Received event but callback was not a function (type: ${typeof callback}).`
        );
      }
    }
  };

  // --- Channel Handling ---

  socket.on("getChannels", async (callback) => {
    const socketId = socket.id; // Capture socket ID for logging
    try {
      const response = await makePhpRequest("get", "/user/channels", userToken);
      if (response?.success) {
        const channelsData = response.data || [];
        // Join rooms etc.
        channelsData.forEach((channel) => {
          if (channel?.id) socket.join(`channel_${channel.id}`);
        });
        callback({ success: true, channels: channelsData });
        // *** REMOVE the userOnline emit from here ***
      } else {
        callback({ success: false, error: response?.message || "Failed" });
      }
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // --- Message Handling ---

  socket.on(
    "getMessages",
    async ({ channelId, page = 1, limit = 20 }, callback) => {
      if (!userToken) {
        console.error(`getMessages Error: Token missing for user ${userId}`);
        return callback({
          success: false,
          error: "Authentication token missing on server.",
        });
      }
      if (!channelId) {
        console.error(`getMessages Error: Channel ID missing.`);
        return callback({ success: false, error: "Channel ID is required." });
      }

      const phpPath = `/user/channels/${channelId}/messages?page=${page}&limit=${limit}`;

      try {
        // Make the request using the authenticated user's token
        const response = await makePhpRequest("get", phpPath, userToken);

        // Specifically log timestamps for a sample message if available
        if (response?.data?.messages && response.data.messages.length > 0) {
          const sampleMsg = response.data.messages[0];
        }
        // --- END RAW RESPONSE LOG ---

        if (response.success && response.data) {
          // Relay the exact data received from PHP
          callback({ success: true, messagesData: response.data });
        } else {
          console.error(
            `getMessages Error: PHP returned failure or no data - ${
              response?.message || "Unknown PHP Error"
            }`
          );
          callback({
            success: false,
            error: response?.message || "Failed to fetch messages from PHP",
          });
        }
      } catch (error) {
        console.error(
          `getMessages PHP API Error Status:`,
          error.response?.status
        );
        console.error(
          `getMessages PHP API Error Response Body:`,
          error.response?.data
        );
        console.error(`getMessages PHP API Full Error:`, error.message);
        callback({
          success: false,
          error:
            error.response?.data?.message ||
            error.message ||
            "Failed to fetch messages",
        });
      }
    }
  );

  socket.on(
    "sendMessage",
    async ({ channelId, message, attachment_id }, callback) => {
      try {
        // Use FormData because PHP expects it
        const formData = new FormData();
        formData.append("message", message);
        if (attachment_id) {
          formData.append("attachment_id", attachment_id);
        }

        // Need to use the raw axios client for FormData and pass headers
        const response = await phpApiClient.post(
          `/user/channels/${channelId}/messages`,
          formData,
          {
            headers: {
              ...formData.getHeaders(), // Important for boundary
              Authorization: `Bearer ${userToken}`,
            },
          }
        );

        if (response.data && response.data.success) {
          const newMessage = response.data.data; // Assuming PHP returns the created message
          // Broadcast the new message to everyone in the channel room
          io.to(`channel_${channelId}`).emit("newMessage", {
            channelId,
            message: newMessage,
          });
          callback({ success: true, message: newMessage }); // Confirm to sender
        } else {
          callback({
            success: false,
            error: response.data?.message || "Failed to send message",
          });
        }
      } catch (error) {
        console.error(
          `Error sending message for user ${userId} to channel ${channelId}:`,
          error.response?.data || error.message
        );
        callback({
          success: false,
          error: error.response?.data?.message || error.message,
        });
      }
    }
  );

  socket.on(
    "editMessage",
    async ({ channelId, messageId, message }, callback) => {
      try {
        const formData = new FormData();
        formData.append("message", message);
        formData.append("_method", "PUT"); // Method override for PHP

        const response = await phpApiClient.post(
          `/user/channels/${channelId}/messages/${messageId}`,
          formData,
          {
            headers: {
              ...formData.getHeaders(),
              Authorization: `Bearer ${userToken}`,
            },
          }
        );

        if (response.data && response.data.success) {
          const updatedMessage = response.data.data; // Assuming PHP returns the updated message
          io.to(`channel_${channelId}`).emit("messageUpdated", {
            channelId,
            message: updatedMessage,
          });
          callback({ success: true, message: updatedMessage });
        } else {
          callback({
            success: false,
            error: response.data?.message || "Failed to edit message",
          });
        }
      } catch (error) {
        console.error(
          `Error editing message ${messageId}:`,
          error.response?.data || error.message
        );
        callback({
          success: false,
          error: error.response?.data?.message || error.message,
        });
      }
    }
  );

  socket.on("deleteMessage", async ({ channelId, messageId }, callback) => {
    try {
      const response = await makePhpRequest(
        "delete",
        `/user/channels/${channelId}/messages/${messageId}`,
        userToken
      );
      if (response.success) {
        io.to(`channel_${channelId}`).emit("messageDeleted", {
          channelId,
          messageId,
        });
        callback({ success: true });
      } else {
        callback({
          success: false,
          error: response.message || "Failed to delete message",
        });
      }
    } catch (error) {
      console.error(`Error deleting message ${messageId}:`, error.message);
      callback({ success: false, error: error.message });
    }
  });

  // socket.on("markMessageRead", async ({ channelId, messageId }, callback) => {
  //   try {
  //     // PHP expects PUT, but makePhpRequest can handle it or use axios directly
  //     const response = await makePhpRequest(
  //       "put",
  //       `/user/channels/${channelId}/messages/${messageId}/mark-as-read`,
  //       userToken
  //     );
  //     if (response.success) {
  //       // Notify relevant users (subtle: who needs this update? Potentially only the sender)
  //       // For simplicity broadcast for now, can be optimized
  //       io.to(`channel_${channelId}`).emit("messageStatusUpdate", {
  //         channelId,
  //         messageId,
  //         status: "read",
  //         read_at: new Date().toISOString() /* or get from PHP response */,
  //       });
  //       callback({ success: true });
  //     } else {
  //       callback({
  //         success: false,
  //         error: response.message || "Failed to mark as read",
  //       });
  //     }
  //   } catch (error) {
  //     console.error(
  //       `Error marking message ${messageId} as read:`,
  //       error.message
  //     );
  //     callback({ success: false, error: error.message });
  //   }
  // });

  // socket.on("markChannelRead", async ({ channelId }, callback) => {
  //   if (!channelId)
  //     return callback({ success: false, error: "Channel ID required" });

  //   try {
  //     // Call the PHP endpoint: PUT /user/channels/:channelId/mark-as-read
  //     const response = await makePhpRequest(
  //       "put",
  //       `/user/channels/${channelId}/mark-as-read`,
  //       userToken
  //     );

  //     if (response.success) {
  //       // Notify the user's other sessions/devices (and potentially others in group?)
  //       // Emit to the specific user's room if implemented, or just broadcast to channel for simplicity
  //       io.to(`channel_${channelId}`).emit("channelMessagesRead", {
  //         channelId,
  //       });
  //       callback({ success: true });
  //     } else {
  //       callback({
  //         success: false,
  //         error: response.message || "PHP request failed",
  //       });
  //     }
  //   } catch (error) {
  //     console.error(
  //       `Error marking channel ${channelId} read for user ${userId}:`,
  //       error.message
  //     );
  //     callback({ success: false, error: error.message });
  //   }
  // });

  // --- Clear Chat Handler ---
  socket.on("clearChannelChat", async ({ channelId }, callback) => {
    if (!channelId)
      return callback({ success: false, error: "Channel ID required" });

    try {
      // Call PHP: PUT /user/channels/:channelId/clear-chat
      // Note: PHP expects message_ids: [], which means delete all *for the user*
      const response = await makePhpRequest(
        "put",
        `/user/channels/${channelId}/clear-chat`,
        userToken,
        { message_ids: [] }
      ); // Sending empty array

      if (response.success) {
        // Notify ONLY the user who cleared it across their devices/sockets
        // Requires user-specific rooms or tracking multiple socket IDs per user
        // Simplification: Emit back to the specific socket connection for now.
        // A better approach involves user rooms: io.to(`user_${userId}`).emit(...)
        socket.emit("chatCleared", { channelId });
        callback({ success: true });
        // TODO: Maybe fetch and push the *new* latest message for the channel preview update?
      } else {
        callback({
          success: false,
          error: response.message || "PHP request failed",
        });
      }
    } catch (error) {
      console.error(
        `Error clearing chat ${channelId} for user ${userId}:`,
        error.message
      );
      callback({ success: false, error: error.message });
    }
  });

  // --- Delete Channel Handler ---
  socket.on("deleteChannel", async ({ channelId }, callback) => {
    if (!channelId)
      return callback({ success: false, error: "Channel ID required" });

    try {
      // Call PHP: DELETE /user/channels/:channelId
      const response = await makePhpRequest(
        "delete",
        `/user/channels/${channelId}`,
        userToken
      );

      console.log(response, "response");

      if (response.success) {
        // Notify everyone who was part of that channel
        io.to(`channel_${channelId}`).emit("channelDeleted", { channelId });
        // Force clients out of the Socket.IO room
        io.socketsLeave(`channel_${channelId}`);
        callback({ success: true });
      } else {
        callback({
          success: false,
          error: response.message || "PHP request failed",
        });
      }
    } catch (error) {
      console.error(
        `Error deleting channel ${channelId} by user ${userId}:`,
        error.message
      );
      callback({ success: false, error: error.message });
    }
  });

  socket.on(
    "createChannel",
    async (
      { userIds, is_group, name = null, description = null, attachment_id },
      callback
    ) => {
      const userId = socket.userData.id;
      const userToken = socket.token;

      if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        return callback({
          success: false,
          error: "Valid user IDs array required",
        });
      }
      // For 1-on-1 chat creation triggered from member list, ensure only one other ID is passed
      if (is_group === 0 && userIds.length !== 1) {
        return callback({
          success: false,
          error: "Exactly one user ID required for 1-on-1 chat creation.",
        });
      }

      try {
        // PHP expects FormData for channel creation based on your initial spec
        const formData = new FormData();
        formData.append("is_group", is_group); // 0 for 1-on-1, 1 for group
        // Add the current user ID implicitly on the backend or pass it if needed
        // formData.append('creator_id', userId); // If PHP needs it explicitly

        // PHP expects user_ids[] format in FormData
        userIds.forEach((id) => formData.append("user_ids[]", id));

        if (is_group === 1 && name) {
          // Required for groups
          formData.append("name", name);
        }
        if (description) {
          formData.append("description", description);
        }
        // Handle attachment_id if needed for group creation (requires file upload logic first)
        if (attachment_id) {
          formData.append("attachment_id", attachment_id);
        }

        const phpUrl = "/user/channels";

        // Use the raw axios client for FormData
        const response = await phpApiClient.post(phpUrl, formData, {
          headers: {
            ...formData.getHeaders(), // Get boundary header from FormData
            Authorization: `Bearer ${userToken}`,
            "x-api-key": config.phpApiKey, // Ensure API key is included if added to client defaults
          },
        });

        // PHP might return success even if channel exists, giving back the existing channel data
        if (response.data && response.data.success) {
          const channelData = response.data.data; // Assuming PHP returns the channel data

          // Make the creating user join the Socket.IO room for the new channel
          socket.join(`channel_${channelData.id}`);

          // Notify the *other* participants (if they are online) that a new channel was created
          userIds.forEach((otherUserId) => {
            // Find socket ID(s) for otherUserId (requires tracking connectedUsers: Map<userId, socketId>)
            // This simple map assumes one socket per user
            const otherSocketId = connectedUsers.get(otherUserId); // 'connectedUsers' map from previous steps
            if (otherSocketId) {
              io.to(otherSocketId).emit("newChannelCreated", { channelData });
              // Also make the other user's socket join the room server-side
              const otherSocket = io.sockets.sockets.get(otherSocketId);
              if (otherSocket) {
                otherSocket.join(`channel_${channelData.id}`);
              }
            }
          });

          // Send the channel data back to the creator
          callback({ success: true, channel: channelData });
        } else {
          console.error(
            `createChannel Error: PHP returned failure - ${
              response.data?.message || "No message"
            }`
          );
          callback({
            success: false,
            error: response.data?.message || "Failed to create channel via PHP",
          });
        }
      } catch (error) {
        console.error(
          `createChannel PHP API Error Status:`,
          error.response?.status
        );
        console.error(
          `createChannel PHP API Error Response Body:`,
          error.response?.data
        );
        console.error(`createChannel PHP API Full Error:`, error.message);
        callback({
          success: false,
          error:
            error.response?.data?.message ||
            error.message ||
            "Failed to create channel",
        });
      }
    }
  );

  // --- Typing Indicator Handlers ---

  socket.on(SOCKET_EVENTS.START_TYPING, ({ channelId }) => {
    if (!channelId) return;
    socket.to(`channel_${channelId}`).emit(SOCKET_EVENTS.USER_TYPING, {
      channelId,
      userId,
      userName, // Send name for display
    });
  });

  socket.on(SOCKET_EVENTS.STOP_TYPING, ({ channelId }) => {
    if (!channelId) return;
    socket.to(`channel_${channelId}`).emit(SOCKET_EVENTS.USER_STOPPED_TYPING, {
      channelId,
      userId,
    });
  });

  socket.on(
    SOCKET_EVENTS.MESSAGE_DELIVERED_ACK,
    async ({ channelId, messageId }) => {
      if (!channelId || !messageId) return;
      const recipientUserId = socket.userData.id;
      const recipientToken = socket.token;

      if (!recipientToken) {
        /* handle error */ return;
      }
      try {
        const phpPath = `/user/channels/${channelId}/messages/${messageId}/mark-delivered-at`;
        const response = await makePhpRequest("put", phpPath, recipientToken);

        if (response.success) {
          const deliveredAt = new Date().toISOString(); // <<< USE NODE'S TIME

          io.to(`channel_${channelId}`).emit(
            SOCKET_EVENTS.MESSAGE_STATUS_UPDATE,
            {
              channelId,
              updates: [{ messageId, delivered_at: deliveredAt }], // Broadcast standard update
            }
          );
        } else {
          console.warn(
            `[Socket ${socket.id}] PHP failed marking msg ${messageId} delivered: ${response.message}`
          );
        }
      } catch (error) {
        /* handle error */
      }
    }
  );

  // --- Single Message Read ACK Handler (Future Use) ---
  socket.on(
    SOCKET_EVENTS.MARK_MESSAGE_READ,
    async ({ channelId, messageId }) => {
      if (!channelId || !messageId) return;
      const readerUserId = socket.userData.id;
      const readerToken = socket.token;

      if (!readerToken) {
        return;
      }
      try {
        const phpPath = `/user/channels/${channelId}/messages/${messageId}/mark-as-read`;
        const response = await makePhpRequest("put", phpPath, readerToken);

        if (response.success) {
          const readAt = new Date().toISOString();
          io.to(`channel_${channelId}`).emit(
            SOCKET_EVENTS.MESSAGE_STATUS_UPDATE,
            {
              channelId,
              updates: [{ messageId, read_at: readAt }], // Broadcast standard update
            }
          );
        } else {
          console.warn(
            `[Socket ${socket.id}] PHP failed marking msg ${messageId} read: ${response.message}`
          );
        }
      } catch (error) {
        /* handle error */
      }
    }
  );

  // --- Mark Channel Delivered Handler (Bulk on Open) ---
  socket.on(
    SOCKET_EVENTS.MARK_CHANNEL_DELIVERED,
    async ({ channelId }, callback) => {
      // Use a specific log prefix for this handler instance
      const socketId = socket.id;
      const logPrefix = `[Socket ${socketId}][${SOCKET_EVENTS.MARK_CHANNEL_DELIVERED}][Chan ${channelId}]`;

      // --- Argument Validation ---
      if (typeof callback !== "function") {
        console.error(
          `${logPrefix} CRITICAL ERROR: Callback is not a function!`
        );
        return;
      }
      if (!channelId) {
        console.warn(`${logPrefix} Missing channelId. Sending error callback.`);
        return callback({ success: false, error: "Channel ID required" });
      }
      if (!userToken) {
        console.error(
          `${logPrefix} Missing userToken. Sending error callback.`
        );
        return callback({ success: false, error: "Auth token missing." });
      }
      // --- End Argument Validation ---

      const recipientUserId = userId;
      const recipientToken = userToken;

      // ***** Wrap EVERYTHING in a top-level try...catch *****
      try {
        const phpPath = `/user/channels/${channelId}/mark-delivered-at`;

        // Make PHP request within its own try...catch
        let phpResponse;
        try {
          phpResponse = await makePhpRequest("put", phpPath, recipientToken);
        } catch (phpError) {
          console.error(
            `${logPrefix} !!! EXCEPTION during PHP call: ${phpError.message}`
          );
          console.error(`${logPrefix} PHP Error Stack:`, phpError.stack); // Log stack trace
          // Send error callback immediately if PHP call itself failed
          return callback({
            success: false,
            error: `Failed to contact server: ${phpError.message}`,
          });
        }

        if (phpResponse?.success) {
          const deliveredAt = new Date().toISOString();
          const actorUserId = recipientUserId;

          // --- Broadcast Attempt ---
          const broadcastData = {
            channelId,
            delivered_at: deliveredAt,
            actorUserId: actorUserId,
          };
          try {
            const jsonBroadcastData = JSON.stringify(
              broadcastData,
              safeStringify
            );

            io.to(`channel_${channelId}`).emit(
              SOCKET_EVENTS.CHANNEL_BULK_DELIVERED_UPDATE,
              broadcastData
            );
          } catch (broadcastError) {
            console.error(
              `${logPrefix} !!! EXCEPTION during broadcast emit/stringify: ${broadcastError.message}`
            );
            console.error(
              `${logPrefix} Broadcast Error Stack:`,
              broadcastError.stack
            );
            // Continue to callback even if broadcast fails, but log it
          }
          // --- End Broadcast Attempt ---

          // --- Callback Attempt ---
          const callbackData = { success: true };
          try {
            callback(callbackData); // Send success back
          } catch (callbackError) {
            console.error(
              `${logPrefix} !!! EXCEPTION during success callback execution/stringify: ${callbackError.message}`
            );
            console.error(
              `${logPrefix} Callback Error Stack:`,
              callbackError.stack
            );
          }
          // --- End Callback Attempt ---
        } else {
          const errorMsg =
            phpResponse?.message || "PHP request indicated failure";
          console.warn(
            `${logPrefix} PHP failed marking channel delivered: ${errorMsg}`
          );
          // --- Error Callback Attempt ---
          const errorCallbackData = { success: false, error: errorMsg };
          try {
            callback(errorCallbackData);
          } catch (callbackError) {
            console.error(
              `${logPrefix} !!! EXCEPTION during error callback execution/stringify: ${callbackError.message}`
            );
            console.error(
              `${logPrefix} Callback Error Stack:`,
              callbackError.stack
            );
          }
          // --- End Error Callback Attempt ---
        }
        // Catch exceptions from the outer logic (outside PHP call/broadcast/callback)
      } catch (handlerError) {
        console.error(
          `${logPrefix} !!! TOP LEVEL EXCEPTION in handler: ${handlerError.message}`
        );
        console.error(`${logPrefix} Handler Error Stack:`, handlerError.stack);
        // Try sending a generic error callback if possible
        try {
          callback({
            success: false,
            error: "Internal server error processing request.",
          });
        } catch (e) {
          console.error(
            `${logPrefix} Failed even to send generic error callback.`
          );
        }
      } finally {
        console.log(`${logPrefix} --- Handler End ---`);
      }
    }
  );

  // --- Mark Channel Read Handler (Bulk on Open) ---
  socket.on(
    SOCKET_EVENTS.MARK_CHANNEL_READ,
    async ({ channelId }, callback) => {
      if (!channelId)
        return callback({ success: false, error: "Channel ID required" });
      const readerUserId = socket.userData.id;
      const readerToken = socket.token;

      if (!readerToken) {
        /* handle error */ return callback({
          success: false,
          error: "Auth token missing.",
        });
      }
      try {
        const phpPath = `/user/channels/${channelId}/mark-as-read`; // Assumes bulk endpoint exists
        const response = await makePhpRequest("put", phpPath, readerToken);

        if (response.success) {
          const readAt = new Date().toISOString(); // <<< USE NODE'S TIME

          // 1. Notify client about general read status (for unread count)
          io.to(`channel_${channelId}`).emit(
            SOCKET_EVENTS.CHANNEL_READ_UPDATE,
            {
              channelId,
              readerUserId: readerUserId,
              readAt: readAt, // Still useful to send timestamp here
            }
          );

          // 2. *** Broadcast BULK event ***
          io.to(`channel_${channelId}`).emit(
            SOCKET_EVENTS.CHANNEL_BULK_READ_UPDATE,
            {
              channelId,
              read_at: readAt,
              actorUserId: readerUserId, // ID of the user whose action triggered this
            }
          );
          callback({ success: true });
        } else {
          console.warn(
            `[Socket ${socket.id}] PHP failed marking channel ${channelId} read: ${response.message}`
          );
          callback({
            success: false,
            error: response.message || "PHP request failed",
          });
        }
      } catch (error) {
        /* handle error */ callback({ success: false, error: error.message });
      }
    }
  );

  socket.on("leaveGroup", async ({ channelId }, callback) => {
    const socketId = socket.id;
    const logPrefix = `[Socket ${socketId}][leaveGroup][Chan ${channelId}]`;

    if (typeof callback !== "function")
      return console.error(`${logPrefix} Callback is not a function!`);
    if (!channelId)
      return callback({ success: false, error: "Channel ID required" });
    if (!userToken)
      return callback({ success: false, error: "Auth token missing." });

    try {
      // Call PHP endpoint: /user/channels/:channelId/left-chat
      // Method might be DELETE or PUT depending on your PHP API design
      // Let's assume DELETE for leaving/removing association
      const phpPath = `/user/channels/${channelId}/left-chat`;

      let phpResponse;
      try {
        // Assuming DELETE method for leaving
        phpResponse = await makePhpRequest("put", phpPath, userToken);
      } catch (phpError) {
        console.error(
          `${logPrefix} !!! EXCEPTION during PHP call: ${phpError.message}`
        );
        return callback({
          success: false,
          error: `Failed to contact server: ${phpError.message}`,
        });
      }

      if (phpResponse?.success) {
        // 1. Force the leaving user's socket out of the room
        socket.leave(`channel_${channelId}`);

        // 2. Notify remaining members in the room
        const leaveUpdateData = {
          channelId,
          userId: userId, // ID of the user who left
          userName: userName, // Name of the user who left
          message: `${userName} left the group.`, // Optional system message idea
          // You might receive updated channel data from PHP (e.g., new participant count)
          // updatedChannelData: phpResponse.data // If PHP returns it
        };
        // Emit an event specifically for user leaving
        socket
          .to(`channel_${channelId}`)
          .emit("userLeftGroup", leaveUpdateData);
        // OR emit a generic channel update if PHP returns full updated channel data
        // if (leaveUpdateData.updatedChannelData) {
        //    io.to(`channel_${channelId}`).emit("channelUpdated", { channelData: leaveUpdateData.updatedChannelData });
        // }

        // 3. Send success callback to the leaving user
        callback({ success: true });

        // 4. Tell the leaving user's client to remove the channel (alternative to relying on leave room)
        // This ensures removal even if other events are missed.
        socket.emit("channelDeleted", { channelId });
      } else {
        const errorMsg =
          phpResponse?.message || "PHP request indicated failure";
        console.warn(`${logPrefix} PHP failed leaving group: ${errorMsg}`);
        callback({ success: false, error: errorMsg });
      }
    } catch (handlerError) {
      console.error(
        `${logPrefix} !!! TOP LEVEL EXCEPTION in handler: ${handlerError.message}`
      );
      try {
        callback({ success: false, error: "Internal server error." });
      } catch (e) {
        /* ignore */
      }
    }
  });

  socket.on(
    "updateChannelInfo",
    async ({ channelId, name, description, attachment_id }, callback) => {
      const socketId = socket.id;
      const logPrefix = `[Socket ${socketId}][updateChannelInfo][Chan ${channelId}]`;

      if (typeof callback !== "function")
        return console.error(`${logPrefix} Callback is not a function!`);
      if (!channelId)
        return callback({ success: false, error: "Channel ID required" });
      if (!userToken)
        return callback({ success: false, error: "Auth token missing." });
      // Basic validation: At least one field must be intended for update, though PHP will handle specifics.
      if (
        name === undefined &&
        description === undefined &&
        attachment_id === undefined
      ) {
        return callback({ success: false, error: "No update data provided." });
      }

      try {
        // PHP endpoint: PUT /user/channels/:channelId
        // We need to send FormData because attachment_id might be involved,
        // and PHP likely expects form data for PUT/POST with potential file IDs.
        const formData = new FormData();
        formData.append("_method", "PUT"); // Method override for PHP frameworks

        // Append fields *only if they are provided* in the request
        // Check for `null` explicitly if you want to allow clearing fields.
        // Check for `undefined` to only send fields the client intended to update.
        if (name !== undefined) {
          formData.append("name", name || ""); // Send empty string if null/undefined to potentially clear
        }
        if (description !== undefined) {
          // Send empty string or a special value if PHP expects it to clear the description
          formData.append("description", description || "");
        }
        if (attachment_id !== undefined) {
          // Send the ID, or potentially '0' or an empty string if PHP expects that to clear the image
          formData.append(
            "attachment_id",
            attachment_id ? attachment_id.toString() : ""
          );
        }

        const phpPath = `/user/channels/${channelId}`;

        // Use raw axios client for FormData
        const response = await phpApiClient.post(phpPath, formData, {
          // POST with _method=PUT
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${userToken}`,
            "x-api-key": config.phpApiKey || "",
          },
        });

        if (response.data && response.data.success) {
          const updatedChannelData = response.data.data; // Assuming PHP returns the full updated channel

          // Broadcast the update to all members of the channel room
          io.to(`channel_${channelId}`).emit("channelUpdated", {
            channelId: channelId,
            channelData: updatedChannelData,
          });

          callback({ success: true, channel: updatedChannelData }); // Confirm success to the sender
        } else {
          console.warn(
            `${logPrefix} PHP update failed: ${response.data?.message}`
          );
          callback({
            success: false,
            error: response.data?.message || "Failed to update group info",
          });
        }
      } catch (error) {
        console.error(
          `${logPrefix} !!! EXCEPTION during PHP call: ${error.message}`
        );
        console.error(`${logPrefix} PHP Error Status:`, error.response?.status);
        console.error(`${logPrefix} PHP Error Response:`, error.response?.data);
        callback({
          success: false,
          error: error.response?.data?.message || "Failed to update group info",
        });
      }
    }
  );

  socket.on(
    "addMembersToGroup",
    async ({ channelId, userIdsToAdd }, callback) => {
      const socketId = socket.id;
      const logPrefix = `[Socket ${socketId}][addMembers][Chan ${channelId}]`;
      const cb = (...args) => safeCallback(callback, ...args); // Use safe callback wrapper
      if (!channelId)
        return cb({ success: false, error: "Channel ID required." });
      if (!Array.isArray(userIdsToAdd) || userIdsToAdd.length === 0)
        return cb({ success: false, error: "User IDs required." });

      try {
        const phpPath = `/user/channels/${channelId}/add-users`;
        const payload = { user_ids: userIdsToAdd };
        const phpAddResponse = await makePhpRequest(
          "post",
          phpPath,
          userToken,
          payload,
          { "Content-Type": "application/json" }
        );

        if (phpAddResponse?.success) {
          // --- Fetch latest channel data AFTER adding ---
          let updatedChannelData;
          try {
            const phpGetResponse = await makePhpRequest(
              "get",
              `/user/channels/${channelId}`,
              userToken
            );
            if (phpGetResponse?.success && phpGetResponse?.data) {
              updatedChannelData = phpGetResponse.data;
            } else {
              throw new Error(
                "Failed to fetch updated channel data after adding members."
              );
            }
          } catch (fetchError) {
            console.error(
              `${logPrefix} addMembers EXCEPTION fetching updated data (Chan ${channelId}):`,
              fetchError.message
            );
            // Proceed without broadcasting updated data? Or return error? Let's return error for consistency.
            return cb({
              success: false,
              error: "Members added, but failed to refresh channel data.",
            });
          }
          // --- End Fetch ---

          if (!updatedChannelData || !updatedChannelData.id)
            throw new Error("Invalid updated channel data fetched.");

          const newMemberIds = new Set(userIdsToAdd);

          // Notify and join new ONLINE members
          updatedChannelData.users?.forEach((user) => {
            if (newMemberIds.has(user.id)) {
              const userSocketsSet = connectedUsers.get(user.id);
              if (userSocketsSet?.size > 0) {
                userSocketsSet.forEach((targetSocketId) => {
                  const targetSocket = io.sockets.sockets.get(targetSocketId);
                  if (targetSocket) {
                    targetSocket.join(`channel_${channelId}`);
                    targetSocket.emit("channelUpdated", {
                      channelId,
                      channelData: updatedChannelData,
                    });
                  }
                });
              }
            }
          });

          // Broadcast the FULL update to ALL members in the room
          io.to(`channel_${channelId}`).emit("channelUpdated", {
            channelId,
            channelData: updatedChannelData,
          });

          // Send success callback to the requester (with updated data is fine here if needed by AddParticipantsView)
          cb({ success: true, channel: updatedChannelData });
        } else {
          console.warn(
            `${logPrefix} addMembers PHP Error (Chan ${channelId}): ${phpAddResponse?.message}`
          );
          cb({
            success: false,
            error: phpAddResponse?.message || "Failed to add members.",
          });
        }
      } catch (error) {
        console.error(
          `${logPrefix} addMembers EXCEPTION (Chan ${channelId}):`,
          error.response?.data || error.message
        );
        cb({
          success: false,
          error:
            error.response?.data?.message ||
            error.message ||
            "Could not add members.",
        });
      }
    }
  );

  socket.on(
    "removeMembersFromGroup",
    async ({ channelId, userIdsToRemove }, callback) => {
      const socketId = socket.id;
      const logPrefix = `[Socket ${socketId}][removeMembers][Chan ${channelId}]`;
      const cb = (...args) => safeCallback(callback, ...args);
      if (!channelId)
        return cb({ success: false, error: "Channel ID required." });
      if (!Array.isArray(userIdsToRemove) || userIdsToRemove.length === 0)
        return cb({ success: false, error: "User IDs required." });
      if (userIdsToRemove.includes(userId))
        return cb({ success: false, error: "Cannot remove yourself." });

      try {
        const phpPath = `/user/channels/${channelId}/remove-users`;
        const payload = { user_ids: userIdsToRemove };
        const phpRemoveResponse = await makePhpRequest(
          "post",
          phpPath,
          userToken,
          payload,
          { "Content-Type": "application/json" }
        ); // Or appropriate method

        if (phpRemoveResponse?.success) {
          // --- Notify removed ONLINE users and make them leave ---
          userIdsToRemove.forEach((removedUserId) => {
            const userSocketsSet = connectedUsers.get(removedUserId);
            if (userSocketsSet?.size > 0) {
              userSocketsSet.forEach((targetSocketId) => {
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (targetSocket) {
                  targetSocket.emit("removedFromGroup", {
                    channelId,
                    message: `You were removed from the group.`,
                  });
                  targetSocket.leave(`channel_${channelId}`);
                }
              });
            }
          });
          // --- End Notify Removed ---

          // --- Fetch latest channel data AFTER removing ---
          let updatedChannelData;
          try {
            const phpGetResponse = await makePhpRequest(
              "get",
              `/user/channels/${channelId}`,
              userToken
            );
            if (phpGetResponse?.success && phpGetResponse?.data) {
              updatedChannelData = phpGetResponse.data;
            } else {
              // If fetching updated data fails, maybe the group is now empty or deleted?
              // Or maybe just an API error. We should still inform the requester of success,
              // but might not be able to broadcast the update reliably.
              console.warn(
                `${logPrefix} removeMembers: Failed to fetch updated channel data after removal (Chan ${channelId}). Group might be empty or API error.`
              );
              // Let's still send success back, but can't broadcast update. Client state might become slightly stale.
              return cb({ success: true }); // Indicate removal success even if fetch failed
            }
          } catch (fetchError) {
            console.error(
              `${logPrefix} removeMembers EXCEPTION fetching updated data (Chan ${channelId}):`,
              fetchError.message
            );
            // As above, return success but log the fetch error.
            return cb({ success: true });
          }
          // --- End Fetch ---

          // --- Broadcast 'channelUpdated' to REMAINING members ---
          // Ensure updatedChannelData exists before broadcasting
          if (updatedChannelData && updatedChannelData.id) {
            // Emit to the room (only remaining members are in it now)
            io.to(`channel_${channelId}`).emit("channelUpdated", {
              channelId,
              channelData: updatedChannelData,
            });
          } else {
            console.warn(
              `${logPrefix} removeMembers: Skipping broadcast as updatedChannelData is missing/invalid.`
            );
          }

          // Send success callback to the original requester
          // No channel data needed here, update comes via broadcast.
          cb({ success: true });
        } else {
          console.warn(
            `${logPrefix} removeMembers PHP Error (Chan ${channelId}): ${phpRemoveResponse?.message}`
          );
          cb({
            success: false,
            error: phpRemoveResponse?.message || "Failed to remove members.",
          });
        }
      } catch (error) {
        console.error(
          `${logPrefix} removeMembers EXCEPTION (Chan ${channelId}):`,
          error.response?.data || error.message
        );
        cb({
          success: false,
          error:
            error.response?.data?.message ||
            error.message ||
            "Could not remove members.",
        });
      }
    }
  );

  // --- Disconnect ---
  // --- Disconnect Handler (Revised for Online Status) ---
  socket.on("disconnect", (reason) => {
    if (connectedUsers.has(userId)) {
      const userSockets = connectedUsers.get(userId);
      userSockets.delete(socket.id);

      // If this was the LAST socket, update PHP status to offline
      if (userSockets.size === 0) {
        connectedUsers.delete(userId); // Remove user entry

        updatePhpOnlineStatus(userToken, false) // Use the token from the disconnecting socket
          .then((phpResponse) => {
            // Extract lastSeen from PHP response if available, otherwise use Node time
            const lastSeen =
              phpResponse?.data?.last_seen_at || new Date().toISOString();

            io.emit("userOffline", { userId, lastSeen }); // Broadcast with timestamp
          })
          .catch((error) => {
            console.error(
              `Failed to update PHP status to offline for ${userId}: ${error.message}`
            );
            // Broadcast userOffline optimistically with Node time as fallback
            const lastSeenFallback = new Date().toISOString();
            io.emit("userOffline", { userId, lastSeen: lastSeenFallback });
          });
      } else {
        console.log(
          `User ${userId} still has ${userSockets.size} active sockets.`
        );
      }
    } else {
      console.warn(
        `User ${userId} not found in connectedUsers map during disconnect.`
      );
    }

    // Clean up typing indicators etc. (Keep this)
    socket.rooms.forEach((room) => {
      if (room.startsWith("channel_") && room !== socket.id) {
        const channelId = room.substring("channel_".length);
        socket.to(room).emit(SOCKET_EVENTS.USER_STOPPED_TYPING, {
          channelId: parseInt(channelId, 10),
          userId,
        });
      }
    });
  });
};

module.exports = { registerSocketHandlers, getIoInstance };
