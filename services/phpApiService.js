// node-server/services/phpApiService.js
const axios = require("axios");
const config = require("../config");

const phpApiClient = axios.create({
  baseURL: config.phpBackendUrl,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": config.phpApiKey || "",
  },
});

// Function to validate token via PHP backend
const validateToken = async (token) => {
  if (!token) throw new Error("Token is required");
  try {
    const response = await phpApiClient.get("/user", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.data && response.data.success) {
      return response.data.data; // Return user data
    } else {
      throw new Error(response.data?.message || "Invalid token");
    }
  } catch (error) {
    console.error(
      "PHP Token Validation Error:",
      error.response?.data || error.message
    );
    throw new Error(error.response?.data?.message || "Token validation failed");
  }
};

// Function to make generic requests to PHP backend
const makePhpRequest = async (
  method,
  path,
  token,
  data = null,
  customHeaders = {}
) => {
  if (!token) throw new Error("Token is required for PHP request");

  // Log the headers being sent for generic requests too
  const mergedHeaders = {
    // Axios automatically merges client defaults, then request-specific headers
    Authorization: `Bearer ${token}`,
    ...customHeaders, // Custom headers override defaults if keys match
  };
  console.log(
    `makePhpRequest (${method} ${path}): Sending Headers:`,
    JSON.stringify({
      ...phpApiClient.defaults.headers.common,
      ...mergedHeaders,
    })
  ); // Log merged headers

  try {
    const requestConfig = {
      method,
      url: path,
      headers: mergedHeaders, // Use the merged headers
      data: data,
    };
    const response = await phpApiClient(requestConfig);
    return response.data;
  } catch (error) {
    console.error(
      `PHP API Error (${method} ${path}):`,
      error.response?.data || error.message
    );
    throw new Error(
      error.response?.data?.message || `Failed to ${method} ${path}`
    );
  }
};

module.exports = {
  validateToken,
  makePhpRequest,
  phpApiClient, // Export client if needed for direct FormData use elsewhere
};
