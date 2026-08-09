/**
 * Error raised when the worker configuration is missing or invalid.
 */
export class ConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/**
 * Error raised when the upstream object storage cannot be reached.
 */
export class UpstreamFetchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "UpstreamFetchError";
  }
}

/**
 * Error raised when an object path could escape its configured URL prefix.
 */
export class InvalidObjectPathError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "InvalidObjectPathError";
  }
}
