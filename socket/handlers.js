// node-server/socket/handlers.js
const { makePhpRequest, phpApiClient } = require("../services/phpApiService");
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
  MESSAGE_STATUS_UPDATE: "messageStatusUpdate",
  MARK_CHANNEL_READ: "markChannelRead",
  CHANNEL_READ_UPDATE: "channelReadUpdate",
};

// Store connected users { userId: socketId } - simplistic, refine for multiple connections per user if needed
const connectedUsers = new Map();

const registerSocketHandlers = (io, socket) => {
  const userId = socket.userData.id;
  const userToken = socket.token; // Use token associated with this specific socket

  const userName =
    socket.userData.profile?.first_name || socket.userData.username; // Get user's name

  // Store user connection
  connectedUsers.set(userId, socket.id);
  console.log(`User ${userId} associated with socket ${socket.id}`);
  // TODO: Emit presence update if needed

  if (!connectedUsers.has(userId)) {
    // Could store multiple socket IDs if needed
    connectedUsers.set(userId, socket.id);
    console.log(`User ${userId} mapped to socket ${socket.id}`);
  } else {
    // Handle cases where user might connect from multiple devices/tabs if needed
    console.log(
      `User ${userId} already has a mapped socket. Current socket: ${socket.id}`
    );
    // Update the map or store multiple IDs per user
    connectedUsers.set(userId, socket.id); // Simple override for now
  }

  // --- Channel Handling ---

  socket.on("getChannels", async (callback) => {
    console.log(`User ${userId} requested channels`);
    try {
      const response = await makePhpRequest("get", "/user/channels", userToken);
      if (response.success) {
        // Join rooms for each channel
        response.data.forEach((channel) => {
          socket.join(`channel_${channel.id}`);
          console.log(`User ${userId} joined room channel_${channel.id}`);
        });
        callback({ success: true, channels: response.data });
      } else {
        callback({
          success: false,
          error: response.message || "Failed to fetch channels",
        });
      }
    } catch (error) {
      console.error(
        `Error fetching channels for user ${userId}:`,
        error.message
      );
      callback({ success: false, error: error.message });
    }
  });

  // --- Message Handling ---

  socket.on(
    "getMessages",
    async ({ channelId, page = 1, limit = 20 }, callback) => {
      // --- ADD DETAILED LOGGING ---
      console.log(`\n--- Handling getMessages ---`);
      console.log(
        ` User ${userId} requested messages for channel ${channelId}, page ${page}`
      );
      console.log(
        ` getMessages: Using token: ${
          userToken ? userToken.substring(0, 10) + "..." : "MISSING!"
        }`
      ); // Verify token

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
      console.log(` getMessages: Calling PHP Path: ${phpPath}`); // Verify path and page param

      try {
        // Make the request using the authenticated user's token
        const response = await makePhpRequest("get", phpPath, userToken);

        // --- LOG THE RAW PHP RESPONSE ---
        console.log(
          ` getMessages: RAW PHP Response Success: ${response?.success}`
        );
        // Use JSON.stringify to see the full nested structure, including nulls
        console.log(
          ` getMessages: RAW PHP Response Data:`,
          JSON.stringify(response?.data, null, 2)
        );
        // Specifically log timestamps for a sample message if available
        if (response?.data?.messages && response.data.messages.length > 0) {
          const sampleMsg = response.data.messages[0];
          console.log(
            ` getMessages: Sample Msg ID ${sampleMsg.id} - delivered_at: ${sampleMsg.delivered_at}, read_at: ${sampleMsg.read_at}, sent_by_me: ${sampleMsg.message_sent_by_me}`
          );
        }
        // --- END RAW RESPONSE LOG ---

        if (response.success && response.data) {
          // Relay the exact data received from PHP
          callback({ success: true, messagesData: response.data });
          console.log(
            ` getMessages: Successfully relayed messagesData to client.`
          );
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
      console.log(`--- Finished getMessages ---\n`);
    }
  );

  socket.on(
    "sendMessage",
    async ({ channelId, message, attachment_id }, callback) => {
      console.log(`User ${userId} sending message to channel ${channelId}`);
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
          console.log(`Message broadcasted to channel_${channelId}`);
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
      console.log(
        `User ${userId} editing message ${messageId} in channel ${channelId}`
      );
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
    console.log(
      `User ${userId} deleting message ${messageId} from channel ${channelId}`
    );
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

  socket.on("markMessageRead", async ({ channelId, messageId }, callback) => {
    console.log(
      `User ${userId} marking message ${messageId} as read in channel ${channelId}`
    );
    try {
      // PHP expects PUT, but makePhpRequest can handle it or use axios directly
      const response = await makePhpRequest(
        "put",
        `/user/channels/${channelId}/messages/${messageId}/mark-as-read`,
        userToken
      );
      if (response.success) {
        // Notify relevant users (subtle: who needs this update? Potentially only the sender)
        // For simplicity broadcast for now, can be optimized
        io.to(`channel_${channelId}`).emit("messageStatusUpdate", {
          channelId,
          messageId,
          status: "read",
          read_at: new Date().toISOString() /* or get from PHP response */,
        });
        callback({ success: true });
      } else {
        callback({
          success: false,
          error: response.message || "Failed to mark as read",
        });
      }
    } catch (error) {
      console.error(
        `Error marking message ${messageId} as read:`,
        error.message
      );
      callback({ success: false, error: error.message });
    }
  });

  socket.on("markChannelRead", async ({ channelId }, callback) => {
    console.log(`User ${userId} marking channel ${channelId} as read`);
    if (!channelId)
      return callback({ success: false, error: "Channel ID required" });

    try {
      // Call the PHP endpoint: PUT /user/channels/:channelId/mark-as-read
      const response = await makePhpRequest(
        "put",
        `/user/channels/${channelId}/mark-as-read`,
        userToken
      );

      if (response.success) {
        // Notify the user's other sessions/devices (and potentially others in group?)
        // Emit to the specific user's room if implemented, or just broadcast to channel for simplicity
        io.to(`channel_${channelId}`).emit("channelMessagesRead", {
          channelId,
        });
        callback({ success: true });
      } else {
        callback({
          success: false,
          error: response.message || "PHP request failed",
        });
      }
    } catch (error) {
      console.error(
        `Error marking channel ${channelId} read for user ${userId}:`,
        error.message
      );
      callback({ success: false, error: error.message });
    }
  });

  // --- Clear Chat Handler ---
  socket.on("clearChannelChat", async ({ channelId }, callback) => {
    console.log(`User ${userId} clearing chat for channel ${channelId}`);
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
    console.log(`User ${userId} deleting channel ${channelId}`);
    if (!channelId)
      return callback({ success: false, error: "Channel ID required" });

    try {
      // Call PHP: DELETE /user/channels/:channelId
      const response = await makePhpRequest(
        "delete",
        `/user/channels/${channelId}`,
        userToken
      );

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
      { userIds, is_group, name = null, description = null /* other fields */ },
      callback
    ) => {
      const userId = socket.userData.id;
      const userToken = socket.token;

      console.log(
        `User ${userId} requested to create channel. is_group: ${is_group}, userIds: ${userIds}`
      );

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
        // Handle thumbnail_image if needed for group creation (requires file upload logic first)
        // if (thumbnail_image_file) { formData.append('thumbnail_image', ...); }

        const phpUrl = "/user/channels";
        console.log(
          ` createChannel: POSTing FormData to PHP URL: ${config.phpBackendUrl}${phpUrl}`
        );

        // Use the raw axios client for FormData
        const response = await phpApiClient.post(phpUrl, formData, {
          headers: {
            ...formData.getHeaders(), // Get boundary header from FormData
            Authorization: `Bearer ${userToken}`,
            "x-api-key": config.phpApiKey, // Ensure API key is included if added to client defaults
          },
        });

        console.log(` createChannel: PHP Response Status: ${response.status}`);
        console.log(` createChannel: PHP Response Data:`, response.data);

        // PHP might return success even if channel exists, giving back the existing channel data
        if (response.data && response.data.success) {
          const channelData = response.data.data; // Assuming PHP returns the channel data
          console.log(
            `Channel created/fetched successfully on PHP: ID ${channelData.id}`
          );

          // Make the creating user join the Socket.IO room for the new channel
          socket.join(`channel_${channelData.id}`);
          console.log(
            `User ${userId} joined new room channel_${channelData.id}`
          );

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
                console.log(
                  `User ${otherUserId} automatically joined room channel_${channelData.id}`
                );
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
    // console.log(`User ${userId} started typing in channel ${channelId}`); // Optional verbose log
    // Broadcast to everyone else in the room *except* the sender
    socket.to(`channel_${channelId}`).emit(SOCKET_EVENTS.USER_TYPING, {
      channelId,
      userId,
      userName, // Send name for display
    });
  });

  socket.on(SOCKET_EVENTS.STOP_TYPING, ({ channelId }) => {
    if (!channelId) return;
    // console.log(`User ${userId} stopped typing in channel ${channelId}`); // Optional verbose log
    // Broadcast to everyone else in the room *except* the sender
    socket.to(`channel_${channelId}`).emit(SOCKET_EVENTS.USER_STOPPED_TYPING, {
      channelId,
      userId,
    });
  });

  // --- Handle Delivery Acknowledgement from Client ---
  socket.on(
    SOCKET_EVENTS.MESSAGE_DELIVERED_ACK,
    async ({ channelId, messageId }) => {
      if (!channelId || !messageId) return;
      // --- Use the token FROM THIS SOCKET'S CONTEXT (userToken) ---
      // This 'userToken' belongs to the user whose client sent the ACK (the recipient)
      console.log(
        `Received delivery ACK from user ${userId} (socket ${socket.id}) for msg ${messageId}`
      );
      console.log(
        `  Using recipient's token: ${
          userToken ? userToken.substring(0, 10) + "..." : "MISSING!"
        }`
      );

      if (!userToken) {
        console.error(
          `Delivery ACK Error: Token missing for user ${userId} on socket ${socket.id}`
        );
        // Optionally emit an error back? Generally just log server-side.
        return;
      }

      try {
        const phpPath = `/user/channels/${channelId}/messages/${messageId}/mark-delivered-at`;
        // Make the PHP request using the recipient's token
        const response = await makePhpRequest("put", phpPath, userToken);

        if (response.success) {
          const deliveredAt =
            response.data?.delivered_at || new Date().toISOString();
          // Broadcast update
          io.to(`channel_${channelId}`).emit(
            SOCKET_EVENTS.MESSAGE_STATUS_UPDATE,
            {
              channelId,
              updates: [{ messageId, delivered_at: deliveredAt }],
            }
          );
        } else {
          // Log specific PHP denial if possible
          console.warn(
            `PHP denied marking msg ${messageId} delivered for user ${userId}: ${response.message}`
          );
        }
      } catch (error) {
        console.error(
          `Error in delivery ACK handling for msg ${messageId} by user ${userId}:`,
          error.message
        );
      }
    }
  );

  // --- Handle Read Acknowledgement from Client ---
  socket.on("messageReadAck", async ({ channelId, messageId }) => {
    // Correct event name
    if (!channelId || !messageId) return;
    // --- Use the token FROM THIS SOCKET'S CONTEXT (userToken) ---
    // This 'userToken' belongs to the user whose client sent the ACK (the recipient)
    console.log(
      `Received read ACK from user ${userId} (socket ${socket.id}) for msg ${messageId}`
    );
    console.log(
      `  Using recipient's token: ${
        userToken ? userToken.substring(0, 10) + "..." : "MISSING!"
      }`
    );

    if (!userToken) {
      console.error(
        `Read ACK Error: Token missing for user ${userId} on socket ${socket.id}`
      );
      return;
    }

    try {
      const phpPath = `/user/channels/${channelId}/messages/${messageId}/mark-as-read`;
      // Make the PHP request using the recipient's token
      const response = await makePhpRequest("put", phpPath, userToken);

      if (response.success) {
        const readAt = response.data?.read_at || new Date().toISOString();
        // Broadcast update
        io.to(`channel_${channelId}`).emit(
          SOCKET_EVENTS.MESSAGE_STATUS_UPDATE,
          {
            channelId,
            updates: [{ messageId, read_at: readAt }],
          }
        );
      } else {
        console.warn(
          `PHP denied marking msg ${messageId} read for user ${userId}: ${response.message}`
        );
      }
    } catch (error) {
      console.error(
        `Error in read ACK handling for msg ${messageId} by user ${userId}:`,
        error.message
      );
    }
  });

  // --- Mark Channel Read Handler ---
  socket.on(
    SOCKET_EVENTS.MARK_CHANNEL_READ,
    async ({ channelId }, callback) => {
      if (!channelId)
        return callback({ success: false, error: "Channel ID required" });
      // --- Use the token FROM THIS SOCKET'S CONTEXT (userToken) ---
      // This 'userToken' belongs to the user opening the channel
      console.log(
        `User ${userId} (socket ${socket.id}) marking channel ${channelId} as read`
      );
      console.log(
        `  Using user's token: ${
          userToken ? userToken.substring(0, 10) + "..." : "MISSING!"
        }`
      );

      if (!userToken) {
        console.error(
          `Mark Channel Read Error: Token missing for user ${userId} on socket ${socket.id}`
        );
        return callback({
          success: false,
          error: "Authentication token missing on server.",
        });
      }

      try {
        // Call PHP endpoint using the correct user's token
        const response = await makePhpRequest(
          "put",
          `/user/channels/${channelId}/mark-as-read`,
          userToken
        );

        if (response.success) {
          const readAt = response.data?.read_at || new Date().toISOString();
          const updatedMessageIds = response.data?.updated_ids || [];
          console.log(
            `Channel ${channelId} marked read by PHP for user ${userId}. Updated IDs: ${updatedMessageIds.length}`
          );

          // Broadcast CHANNEL_READ_UPDATE (for unread count)
          io.to(`channel_${channelId}`).emit(
            SOCKET_EVENTS.CHANNEL_READ_UPDATE,
            {
              channelId,
              readAt,
              updatedMessageIds,
              readerUserId: userId, // Optionally include who read it
            }
          );

          // Broadcast individual updates if IDs provided
          if (updatedMessageIds.length > 0) {
            const updates = updatedMessageIds.map((id) => ({
              messageId: id,
              read_at: readAt,
            }));
            io.to(`channel_${channelId}`).emit(
              SOCKET_EVENTS.MESSAGE_STATUS_UPDATE,
              {
                channelId,
                updates,
              }
            );
          }
          callback({ success: true });
        } else {
          console.warn(
            `PHP denied marking channel ${channelId} read for user ${userId}: ${response.message}`
          );
          callback({
            success: false,
            error: response.message || "PHP request failed",
          });
        }
      } catch (error) {
        console.error(
          `Error marking channel ${channelId} read for user ${userId}:`,
          error.message
        );
        callback({ success: false, error: error.message });
      }
    }
  );

  // Add handlers for mark delivered, channel operations (create, update, delete, clear, mark all read etc.) following the same pattern:
  // 1. Receive event from client
  // 2. Call makePhpRequest with appropriate method, path, token, and data
  // 3. Handle PHP response
  // 4. Emit broadcast event (e.g., 'channelUpdated', 'chatCleared') to relevant rooms/users if needed
  // 5. Send callback to the originating client

  // --- Disconnect ---

  socket.on("disconnect", (reason) => {
    console.log(
      `User ${userId} disconnected (${socket.id}). Reason: ${reason}`
    );
    if (connectedUsers.get(userId) === socket.id) {
      connectedUsers.delete(userId);
    }
    socket.rooms.forEach((room) => {
      if (room.startsWith("channel_")) {
        socket.leave(room);
        console.log(`Socket ${socket.id} left room ${room} on disconnect`);
      }
    });

    // Also emit stopTyping for all rooms the user was potentially typing in
    socket.rooms.forEach((room) => {
      if (room.startsWith("channel_") && room !== socket.id) {
        // Check it's a channel room, not the socket's own room
        const channelId = room.substring("channel_".length);
        console.log(
          `User ${userId} disconnected, emitting stopTyping for channel ${channelId}`
        );
        socket.to(room).emit(SOCKET_EVENTS.USER_STOPPED_TYPING, {
          channelId: parseInt(channelId, 10), // Ensure channelId is number if needed
          userId,
        });
      }
    });
    // TODO: Emit presence update if needed (user went offline)
    // Clean up any other user-specific resources if necessary
  });
};

module.exports = { registerSocketHandlers };
